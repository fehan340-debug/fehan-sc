// Storage adapter for the external GitHub Actions worker.
// Supabase is the worker's primary store. Netlify Blobs is used only as a
// read-through fallback for existing Netlify scanner data such as the
// approved short universe and the current central cache.

import { getStore as getNetlifyStore } from '@netlify/blobs';

const supabaseUrl = String(process.env.SUPABASE_URL || '').trim().replace(/\/$/, '');
const supabaseKey = String(process.env.SUPABASE_KEY || '').trim();
const table = String(process.env.SUPABASE_TABLE || 'scanner_worker_store').trim();

export function getNetlifyStoreSafe() {
  const siteID = String(process.env.NETLIFY_SITE_ID || '').trim();
  const token = String(process.env.NETLIFY_AUTH_TOKEN || '').trim();
  if (!siteID || !token) {
    console.warn('[worker/store] Netlify Blobs credentials are missing. NETLIFY_SITE_ID/NETLIFY_AUTH_TOKEN must be GitHub Actions secrets.');
    return null;
  }
  try {
    return getNetlifyStore('nasdaq-scanner-data', { siteID, token });
  } catch (error) {
    console.warn('[worker/store] Netlify Blobs initialization failed:', error?.message || error);
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
  if (!response.ok) {
    throw new Error(`Supabase HTTP ${response.status}: ${body.slice(0, 500)}`);
  }
  return body ? JSON.parse(body) : null;
}

export const store = {
  async get(key) {
    const rows = await request(
      `${table}?select=key,value&key=eq.${encodeURIComponent(String(key))}&limit=1`
    );
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

export function getStore() {
  return getNetlifyStoreSafe();
}
