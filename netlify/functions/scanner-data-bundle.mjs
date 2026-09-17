import { gzipSync, gunzipSync } from 'node:zlib';
import { getDataStore } from '../../lib.js';

const KEY='scanner-data-bundle-v1';

export async function writeDataBundle(payload){
  const store=getDataStore();
  const bytes=gzipSync(Buffer.from(JSON.stringify(payload),'utf8'),{level:9});
  await store.set(KEY,bytes,{contentType:'application/gzip'});
  await store.setJSON('scanner-data-bundle-meta-v1',{version:1,updatedAt:payload.updatedAt||new Date().toISOString(),compressedBytes:bytes.byteLength,records:Array.isArray(payload.records)?payload.records.length:0});
  return {compressedBytes:bytes.byteLength};
}

export async function readDataBundle(){
  const store=getDataStore();
  try{
    const buf=Buffer.from(await store.get(KEY,{type:'arrayBuffer',consistency:'strong'}));
    if(!buf.length)return null;
    const payload=JSON.parse(gunzipSync(buf).toString('utf8'));
    return payload;
  }catch{return null;}
}
