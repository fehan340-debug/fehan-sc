import { currentUser } from '../../lib.js';
import { readBorrowCache, consumeBorrowRefreshTrigger } from './scanner-borrow-core.mjs';
export { readBorrowCache };
export default async function(request){
  const auth=await currentUser(request);
  if(!auth?.user?.admin||auth.maintenance||auth.blocked)return new Response('Unauthorized',{status:401});
  const trigger=await consumeBorrowRefreshTrigger();
  return new Response(JSON.stringify({ok:true,externalWorker:true,pending:Boolean(trigger?.trigger)}),{status:200,headers:{'content-type':'application/json; charset=utf-8'}});
}
