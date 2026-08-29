-- Nagori Chai Point — Supabase setup
-- Run this file once in the Supabase SQL Editor.
-- The API stores each application record in JSONB so the historical order/menu
-- shape stays stable while PostgreSQL, RLS, Realtime and Storage handle persistence.

create extension if not exists pgcrypto;

create table if not exists public.app_settings (
  id text primary key,
  data jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

create table if not exists public.app_categories (
  id text primary key,
  data jsonb not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.app_tables (
  id text primary key,
  data jsonb not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.app_products (
  id text primary key,
  data jsonb not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.app_orders (
  id text primary key,
  data jsonb not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.app_feedbacks (
  id text primary key,
  data jsonb not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.app_waiter_calls (
  id text primary key,
  data jsonb not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.app_counters (
  id text primary key,
  value bigint not null default 1040
);

create or replace function public.next_order_number()
returns bigint
language plpgsql
security definer
set search_path = public
as $$
declare next_value bigint;
begin
  insert into public.app_counters (id, value)
  values ('orders', 1040)
  on conflict (id) do nothing;

  update public.app_counters
  set value = value + 1
  where id = 'orders'
  returning value into next_value;

  return next_value;
end;
$$;

revoke all on function public.next_order_number() from public;
grant execute on function public.next_order_number() to service_role;

-- Turn on RLS. The Express API uses the service-role key and is the only writer.
alter table public.app_settings enable row level security;
alter table public.app_categories enable row level security;
alter table public.app_tables enable row level security;
alter table public.app_products enable row level security;
alter table public.app_orders enable row level security;
alter table public.app_feedbacks enable row level security;
alter table public.app_waiter_calls enable row level security;
alter table public.app_counters enable row level security;

-- All customer reads and writes go through the Express API. This keeps settings
-- (including optional gateway tokens) and operational records out of anonymous
-- Supabase queries. The service-role API bypasses these policies.
drop policy if exists "public read app settings" on public.app_settings;
drop policy if exists "public read categories" on public.app_categories;
drop policy if exists "public read tables" on public.app_tables;
drop policy if exists "public read products" on public.app_products;

-- Authenticated Supabase users may receive Realtime updates for staff screens.
-- No anonymous policy is created for private operational data.
drop policy if exists "authenticated read orders" on public.app_orders;
create policy "authenticated read orders" on public.app_orders for select to authenticated using (true);
drop policy if exists "authenticated read feedbacks" on public.app_feedbacks;
create policy "authenticated read feedbacks" on public.app_feedbacks for select to authenticated using (true);
drop policy if exists "authenticated read waiter calls" on public.app_waiter_calls;
create policy "authenticated read waiter calls" on public.app_waiter_calls for select to authenticated using (true);

-- Realtime powers the admin kitchen screen after the tables are added to the publication.
do $$
begin
  alter publication supabase_realtime add table public.app_orders;
exception when duplicate_object then null;
end $$;
do $$
begin
  alter publication supabase_realtime add table public.app_waiter_calls;
exception when duplicate_object then null;
end $$;
do $$
begin
  alter publication supabase_realtime add table public.app_feedbacks;
exception when duplicate_object then null;
end $$;

-- Product photos are uploaded by the server into this bucket.
insert into storage.buckets (id, name, public)
values ('product-images', 'product-images', true)
on conflict (id) do update set public = true;

drop policy if exists "public view product images" on storage.objects;
create policy "public view product images" on storage.objects
for select using (bucket_id = 'product-images');

-- Optional: create the first admin in Authentication > Users, using the same
-- email and password configured in ADMIN_EMAIL / ADMIN_PASSWORD. No passwords
-- are stored in this application's database.
-- Example (run only if you prefer SQL over the dashboard):
-- select supabase_admin.create_user(...); -- use the Supabase dashboard instead.
