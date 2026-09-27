name: Wyckoff Models

on:
  schedule:
    - cron: '5 * * * 1-5'
  workflow_dispatch:
    inputs:
      source:
        description: Trigger source
        required: false
        default: manual
      requested_at:
        description: Trigger timestamp
        required: false
        default: ""

concurrency:
  group: wyckoff-models
  cancel-in-progress: false

jobs:
  collect-and-analyze:
    runs-on: ubuntu-latest
    timeout-minutes: 30
    permissions:
      contents: read
    env:
      MASSIVE_API_KEY: ${{ secrets.MASSIVE_API_KEY }}
      SUPABASE_URL: ${{ secrets.SUPABASE_URL }}
      SUPABASE_KEY: ${{ secrets.SUPABASE_KEY }}
      SUPABASE_TABLE: scanner_worker_store
      SUPABASE_SCANNER_TABLE: scanner_worker_store
    steps:
      - name: Checkout
        uses: actions/checkout@v5

      - name: Setup Node
        uses: actions/setup-node@v5
        with:
          node-version: 24

      - name: Install dependencies
        run: npm install --no-audit --no-fund

      - name: Validate required secrets
        run: |
          test -n "$MASSIVE_API_KEY" || (echo "Missing MASSIVE_API_KEY" && exit 1)
          test -n "$SUPABASE_URL" || (echo "Missing SUPABASE_URL" && exit 1)
          test -n "$SUPABASE_KEY" || (echo "Missing SUPABASE_KEY" && exit 1)
          echo "Wyckoff collection secrets are present."

      - name: Collect daily model data and analyze Wyckoff
        env:
          WYCKOFF_FORCE: ${{ github.event_name == 'workflow_dispatch' && 'true' || 'false' }}
        run: |
          node --input-type=module <<'NODE'
          import { runWyckoff } from './netlify/functions/wyckoff-core.mjs';
          const r = await runWyckoff({force: process.env.WYCKOFF_FORCE === 'true'});
          console.log(JSON.stringify(r, null, 2));
          if (!r?.ok && !r?.skipped) process.exit(1);
          NODE
