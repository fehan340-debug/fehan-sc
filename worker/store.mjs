import { getStore } from '@netlify/blobs';

const siteID=String(process.env.NETLIFY_SITE_ID||'').trim();
const token=String(process.env.NETLIFY_AUTH_TOKEN||'').trim();
if(!siteID||!token)throw new Error('NETLIFY_SITE_ID و NETLIFY_AUTH_TOKEN مطلوبان للـ Background Worker.');

export const store=getStore('nasdaq-scanner-data',{siteID,token});
