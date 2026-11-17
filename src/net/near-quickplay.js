// NEAR Quick Play uses the same authoritative room protocol as private rooms.
// A failed relay request never falls back to a local reward-looking match.
export const isNearWalletPlayer = identity => identity?.kind === 'wallet' && identity.config?.network === 'near-testnet';

export async function startNearQuickPlay(menus, options, createSession, isCurrent = () => true) {
  if (menus._nearQuickPending) return null;
  const identity=menus._identity,account=identity?.address,nearSession=identity?.nearSession,tokenId=identity?.nft?.tokenId;
  if (!isNearWalletPlayer(identity) || !account || !nearSession) throw Error('Sign in with Intear before starting a server-recorded match.');
  const guard=()=>{
    if(!isCurrent() || menus._identity!==identity || identity.address!==account || identity.nearSession!==nearSession ||
      identity.nft?.tokenId!==tokenId || !isNearWalletPlayer(identity)) throw Error('Wallet, selected Fox or screen changed. Start Quick Play again.');
  };
  menus._nearQuickPending=true;
  let session;
  try {
    guard();
    await menus.huntRoom?.leave();
    guard();
    session=createSession(menus);
    menus.huntRoom=session;
    await session.enter(undefined,{poll:false});
    guard();
    if(options.cup)await session.settings(options.mapId,options.time,options.mode,{cup:true,cupDay:options.cupDay});
    else await session.settings(options.mapId,options.time,options.mode);
    guard();
    await session.start();
    guard();
    if(session.room?.closed)throw Error(session.room.closed);
    if(options.cup&&!session.room?.config?.cup)throw Error('The relay did not assign a Cup round.');
    const hostedPractice = !options.cup && session.room?.hostedPractice === true && session.room?.phase === 'loading';
    const recorded = session.room?.nearAuthoritative === true && ['queued','loading'].includes(session.room.phase);
    if(!recorded && !hostedPractice) {
      throw Error('Server-recorded Quick Play is unavailable. Try again when the match server is ready.');
    }
    if (hostedPractice) menus.toast?.('Practice match · No on-chain rewards');
    void session.poll();
    return session;
  } catch(error) {
    await session?.leave();
    if(menus.huntRoom===session)menus.huntRoom=null;
    throw error;
  } finally { menus._nearQuickPending=false; }
}
