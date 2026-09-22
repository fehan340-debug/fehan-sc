# Scanner data pipeline

- **Massive** is the only source for stock prices and technical data. The technical/live-price lane refreshes every 5 minutes.
- **Stock Splits (rolling 100 days)** are rebuilt once per trading day at 09:30 America/New_York.
- **Free Float** is fetched only from Finviz through **ScrapingAnt** with `browser=false` (no JavaScript rendering) and is refreshed once per day with the split universe.
- **Short / Available Shares / Borrow Fee** are fetched only from ChartExchange through **ScrapingAnt**, with a 15-second timeout and `browser=false`. ChartExchange is never used as a Free Float source.
- **Short** starts at minute 30 of each hour and the completed snapshot is published at the next top of the hour.
- **IPO** data is prepared once daily by Massive and customer searches read only the saved snapshot; the customer path does not pull IPO rows directly from Supabase.
- **Customer scanner** responses are served through a 5-minute server/edge cache layer. Users do not query Supabase directly for scanner rows.

## Required server-side secrets

- `MASSIVE_API_KEY`
- `SCRAPINGANT_API_KEY`
- `SUPABASE_URL`
- `SUPABASE_KEY`
- `GITHUB_WORKER_TOKEN`
- `GITHUB_WORKER_REPO`
- `GITHUB_WORKER_REF` (optional; defaults to `main`)
- `GITHUB_WORKER_WORKFLOW` (optional; defaults to `.github/workflows/short-worker.yml`)
- `GITHUB_FLOAT_WORKER_WORKFLOW` (optional; defaults to `.github/workflows/daily-float-worker.yml`)

Do not commit real API keys to the repository or browser bundle.
