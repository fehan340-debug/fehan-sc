// Storage adapter for the external GitHub Actions worker.
// GitHub Actions does not have Netlify's runtime context, so the worker uses
// Supabase directly. Netlify Functions continue to use @netlify/blobs in their
// own files; this adapter is intentionally independent of that runtime.

import { getStore as getNetlifyStore } from '@netlify/blobs';

const supabaseUrl = String(process.env.SUPABASE_URL || '').trim().replace(/\/$/, '');
const supabaseKey = String(process.env.SUPABASE_KEY || '').trim();
const table = String(process.env.SUPABASE_TABLE || 'scanner_worker_store').trim();

export function getNetlifyStoreSafe() {
  try {
    const siteID = String(process.env.NETLIFY_SITE_ID || '').trim();
    const token = String(process.env.NETLIFY_AUTH_TOKEN || '').trim();
    if (!siteID || !token) return null;
    return getNetlifyStore('nasdaq-scanner-data', { siteID, token });
  } catch (error) {
    console.warn('[worker/store] Netlify Blobs unavailable in this runtime:', error?.message || error);
    return null;
  }
}

function assertSupabase() {
  if (!supabaseUrl || !supabaseKey) {
    throw new Error('SUPABASE_URL و SUPABASE_KEY مطلوبان للـ GitHub Actions Worker.');
  }
}

async function request(path, options = {}) {
  assertSupabase();
  const response = await fetch(`${supabaseUrl}/rest/v1/${path}`, {
    ...options,
    headers: {
      apikey: supabaseKey,
      Authorization: `Bearer ${supabaseKey}`,
      'Content-Type': 'application/json',
      ...(options.headers || {})
    }
  });
  const body = await response.text();
  if (!response.ok) throw new Error(`Supabase HTTP ${response.status}: ${body.slice(0, 500)}`);
  return body ? JSON.parse(body) : null;
}

export const store = {
  async get(key, options = {}) {
    const rows = await request(`${table}?select=key,value&key=eq.${encodeURIComponent(String(key))}&limit=1`);
    return rows?.[0]?.value ?? null;
  },

  async setJSON(key, value) {
    await request(table, {
      method: 'POST',
      headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
      body: JSON.stringify({ key: String(key), value })
    });
  },

  async delete(key) {
    await request(`${table}?key=eq.${encodeURIComponent(String(key))}`, { method: 'DELETE' });
  }
};

// Kept only as a guarded helper for compatibility/debugging. The external
// worker must not depend on Netlify Blobs and never calls this automatically.
export function getStore() {
  return getNetlifyStoreSafe();
}
