import { createHash } from 'node:crypto';
import { matchExperience } from '../../src/game/chog-progression.js';
import { validateObjectiveResult } from '../../src/game/objective-rules.js';
import { accountId, nftIdentity } from '../../src/economy/schema.js';

export function resultsFromSimulation(room, snapshot, finishedAt, { careerModes = [] } = {}) {
  const mode = room.config.mode || 'hunt';
  const core = snapshot?.core;
  const result = core?.result;
  if (!room.nearAuthoritative || core?.phase !== 'finished' ||
      core.roundId !== room.roundId || result?.roundId !== room.roundId ||
      !Array.isArray(result.players)) throw new Error('Invalid authoritative match result');
  if (mode === 'control' || mode === 'trials') {
    validateObjectiveResult(result, room.config);
    if (result.winner !== core.winner) throw new Error('Objective winner mismatch');
  } else if (mode === 'boss' && typeof result.boss?.win !== 'boolean') {
    throw new Error('Missing Boss outcome');
  }
  const players = new Map(result.players.map(row => [row.id, row]));
  if (players.size !== result.players.length) throw new Error('Duplicate result actor');

  return room.roster.filter(player => player.nearWallet && !player.bot).map(player => {
    const row = players.get('hunt-' + player.nid);
    if (!row || typeof row.left !== 'boolean') throw new Error('Missing authoritative actor');
    const objective = mode === 'control' || mode === 'trials';
    if (objective && row.team !== player.team) throw new Error('Objective roster mismatch');
    const won = !row.left && (mode === 'boss' ? result.boss.win :
      objective ? result.winner === player.team : result.winner === row.id);
    const data = {
      matchId: room.roundId,
      accountId: accountId(player.nearWallet),
      nft: player.nftTokenId ? nftIdentity(player.nftContract, player.nftTokenId) : null,
      mode, won, left: row.left,
      xp: matchExperience(won, row.left, row.activity || {}).total,
      rulesVersion: careerModes.includes(mode) && ['boss','trials'].includes(mode) ?
        'near-authoritative-' + mode + '-1' : objective ? 'near-practice-objective-' + result.version : 'near-practice-1',
    };
    const resultHash = createHash('sha256').update(JSON.stringify(data)).digest('hex');
    return { ...data, resultHash, finishedAt };
  });
}
