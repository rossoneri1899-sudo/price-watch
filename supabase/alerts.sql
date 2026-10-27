-- Price Watch email alerts. Run once, after setup.sql:
-- SQL Editor -> New query -> paste all of this -> Run.

-- Who to email about each product. RLS is on with no policies, so the
-- public site can never read these addresses; only the check-prices
-- function (which uses the service key) and the functions below touch it.
create table if not exists public.product_alerts (
  product_id uuid not null references public.products(id) on delete cascade,
  email text not null check (email ~* '^[^@\s]+@[^@\s]+\.[^@\s]+$' and length(email) <= 254),
  created_at timestamptz not null default now(),
  primary key (product_id, email)
);
alter table public.product_alerts enable row level security;
revoke all on public.product_alerts from anon, authenticated;

-- add_product now takes an optional email for alerts.
drop function if exists public.add_product(text, text, text, numeric);
create or replace function public.add_product(code text, p_url text, p_name text default null, p_target numeric default null, p_email text default null)
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
  if nullif(trim(p_email), '') is not null then
    insert into public.product_alerts (product_id, email) values (new_id, lower(trim(p_email)))
    on conflict do nothing;
  end if;
  return new_id;
end $$;

-- Sign up for alerts on a product that's already on the list.
create or replace function public.add_alert(code text, p_id uuid, p_email text)
returns void language plpgsql security definer set search_path = '' as $$
begin
  if not private.code_ok(code) then
    raise exception 'wrong invite code' using errcode = '28000';
  end if;
  insert into public.product_alerts (product_id, email) values (p_id, lower(trim(p_email)))
  on conflict do nothing;
end $$;

grant execute on function public.add_product(text, text, text, numeric, text) to anon, authenticated;
grant execute on function public.add_alert(text, uuid, text) to anon, authenticated;
