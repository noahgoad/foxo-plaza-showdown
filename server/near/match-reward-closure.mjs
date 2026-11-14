/** Called after the authority closes an unfinished match. Completed results remain payable. */
export function closeMatchRewards(service, room) {
  if (!service || room.finished || !room.fixedReservations) return;
  for (const [accountId, id] of room.fixedReservations) {
    const row = service.get(id);
    if (!row) continue;
    if (row.status === 'started') {
      service.closeIncomplete(id, { matchId: room.roundId, reason: 'abandoned' });
    } else if (['queued', 'pending', 'submitting', 'reserved'].includes(row.status)) {
      service.cancel(accountId, id);
    }
  }
}
