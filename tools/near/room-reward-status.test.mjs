import test from 'node:test';
import assert from 'node:assert/strict';
import {roomRewardStatus} from '../../server/near/room-reward-status.mjs';
test('public reward states never expose wallets or promise an unconfirmed award',()=>{
  const player={id:'player',nearWallet:'alice.testnet',token:'secret'};
  const room={phase:'loading',config:{mode:'boss'},players:new Map([['player',player]]),fixedReservations:new Map([['alice.testnet','reservation']])};
  let reservation={status:'submitting',amountAtomic:'5',guaranteed:false};
  let settled=false;
  const service={get:()=>reservation,claims:()=>({entries:settled?[{operationId:'reservation'}]:[]})};
  assert.equal(roomRewardStatus(service,room)[0].state,'awaiting-reservation');
  assert.equal(JSON.stringify(roomRewardStatus(service,room)).includes('alice'),false);
  room.phase='playing';assert.equal(roomRewardStatus(service,room)[0].state,'practice');
  reservation={...reservation,status:'started',guaranteed:true};
  assert.equal(roomRewardStatus(service,room)[0].guaranteed,true);
  reservation.status='completed';assert.equal(roomRewardStatus(service,room)[0].state,'settlement-pending');
  settled=true;assert.equal(roomRewardStatus(service,room)[0].state,'settled');
  assert.equal(roomRewardStatus(null,room)[0].amountAtomic,'0');
});
