import { createHash } from 'node:crypto';
import { accountId, nftIdentity } from '../../src/economy/schema.js';

export function careerRecordHash(record) {
  return createHash('sha256').update(JSON.stringify(Object.fromEntries(Object.entries(record).sort(([a],[b])=>a.localeCompare(b))))).digest('hex');
}
const id = (value, max) => typeof value === 'string' && value.length > 0 && value.length <= max && /^[a-zA-Z0-9_:./-]+$/.test(value);
const hash = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);

export function buildCareerRecord(result, domain, provenance) {
  if (domain.network !== 'near-testnet' || result.nft?.collectionId !== domain.collectionId) throw new Error('Career domain mismatch');
  if (!provenance || !['authoritative','legacy_migration','correction'].includes(provenance.source) || !id(provenance.sourceId,128)) throw new Error('Verified career provenance required');
  if (!id(result.matchId,128) || !id(result.rulesVersion,64) || result.rulesVersion.startsWith('near-practice-') ||
    !hash(result.resultHash) || !Number.isSafeInteger(result.finishedAt) || result.finishedAt <= 0 ||
    !Number.isInteger(result.xp) || result.xp < 0 || result.xp > 0xffffffff || typeof result.won !== 'boolean' ||
    result.left || !['boss','hunt','control','trials'].includes(result.mode)) throw new Error('Invalid career result');
  const nft = nftIdentity(domain.collectionId,result.nft.tokenId);
  const source = provenance.source;
  if (source !== 'authoritative' && !hash(provenance.provenanceHash)) throw new Error('Migration or correction provenance hash required');
  if(source === 'correction' && (!id(provenance.correctsEventId,96) || typeof provenance.correctionReason !== 'string' ||
    !provenance.correctionReason.trim() || provenance.correctionReason.length > 240 || /[\x00-\x1f]/.test(provenance.correctionReason))) throw new Error('Correction provenance required');
  if(provenance.traitManifestHash != null && !hash(provenance.traitManifestHash))throw new Error('Invalid trait manifest hash');
  const operation = `${domain.network}:${domain.contractId}:${nft.collectionId}:${nft.tokenId}:${source}:${provenance.sourceId}`;
  return {version:1,network:domain.network,contractId:accountId(domain.contractId),...nft,
    eventId:createHash('sha256').update(operation).digest('hex'),source,sourceId:provenance.sourceId,
    actorId:accountId(result.accountId),matchId:result.matchId,rulesVersion:result.rulesVersion,resultHash:result.resultHash,
    finishedAtMs:result.finishedAt,mode:result.mode,won:result.won,xp:result.xp,
    provenanceHash:source==='authoritative'?null:provenance.provenanceHash,
    correctsEventId:source==='correction'?provenance.correctsEventId:null,
    correctionReason:source==='correction'?provenance.correctionReason:null,
    traitManifestHash:provenance.traitManifestHash??null};
}
