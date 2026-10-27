-- Price Watch database setup.
-- Run once in Supabase: SQL Editor -> New query -> paste all of this -> Run.
-- Before running, replace CHANGE-ME below with your own invite code
-- (the code people type to add products; use 10+ characters).

create extension if not exists pgcrypto with schema extensions;

-- Products: anyone with the link can read; changes only go through the
-- functions below (which check the invite code) or the daily price check.
create table if not exists public.products (
  id uuid primary key default gen_random_uuid(),
  url text not null check (url ~* '^https?://' and length(url) <= 2000),
  name text check (length(name) <= 120),
  store text,
  target numeric check (target is null or target >= 0),
  price numeric,
  prev_price numeric,
  currency text,
  status text not null default 'pending',
  last_checked timestamptz,
  history jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now()
);

alter table public.products enable row level security;
drop policy if exists "Anyone can read products" on public.products;
create policy "Anyone can read products" on public.products
  for select to anon, authenticated using (true);

-- The invite code, stored only as a bcrypt hash, in a schema the site can't reach.
create schema if not exists private;
revoke all on schema private from public, anon, authenticated;

create table if not exists private.settings (
  id int primary key default 1 check (id = 1),
  invite_code_hash text not null
);

insert into private.settings (id, invite_code_hash)
values (1, extensions.crypt('CHANGE-ME', extensions.gen_salt('bf')))
on conflict (id) do update set invite_code_hash = excluded.invite_code_hash;

create or replace function private.code_ok(code text) returns boolean
language sql security definer set search_path = '' stable as $$
  select exists (
    select 1 from private.settings s
    where s.invite_code_hash = extensions.crypt(coalesce(code, ''), s.invite_code_hash)
  );
$$;

-- Functions the site calls.
create or replace function public.verify_code(code text) returns boolean
language sql security definer set search_path = '' stable as $$
  select private.code_ok(code);
$$;

create or replace function public.add_product(code text, p_url text, p_name text default null, p_target numeric default null)
returns uuid language plpgsql security definer set search_path = '' as $$
declare new_id uuid;
begin
  if not private.code_ok(code) then
    raise exception 'wrong invite code' using errcode = '28000';
  end if;
  if (select count(*) from public.products) >= 200 then
    raise exception 'the list is full (200 products)' using errcode = '54000';
  end if;
  insert into public.products (url, name, store, target)
  values (
    trim(p_url),
    nullif(trim(p_name), ''),
    regexp_replace(lower(substring(trim(p_url) from '^https?://([^/?#:]+)')), '^www\.', ''),
    p_target
  )
  returning id into new_id;
  return new_id;
end $$;

create or replace function public.set_target(code text, p_id uuid, p_target numeric)
returns void language plpgsql security definer set search_path = '' as $$
begin
  if not private.code_ok(code) then
    raise exception 'wrong invite code' using errcode = '28000';
  end if;
  update public.products set target = p_target where id = p_id;
end $$;

create or replace function public.remove_product(code text, p_id uuid)
returns void language plpgsql security definer set search_path = '' as $$
begin
  if not private.code_ok(code) then
    raise exception 'wrong invite code' using errcode = '28000';
  end if;
  delete from public.products where id = p_id;
end $$;

revoke execute on function private.code_ok(text) from public, anon, authenticated;
grant execute on function public.verify_code(text) to anon, authenticated;
grant execute on function public.add_product(text, text, text, numeric) to anon, authenticated;
grant execute on function public.set_target(text, uuid, numeric) to anon, authenticated;
grant execute on function public.remove_product(text, uuid) to anon, authenticated;

-- To change the invite code later, run just this line with the new code:
-- update private.settings set invite_code_hash = extensions.crypt('NEW-CODE', extensions.gen_salt('bf')) where id = 1;
