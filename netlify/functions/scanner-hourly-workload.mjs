import { asyncWorkloadFn } from '@netlify/async-workloads';
import { runHourlyBuild } from './scanner-hourly-core.mjs';

export default asyncWorkloadFn(async(event)=>{
  if(event.eventName==='scanner.hourly.start'){
    await runHourlyBuild({manual:Boolean(event.eventData?.manual),force:Boolean(event.eventData?.manual)});
  }
});

export const asyncWorkloadConfig={events:['scanner.hourly.start'],maxRetries:2};
