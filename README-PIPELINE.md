# Pipeline rebuild

This version replaces the previous cache/universe coupling with three independent lanes:

- `scanner-universe-v2`: canonical Reverse Split universe, rebuilt from Massive and retained on upstream failure.
- `scanner-borrow-v2`: independent IBKR/ChartExchange lane every 15 minutes. Missing borrow values remain null; no fake zero values are written.
- `scanner-cache-v1` / `scanner-cache-pointer-v2`: hourly customer cache. A complete version is written first, then the publication pointer is advanced. The borrow lane never writes the hourly customer cache.

Automatic full refresh remains scheduled at minute 50 of every hour. Manual full refresh uses a Background Function directly and does not call another function over HTTP.

Netlify setup requirement: Async Workloads must be enabled for the site/team because the minute-50 scheduler enqueues the long-running hourly workload. Background Functions are used for the manual path and the independent worker endpoints.


## Borrow / short data

The borrow worker now uses `SCRAPERAPI_KEY` as the primary source. It requests the NASDAQ ChartExchange borrow page through ScraperAPI as a direct HTML GET (`render=false`) and parses the initial HTML with Cheerio. If the normal direct request is challenged, it retries with `ultra_premium=true`; JavaScript rendering/headless-browser mode is never used. The existing ChartExchange API remains a per-symbol fallback. The key must be configured server-side in Netlify Environment Variables; never put it in the browser bundle.

## Exchange coverage correction
The authoritative Massive universe is now explicitly restricted to the three requested listed markets: XNAS (NASDAQ), XNYS (NYSE), and XASE (NYSE American). No borrow or ChartExchange request may silently default to NASDAQ when an exchange mapping is missing. ChartExchange borrow requests use the mapped exchange for each ticker, including direct HTML paths `nasdaq-*`, `nyse-*`, and `nyseamerican-*`. IPO filtering uses the selected exchange instead of hard-coding NASDAQ.


## Structural short-worker change

The short scraper is now externalized to GitHub Actions. Netlify Functions only create the pending trigger and dispatch `.github/workflows/short-worker.yml`; the scraper itself runs in `worker/short-worker.mjs` outside Netlify. Each ticker has a 4-second timeout and progress/results are persisted to Netlify Blobs after every ticker.


## Hourly central snapshot
The hourly scanner publishes the complete scanner snapshot (Massive split/technical/current data + Short/borrow/free-float + IPO records) to Supabase under key `scanner-central-cache-v1` after publishing the compressed Netlify serving bundle. Set `SUPABASE_URL` and a server-side `SUPABASE_KEY` in Netlify as well as GitHub Actions. The automatic schedule is Mon-Fri, with an America/New_York guard for 04:00-20:00; minute 40 runs the main refresh and minute 50 triggers the external short worker.
