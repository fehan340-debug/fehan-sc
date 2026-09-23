import { currentUser } from '../../lib.js';
import { refreshUniverse } from './scanner-universe-core.mjs';
import { refreshIpoCache } from './scanner-ipo-core.mjs';

export default async function(request){
  const auth=await currentUser(request);
  if(!auth?.user?.admin||auth.maintenance||auth.blocked)return new Response('Unauthorized',{status:403});
  try{
    // Daily lane only: IPO + rolling 100-day Stock Split universe.
    // Massive technical/live-price data is deliberately NOT rebuilt here;
    // GitHub Actions owns that lane every five minutes.
    await refreshIpoCache();
    await refreshUniverse();
  }catch(e){console.error('manual daily refresh failed',e);}
  return new Response('',{status:202});
}
export const config={background:true};
