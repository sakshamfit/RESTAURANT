-- Nagori Chai Point — plain PostgreSQL setup
-- Run this file once against your own PostgreSQL database, or let the app apply
-- it automatically on first start when DATABASE_URL is configured.
-- No Supabase, no Firebase, no cloud services required.

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
