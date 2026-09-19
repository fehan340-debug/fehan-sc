-- Separates customer/account data from scanner market data.
-- Run once in Supabase SQL Editor AFTER taking a backup.

create table if not exists public.app_users_store (
  key text primary key,
  value jsonb not null,
  updated_at timestamptz not null default now()
);
create table if not exists public.app_sessions_store (
  key text primary key,
  value jsonb not null,
  updated_at timestamptz not null default now()
);
create table if not exists public.app_requests_store (
  key text primary key,
  value jsonb not null,
  updated_at timestamptz not null default now()
);
create table if not exists public.app_favorites_store (
  key text primary key,
  value jsonb not null,
  updated_at timestamptz not null default now()
);
create table if not exists public.app_user_settings_store (
  key text primary key,
  value jsonb not null,
  updated_at timestamptz not null default now()
);
create table if not exists public.app_site_settings_store (
  key text primary key,
  value jsonb not null,
  updated_at timestamptz not null default now()
);
create table if not exists public.app_attachments_store (
  key text primary key,
  value jsonb not null,
  updated_at timestamptz not null default now()
);

create or replace function public.set_app_store_updated_at()
returns trigger language plpgsql as $$
begin new.updated_at = now(); return new; end;
$$;

do $$
declare t text;
begin
  foreach t in array array[
    'app_users_store','app_sessions_store','app_requests_store','app_favorites_store',
    'app_user_settings_store','app_site_settings_store','app_attachments_store'
  ] loop
    execute format('drop trigger if exists %I_updated_at on public.%I', t, t);
    execute format('create trigger %I_updated_at before update on public.%I for each row execute function public.set_app_store_updated_at()', t, t);
  end loop;
end $$;

-- Preserve the existing records while moving them out of scanner_worker_store.
insert into public.app_users_store(key,value)
select key,value from public.scanner_worker_store where key='users'
on conflict (key) do update set value=excluded.value, updated_at=now();

insert into public.app_requests_store(key,value)
select key,value from public.scanner_worker_store where key='requests'
on conflict (key) do update set value=excluded.value, updated_at=now();

insert into public.app_site_settings_store(key,value)
select key,value from public.scanner_worker_store where key='site-settings'
on conflict (key) do update set value=excluded.value, updated_at=now();

insert into public.app_sessions_store(key,value)
select key,value from public.scanner_worker_store where key like 'session:%'
on conflict (key) do update set value=excluded.value, updated_at=now();

insert into public.app_favorites_store(key,value)
select key,value from public.scanner_worker_store where key like 'favorites:%'
on conflict (key) do update set value=excluded.value, updated_at=now();

insert into public.app_user_settings_store(key,value)
select key,value from public.scanner_worker_store where key like 'scanner-settings:%'
on conflict (key) do update set value=excluded.value, updated_at=now();

insert into public.app_attachments_store(key,value)
select key,value from public.scanner_worker_store
where key like 'support-attachment-%' or key like 'customer-attachment-%'
on conflict (key) do update set value=excluded.value, updated_at=now();

-- Lock every app table to service_role only. The browser never receives the service key.
do $$
declare t text;
begin
  foreach t in array array[
    'app_users_store','app_sessions_store','app_requests_store','app_favorites_store',
    'app_user_settings_store','app_site_settings_store','app_attachments_store'
  ] loop
    execute format('revoke all on table public.%I from anon', t);
    execute format('revoke all on table public.%I from authenticated', t);
    execute format('grant all on table public.%I to service_role', t);
  end loop;
end $$;

-- Remove customer/account records from the scanner store only after they have
-- been copied to their dedicated tables above. Scanner market data remains.
delete from public.scanner_worker_store
where key='users'
   or key='requests'
   or key='site-settings'
   or key like 'session:%'
   or key like 'favorites:%'
   or key like 'scanner-settings:%'
   or key like 'support-attachment-%'
   or key like 'customer-attachment-%';

-- Optional: create the separated tables' permissions for future migrations too.
revoke all on table public.scanner_worker_store from anon;
revoke all on table public.scanner_worker_store from authenticated;
grant all on table public.scanner_worker_store to service_role;
