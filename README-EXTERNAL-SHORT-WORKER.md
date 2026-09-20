# External Short / Free Float Workers

The project uses two independent GitHub Actions workers:

1. **Short worker** — starts from the Netlify minute-30 trigger and scrapes ChartExchange through ScrapingAnt. It waits for the next top of the hour before publishing the completed short snapshot.
2. **Daily Free Float worker** — is dispatched after the 09:30 America/New_York split-universe refresh and scrapes Finviz through ScrapingAnt with browser rendering disabled.

Required GitHub Actions secrets:

- `SCRAPINGANT_API_KEY`
- `SUPABASE_URL`
- `SUPABASE_KEY`

Both workers checkpoint per ticker using keys such as `scanner-short-record:TSLA`. Supabase uses the `key` primary key with `resolution=merge-duplicates`, so existing ticker records are updated rather than duplicated.
