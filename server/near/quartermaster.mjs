import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { QUARTERMASTER_DEFAULTS, deterministicQuartermasterProposal, quartermasterAtomic,
  quartermasterContext, validateQuartermasterProposal } from './quartermaster-policy.mjs';

const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const operation = value => typeof value === 'string' && /^[a-zA-Z0-9_.:-]{1,96}$/.test(value);

export function createQuartermaster({ database, config: suppliedConfig = {}, now = Date.now, provider, orders, verifyGuildFunding } = {}) {
  const config = Object.fromEntries(Object.entries(QUARTERMASTER_DEFAULTS)
    .map(([key, value]) => [key, suppliedConfig[key] ?? value]));
  if (!database) throw new Error('Quartermaster needs a durable database');
  database.exec(`CREATE TABLE IF NOT EXISTS near_quartermaster_orders (
    operation_id TEXT PRIMARY KEY, request_hash TEXT NOT NULL, funding_id TEXT NOT NULL,
    source TEXT NOT NULL, amount_atomic TEXT NOT NULL, status TEXT NOT NULL, payload TEXT NOT NULL,
    receipt TEXT
  )`);
  const find = database.prepare('SELECT * FROM near_quartermaster_orders WHERE operation_id = ?');
  const held = database.prepare('SELECT amount_atomic FROM near_quartermaster_orders WHERE funding_id = ? AND source = ?');
  const insert = database.prepare('INSERT INTO near_quartermaster_orders VALUES (?, ?, ?, ?, ?, ?, ?, NULL)');
  const update = database.prepare('UPDATE near_quartermaster_orders SET status = ?, receipt = ? WHERE operation_id = ?');
  const safeStatus = row => ({ status: row.status, operationId: row.operation_id,
    amountAtomic: row.amount_atomic, receipt: row.receipt ? JSON.parse(row.receipt) : null });

  async function propose(context) {
    if (!config.enabled) return { status: 'DISABLED', proposal: null };
    const input = quartermasterContext(context, config, now());
    const fallback = deterministicQuartermasterProposal(input, config, now());
    if (!fallback) return { status: 'NO_DEMAND_OR_BUDGET', proposal: null };
    let providerStatus = 'NOT_CONFIGURED';
    let proposal = fallback;
    const started = performance.now();
    if (provider) {
      if (!Number.isSafeInteger(config.providerTimeoutMs) || config.providerTimeoutMs < 1 || config.providerTimeoutMs > 60000) {
        throw new Error('Invalid provider timeout');
      }
      const controller = new AbortController();
      let timer;
      try {
        const response = await Promise.race([
          Promise.resolve().then(() => provider(structuredClone(input), { signal: controller.signal })),
          new Promise((_, reject) => {
            timer = setTimeout(() => { controller.abort(); reject(new Error('PROVIDER_TIMEOUT')); }, config.providerTimeoutMs);
          }),
        ]);
        proposal = validateQuartermasterProposal(response, input, config, now()).proposal;
        providerStatus = 'ACCEPTED';
      } catch (error) {
        providerStatus = error?.message === 'PROVIDER_TIMEOUT' ? 'TIMEOUT' : 'REJECTED';
      } finally {
        clearTimeout(timer);
      }
    }
    const checked = validateQuartermasterProposal(proposal, input, config, now());
    return { status: 'PROPOSED', providerStatus, proposal: checked.proposal,
      proposalHash: digest(checked.proposal), totalAtomic: checked.totalAtomic,
      latencyMs: Math.round(performance.now() - started), providerCostAtomic: null };
  }

  async function execute({ operationId, proposal, context, approval }) {
    if (!operation(operationId)) throw new Error('Invalid Quartermaster operation ID');
    // Validate the reviewed terms independently of an AI response or client amount.
    const existing = find.get(operationId);
    const saved = existing ? JSON.parse(existing.payload) : null;
    const authorizedAtMs = saved?.authorizedAtMs ?? now();
    const checked = validateQuartermasterProposal(proposal, saved?.context ?? context,
      saved?.config ?? config, authorizedAtMs);
    if (approval?.operationId !== operationId || approval?.fundingId !== context.fundingId ||
      approval?.source !== context.source || approval?.amountAtomic !== checked.totalAtomic ||
      approval?.proposalHash !== digest(checked.proposal)) throw new Error('Reviewed order approval required');
    const projectId = checked.context.projectId;
    if (checked.context.source === 'Guild') {
      if (context.projectId !== projectId || approval.projectId !== projectId) {
        throw new Error('Approved Guild project does not match funded order');
      }
      if (!existing) {
        const proof = await verifyGuildFunding?.({
          projectId, fundingId: checked.context.fundingId, blockHash: checked.context.blockHash,
          sku: checked.proposal.sku, quantity: checked.proposal.quantity,
          amountAtomic: checked.totalAtomic,
        });
        if (proof?.finalized !== true || proof.projectId !== projectId ||
            proof.fundingId !== checked.context.fundingId || proof.blockHash !== checked.context.blockHash ||
            quartermasterAtomic(proof.budgetAtomic) < quartermasterAtomic(checked.context.availableBudgetAtomic)) {
          throw new Error('Finalized Guild project funding is unavailable');
        }
      }
    }
    if (!orders || !['reserve', 'reconcile', 'publish'].every(name => typeof orders[name] === 'function')) {
      throw new Error('Funded orders adapter required');
    }
    const terms = { operationId, proposal: checked.proposal, totalAtomic: checked.totalAtomic,
      source: context.source, fundingId: context.fundingId, ...(projectId ? { projectId } : {}) };
    const requestHash = digest(terms);
    let row;
    let created = false;
    database.exec('BEGIN IMMEDIATE');
    try {
      row = find.get(operationId);
      if (row && row.request_hash !== requestHash) throw new Error('Quartermaster operation conflicts with recorded terms');
      if (!row) {
        const committed = held.all(context.fundingId, context.source)
          .reduce((sum, entry) => sum + quartermasterAtomic(entry.amount_atomic), 0n);
        // This allowance is cumulative for fundingId. A new top-up receives a new reviewed funding ID.
        if (committed + BigInt(checked.totalAtomic) > BigInt(checked.context.availableBudgetAtomic)) {
          throw new Error('Quartermaster funding allowance already committed');
        }
        insert.run(operationId, requestHash, context.fundingId, context.source,
          checked.totalAtomic, 'UNKNOWN', JSON.stringify({ terms, context: checked.context, config, authorizedAtMs }));
        row = find.get(operationId);
        created = true;
      }
      database.exec('COMMIT');
    } catch (error) {
      database.exec('ROLLBACK');
      throw error;
    }
    if (row.status === 'PUBLISHED') return safeStatus(row);
    let receipt;
    if (row.status === 'RESERVED') receipt = JSON.parse(row.receipt);
    else {
      try {
        receipt = created ? await orders.reserve(terms) : await orders.reconcile(terms);
      } catch {
        return safeStatus(find.get(operationId));
      }
      if (receipt?.status !== 'FINALIZED') return safeStatus(find.get(operationId));
      if (!operation(receipt.orderId) || !operation(receipt.receiptId) || !operation(receipt.blockHash) ||
        !Number.isSafeInteger(receipt.blockHeight) || receipt.blockHeight < checked.context.blockHeight ||
        receipt.amountAtomic !== checked.totalAtomic ||
        receipt.sku !== proposal.sku || receipt.quantity !== proposal.quantity || receipt.priceAtomic !== proposal.priceAtomic) {
        throw new Error('Finalized escrow receipt does not match approved order');
      }
      receipt = { status: 'FINALIZED', receiptId: receipt.receiptId, blockHash: receipt.blockHash,
        blockHeight: receipt.blockHeight, orderId: receipt.orderId, amountAtomic: receipt.amountAtomic,
        sku: receipt.sku, quantity: receipt.quantity, priceAtomic: receipt.priceAtomic };
      update.run('RESERVED', JSON.stringify(receipt), operationId);
    }
    // The adapter must make publication idempotent by operationId. A crash here replays publication only.
    await orders.publish({ ...terms, receipt });
    update.run('PUBLISHED', JSON.stringify(receipt), operationId);
    return safeStatus(find.get(operationId));
  }

  return { propose, execute, get: operationId => { const row = find.get(operationId); return row ? safeStatus(row) : null; } };
}
