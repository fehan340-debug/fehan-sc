# External Short Worker — Supabase only

The short worker runs in GitHub Actions and uses Supabase as its only persistent store.

Required GitHub secrets:
- `SCRAPERAPI_KEY`
- `SUPABASE_URL`
- `SUPABASE_KEY` (service_role/secret key)

The worker reads `scanner-universe-v2` directly from Supabase, processes the approved tickers one by one, checkpoints each ticker, and writes the final short state back to Supabase. Netlify Blobs, `NETLIFY_SITE_ID`, and `NETLIFY_AUTH_TOKEN` are not required by this worker.

The short source remains ScraperAPI -> ChartExchange HTML.
