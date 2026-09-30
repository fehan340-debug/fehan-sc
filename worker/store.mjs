// Supabase-only storage adapter for the external GitHub Actions worker.
// No Netlify Blobs, site ID, or Netlify auth token is used anywhere in this worker.

const supabaseUrl = String(process.env.SUPABASE_URL || '').trim().replace(/\/+$/, '').replace(/\/rest\/v1$/i, '');
const supabaseKey = String(process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_KEY || '').trim();
const table = String(process.env.SUPABASE_TABLE || 'scanner_worker_store').trim();
const siteSettingsTable = String(process.env.SUPABASE_SITE_SETTINGS_TABLE || 'app_site_settings_store').trim();

function assertSupabase() {
  if (!supabaseUrl || !supabaseKey) {
    throw new Error('SUPABASE_URL و SUPABASE_SERVICE_ROLE_KEY (أو SUPABASE_KEY) مطلوبان للـ GitHub Actions Worker.');
  }
  if (!table) throw new Error('SUPABASE_TABLE غير صالح.');
  if (!siteSettingsTable) throw new Error('SUPABASE_SITE_SETTINGS_TABLE غير صالح.');
}

function encode(value) {
  return encodeURIComponent(String(value));
}

async function request(path, options = {}) {
  assertSupabase();
  let lastError = '';
  for (let attempt = 0; attempt < 4; attempt++) {
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
    if (response.ok) return body ? JSON.parse(body) : null;
    lastError = `Supabase HTTP ${response.status}: ${body.slice(0, 1000)}`;
    if ([408,429,500,502,503,504].includes(response.status) && attempt < 3) {
      await new Promise(r => setTimeout(r, 800 * (attempt + 1)));
      continue;
    }
    throw new Error(lastError);
  }
  throw new Error(lastError || 'Supabase request failed.');
}

export const store = {
  async get(key) {
    const rows = await request(
      `${table}?select=key,value&key=eq.${encode(key)}&limit=1`
    );
    return rows?.[0]?.value ?? null;
  },

  async setJSON(key, value) {
    await request(table, {
      method: 'POST',
      headers: {
        Prefer: 'resolution=merge-duplicates,return=minimal'
      },
      body: JSON.stringify({ key: String(key), value })
    });
    return value;
  },

  async delete(key) {
    await request(`${table}?key=eq.${encode(key)}`, { method: 'DELETE' });
  },

  async getSiteSettings() {
    const rows = await request(`${siteSettingsTable}?select=key,value&key=eq.site-settings&limit=1`);
    return rows?.[0]?.value ?? null;
  }
};

export function getSupabaseConfig() {
  assertSupabase();
  return { url: supabaseUrl, table };
}
