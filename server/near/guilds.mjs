import { createHash } from 'node:crypto';
import { accountId, atomic, MAX_ATOMIC } from '../../src/economy/schema.js';

const assets = new Set(['alloy', 'core', 'catalyst']);
const roles = new Set(['owner', 'treasurer', 'member']);
function identifier(value) {
  if (typeof value !== 'string' || !/^[\w-]{1,128}$/.test(value)) throw new Error('Invalid guild identifier.');
  return value;
}
function quantity(value) {
  const amount = atomic(value);
  if (amount === 0n) throw new Error('Quantity must be positive.');
  return amount;
}
function assetId(value) {
  if (!assets.has(value)) throw new Error('Unsupported project asset.');
  return value;
}

// Trusted internal SQLite accounting. credit() accepts reconciled LOCAL balances
// from a caller that verifies provenance. No method here transfers chain assets.
export function createGuildProjects({ database, now = Date.now, catalogue = [] }) {
  const outputs = new Map(catalogue.map(entry => [entry.sku, structuredClone(entry)]));
  database.exec(`
    CREATE TABLE IF NOT EXISTS near_guilds (
      guild_id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, active INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS near_guild_members (
      guild_id TEXT NOT NULL, account_id TEXT NOT NULL, role TEXT NOT NULL, active INTEGER NOT NULL,
      PRIMARY KEY(guild_id,account_id));
    CREATE TABLE IF NOT EXISTS near_guild_balances (
      account_id TEXT NOT NULL, asset TEXT NOT NULL, amount TEXT NOT NULL,
      PRIMARY KEY(account_id,asset));
    CREATE TABLE IF NOT EXISTS near_guild_projects (
      project_id TEXT PRIMARY KEY, guild_id TEXT NOT NULL, terms TEXT NOT NULL,
      terms_hash TEXT NOT NULL, status TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS near_guild_contributions (
      operation_id TEXT PRIMARY KEY, project_id TEXT NOT NULL, account_id TEXT NOT NULL,
      asset TEXT NOT NULL, amount TEXT NOT NULL, status TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS near_guild_credits (
      receipt_id TEXT PRIMARY KEY, account_id TEXT NOT NULL, asset TEXT NOT NULL, amount TEXT NOT NULL);
  `);
  const get = (sql, ...args) => database.prepare(sql).get(...args);
  const run = (sql, ...args) => database.prepare(sql).run(...args);
  const all = (sql, ...args) => database.prepare(sql).all(...args);
  function transaction(action) {
    database.exec('SAVEPOINT guild_operation');
    try {
      const result = action();
      database.exec('RELEASE guild_operation');
      return result;
    } catch (error) {
      database.exec('ROLLBACK TO guild_operation');
      database.exec('RELEASE guild_operation');
      throw error;
    }
  }
  function balance(actor, asset) {
    return get('SELECT amount FROM near_guild_balances WHERE account_id=? AND asset=?',
      accountId(actor), assetId(asset))?.amount ?? '0';
  }
  function move(actor, asset, delta) {
    const amount = BigInt(balance(actor, asset)) + delta;
    if (amount < 0n) throw new Error('Insufficient local balance.');
    if (amount > MAX_ATOMIC) throw new Error('Local balance overflow.');
    run(`INSERT INTO near_guild_balances VALUES (?,?,?)
      ON CONFLICT(account_id,asset) DO UPDATE SET amount=excluded.amount`, actor, asset, String(amount));
  }
  function guild(id) {
    const row = get('SELECT * FROM near_guilds WHERE guild_id=?', identifier(id));
    if (!row) throw new Error('Unknown guild.');
    return row;
  }
  function member(actor, id, required = roles) {
    const row = get('SELECT * FROM near_guild_members WHERE guild_id=? AND account_id=?', id, accountId(actor));
    if (!row?.active || !required.has(row.role)) throw new Error('Guild role is not allowed.');
    return row;
  }
  const managers = new Set(['owner', 'treasurer']);
  function project(id) {
    const row = get('SELECT * FROM near_guild_projects WHERE project_id=?', identifier(id));
    if (!row) throw new Error('Unknown guild project.');
    return { projectId: row.project_id, guildId: row.guild_id, termsHash: row.terms_hash,
      ...JSON.parse(row.terms), status: row.status,
      contributions: all(`SELECT operation_id AS operationId, account_id AS accountId, asset, amount, status
        FROM near_guild_contributions WHERE project_id=? ORDER BY rowid`, id) };
  }
  function refund(id, status) {
    const p = project(id);
    if (p.status !== 'open') {
      if (p.status === status) return false;
      throw new Error('Committed or closed projects cannot refund.');
    }
    for (const contribution of p.contributions) {
      move(contribution.accountId, contribution.asset, BigInt(contribution.amount));
    }
    run("UPDATE near_guild_contributions SET status='refunded' WHERE project_id=?", id);
    run('UPDATE near_guild_projects SET status=? WHERE project_id=?', status, id);
    return true;
  }
  return {
    balance, project,
    credit({ receiptId, accountId: actor, asset, amount }) {
      identifier(receiptId); accountId(actor); assetId(asset); quantity(amount);
      return transaction(() => {
        const prior = get('SELECT * FROM near_guild_credits WHERE receipt_id=?', receiptId);
        if (prior) {
          if (prior.account_id !== actor || prior.asset !== asset || prior.amount !== amount) throw new Error('Conflicting credit receipt.');
          return false;
        }
        move(actor, asset, BigInt(amount));
        run('INSERT INTO near_guild_credits VALUES (?,?,?,?)', receiptId, actor, asset, amount);
        return true;
      });
    },
    create(actor, { guildId, treasurerId }) {
      identifier(guildId); accountId(actor); accountId(treasurerId);
      if (actor === treasurerId) throw new Error('Treasurer must be a separate account.');
      return transaction(() => {
        run('INSERT INTO near_guilds VALUES (?,?,1)', guildId, actor);
        run("INSERT INTO near_guild_members VALUES (?,?,'owner',1)", guildId, actor);
        run("INSERT INTO near_guild_members VALUES (?,?,'treasurer',0)", guildId, treasurerId);
      });
    },
    join(actor, guildId) {
      accountId(actor);
      if (!guild(guildId).active) throw new Error('Guild is closed.');
      // Join is the member's consent. This V1 local policy uses open membership.
      run(`INSERT INTO near_guild_members VALUES (?,?,'member',1)
        ON CONFLICT(guild_id,account_id) DO UPDATE SET active=1`, guildId, actor);
    },
    leave(actor, guildId) {
      if (member(actor, guildId).role === 'owner') throw new Error('Owner change requires configured multiple approvals.');
      run('UPDATE near_guild_members SET active=0 WHERE guild_id=? AND account_id=?', guildId, actor);
    },
    open(actor, { projectId, guildId, sku, targets, deadline }) {
      return transaction(() => {
        identifier(projectId);
        member(actor, guildId, managers);
        if (!guild(guildId).active) throw new Error('Guild is closed.');
        const output = outputs.get(sku);
        if (!output?.guildBound || output.transferable !== false || !Array.isArray(output.displayRoles) ||
            !output.displayRoles.length || output.displayRoles.some(role => !roles.has(role))) {
          throw new Error('Output must be a registered guild-bound SKU.');
        }
        if (!Number.isSafeInteger(deadline) || deadline <= now()) throw new Error('Invalid project deadline.');
        if (!targets || typeof targets !== 'object' || Array.isArray(targets) ||
            !Object.keys(targets).length || Object.keys(targets).length > assets.size) throw new Error('Invalid project targets.');
        const normalized = Object.fromEntries(Object.keys(targets).sort().map(asset => {
          assetId(asset); quantity(targets[asset]); return [asset, targets[asset]];
        }));
        const terms = JSON.stringify({ sku, targets: normalized, deadline, displayRoles: output.displayRoles,
          guildBound: true, transferable: false, refundPolicy: 'uncommitted-only' });
        const hash = createHash('sha256').update(terms).digest('hex');
        const prior = get('SELECT * FROM near_guild_projects WHERE project_id=?', projectId);
        if (prior) {
          if (prior.guild_id !== guildId || prior.terms_hash !== hash) throw new Error('Conflicting project terms.');
          return false;
        }
        run("INSERT INTO near_guild_projects VALUES (?,?,?,?,'open')", projectId, guildId, terms, hash);
        return true;
      });
    },
    contribute(actor, { projectId, operationId, asset, amount, termsHash }) {
      identifier(operationId); accountId(actor); assetId(asset); quantity(amount);
      return transaction(() => {
        const p = project(projectId);
        if (p.termsHash !== termsHash) throw new Error('Project terms must be accepted.');
        const prior = get('SELECT * FROM near_guild_contributions WHERE operation_id=?', operationId);
        if (prior) {
          if (prior.project_id !== projectId || prior.account_id !== actor || prior.asset !== asset || prior.amount !== amount) {
            throw new Error('Conflicting contribution operation.');
          }
          return false;
        }
        if (p.status !== 'open' || !guild(p.guildId).active) throw new Error('Project is not open.');
        member(actor, p.guildId);
        if (now() >= p.deadline) throw new Error('Project deadline passed.');
        const total = p.contributions.filter(row => row.asset === asset).reduce((sum,row) => sum + BigInt(row.amount), 0n);
        if (!p.targets[asset] || total + BigInt(amount) > BigInt(p.targets[asset])) throw new Error('Contribution exceeds project target.');
        move(actor, asset, -BigInt(amount));
        run("INSERT INTO near_guild_contributions VALUES (?,?,?,?,?,'escrow')", operationId, projectId, actor, asset, amount);
        return true;
      });
    },
    commit(actor, id) {
      return transaction(() => {
        const p = project(id);
        member(actor, p.guildId, managers);
        if (p.status === 'committed') return false;
        if (p.status !== 'open' || !guild(p.guildId).active) throw new Error('Project is not open.');
        if (now() >= p.deadline) throw new Error('Project deadline passed.');
        for (const [asset, target] of Object.entries(p.targets)) {
          const total = p.contributions.filter(row => row.asset === asset).reduce((sum,row) => sum + BigInt(row.amount), 0n);
          if (total !== BigInt(target)) throw new Error('Project target is not funded.');
        }
        run("UPDATE near_guild_contributions SET status='consumed' WHERE project_id=?", id);
        run("UPDATE near_guild_projects SET status='committed' WHERE project_id=?", id);
        return true;
      });
    },
    cancel(actor, id) {
      return transaction(() => { member(actor, project(id).guildId, managers); return refund(id, 'cancelled'); });
    },
    expire(id) {
      return transaction(() => {
        if (now() < project(id).deadline) throw new Error('Project deadline has not passed.');
        return refund(id, 'expired');
      });
    },
    canDisplay(actor, id) {
      const p = project(id);
      if (p.status !== 'committed' || !guild(p.guildId).active) return false;
      const row = get('SELECT * FROM near_guild_members WHERE guild_id=? AND account_id=?', p.guildId, accountId(actor));
      return !!row?.active && p.displayRoles.includes(row.role);
    },
    disband(actor, id) {
      return transaction(() => {
        const g = guild(id);
        if (g.owner_id !== accountId(actor)) throw new Error('Only the guild owner can disband.');
        if (!g.active) return false;
        for (const row of all('SELECT project_id,status FROM near_guild_projects WHERE guild_id=?', id)) {
          if (row.status === 'open') refund(row.project_id, 'cancelled');
          if (row.status === 'committed') run("UPDATE near_guild_projects SET status='archived' WHERE project_id=?", row.project_id);
        }
        run('UPDATE near_guilds SET active=0 WHERE guild_id=?', id);
        return true;
      });
    },
    transferOutput() { throw new Error('Guild-bound outputs cannot be sold or transferred.'); },
    changeOwner() { throw new Error('Owner change requires configured multiple approvals.'); },
  };
}
