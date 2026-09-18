-- Run once in Supabase SQL Editor for the external GitHub Actions worker.
create table if not exists public.scanner_worker_store (
  key text primary key,
  value jsonb not null,
  updated_at timestamptz not null default now()
);

create or replace function public.set_scanner_worker_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists scanner_worker_store_updated_at on public.scanner_worker_store;
create trigger scanner_worker_store_updated_at
before update on public.scanner_worker_store
for each row execute function public.set_scanner_worker_updated_at();

-- The worker and Netlify hourly publisher use SUPABASE_KEY server-side from GitHub/Netlify Secrets.
-- Keep this table inaccessible to the public/client role.
revoke all on table public.scanner_worker_store from anon;
revoke all on table public.scanner_worker_store from authenticated;
grant all on table public.scanner_worker_store to service_role;

-- Each ticker is checkpointed immediately by the worker using keys like:
-- scanner-short-record:AAPL, scanner-short-record:TSLA, etc.
-- This keeps each completed ticker durable even if the 200-ticker run stops midway.
