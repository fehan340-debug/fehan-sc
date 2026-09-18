# External Short Background Worker

The short/borrow scraper no longer runs inside Netlify Functions. Netlify only writes a pending trigger and dispatches a GitHub Actions workflow. GitHub Actions runs the sequential scraper outside Netlify, one ticker at a time, with a hard 4-second timeout per ticker.

## GitHub repository

Put this project in a GitHub repository and keep these files in the same repository:
- `.github/workflows/short-worker.yml`
- `worker/store.mjs`
- `worker/short-worker.mjs`
- the existing `netlify/functions/chartexchange.mjs`
- `lib.js`
- `package.json`

## GitHub Actions secrets

Create these repository secrets:
- `NETLIFY_SITE_ID` = Netlify Project ID / Site ID
- `NETLIFY_AUTH_TOKEN` = Netlify Personal Access Token with access to the site's Blobs
- `SCRAPERAPI_KEY` = existing ScraperAPI key

The Netlify Blobs SDK supports accessing a site-wide store outside Netlify with `getStore(name, { siteID, token })`.

## Netlify environment variables

Add these variables to the Netlify site:
- `GITHUB_WORKER_TOKEN` = GitHub fine-grained token with **Actions: write** on the worker repository
- `GITHUB_WORKER_REPO` = `OWNER/REPOSITORY`
- `GITHUB_WORKER_WORKFLOW` = `.github/workflows/short-worker.yml` (optional; this is the default)
- `GITHUB_WORKER_REF` = `main` (optional; this is the default)

## Flow

1. Admin presses **تحديث الشورت الآن**.
2. Netlify writes `trigger_short_update = pending` and returns HTTP 202 immediately.
3. Netlify dispatches the GitHub Actions workflow.
4. GitHub worker reads `scanner-universe-v2` from Netlify Blobs.
5. Worker processes exactly one ticker at a time.
6. Each ticker has a 4-second AbortController timeout.
7. After every ticker, the worker immediately writes job progress, `scanner-borrow-v2`, and the matching row in `scanner-cache-v1`.
8. The admin page can be closed; the worker continues independently.
9. On completion the worker publishes `scanner-borrow-pointer-v2` and marks the trigger complete.
10. If the worker dies, the saved cursor is resumed on the next dispatch; stale jobs older than 5 minutes are recovered from the saved cursor.

No Netlify Function performs the 209-ticker scraping loop anymore.


## Customer/API isolation

The customer-facing `chartexchange?action=borrow|float` actions are cache-only. They no longer invoke ScraperAPI/ChartExchange. The actual scraper export is used only by `worker/short-worker.mjs`.


## Supabase storage for GitHub Actions worker
The external worker runs outside Netlify and uses Supabase REST directly through `worker/store.mjs`. Create the table with `SUPABASE-WORKER-MIGRATION.sql`, then add these GitHub Actions secrets:
- `SUPABASE_URL`
- `SUPABASE_KEY`
- `SCRAPERAPI_KEY`
- `NETLIFY_SITE_ID`
- `NETLIFY_AUTH_TOKEN`

`SUPABASE_TABLE` defaults to `scanner_worker_store`. The Netlify Blobs adapter is guarded and is not used by the external worker.
