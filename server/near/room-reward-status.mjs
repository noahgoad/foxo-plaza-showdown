/** Public room state contains player IDs, never wallet addresses or session tokens. */
export function roomRewardStatus(service, room) {
  return [...room.players.values()].map(player=>{
    const base={playerId:player.id,state:'practice',guaranteed:false,amountAtomic:'0'};
    if(!service || !player.nearWallet || !['boss','trials'].includes(room.config.mode))return base;
    const id=room.fixedReservations?.get(player.nearWallet);
    if(!id)return {...base,state:['lobby','queued','loading'].includes(room.phase)?'awaiting-reservation':'practice'};
    const reservation=service.get(id);
    if(!reservation)return base;
    if(reservation.status==='completed') {
      const settled=service.claims?.(player.nearWallet)?.entries?.some(entry=>entry.operationId===id);
      return {...base,state:settled?'settled':'settlement-pending',guaranteed:true,amountAtomic:reservation.amountAtomic};
    }
    if(reservation.guaranteed)return {...base,state:reservation.status,guaranteed:true,amountAtomic:reservation.amountAtomic};
    return {...base,state:['queued','pending','submitting'].includes(reservation.status)&&['queued','loading'].includes(room.phase)?'awaiting-reservation':'practice'};
  });
}
