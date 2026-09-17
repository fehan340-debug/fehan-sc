import { currentUser } from '../../lib.js';
import { refreshIpoCache } from './scanner-ipo-core.mjs';
export default async function(request){
  const auth=await currentUser(request);
  if(!auth?.user?.admin||auth.maintenance||auth.blocked)return new Response('Unauthorized',{status:401});
  try{await refreshIpoCache();return new Response('ok',{status:202});}
  catch(e){console.error('manual IPO refresh failed',e);return new Response(String(e?.message||e),{status:500});}
}
export const config={background:true};
