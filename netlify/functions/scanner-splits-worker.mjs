import { currentUser } from '../../lib.js';
import { refreshUniverse } from './scanner-universe-core.mjs';
export { refreshUniverse };
export default async function(request){
  const auth=await currentUser(request);
  if(!auth?.user?.admin||auth.maintenance||auth.blocked)return new Response('Unauthorized',{status:401});
  try{await refreshUniverse();return new Response('ok',{status:202});}catch(e){return new Response(String(e?.message||e),{status:500});}
}
export const config={background:true};
