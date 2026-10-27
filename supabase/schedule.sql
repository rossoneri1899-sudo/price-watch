-- Price Watch daily check at 9 AM Pacific. Run once, after alerts.sql:
-- SQL Editor -> New query -> paste all of this -> Run.
--
-- pg_cron runs on UTC and doesn't follow daylight saving, so the job calls
-- the function at 16:00 and 17:00 UTC and the function only runs the check
-- in whichever of those is 9 AM in Los Angeles (PDT or PST).

create extension if not exists pg_cron;
create extension if not exists pg_net;

-- A random token, kept in Supabase Vault, that lets the scheduler call the
-- function without the invite code. Nobody needs to copy it anywhere.
select vault.create_secret(encode(extensions.gen_random_bytes(32), 'hex'), 'price_watch_cron_token')
where not exists (select 1 from vault.secrets where name = 'price_watch_cron_token');

-- The function asks the database whether a token is right; only the
-- function's service key may call this.
create or replace function public.verify_cron_token(t text) returns boolean
language sql security definer set search_path = '' stable as $$
  select exists (
    select 1 from vault.decrypted_secrets
    where name = 'price_watch_cron_token' and decrypted_secret = t
  );
$$;
revoke execute on function public.verify_cron_token(text) from public, anon, authenticated;
grant execute on function public.verify_cron_token(text) to service_role;

-- (Re)create the daily job.
select cron.unschedule('price-watch-daily')
where exists (select 1 from cron.job where jobname = 'price-watch-daily');

select cron.schedule('price-watch-daily', '0 16,17 * * *', $job$
  select net.http_post(
    url := 'https://ewgfbmrxabeublisesev.supabase.co/functions/v1/check-prices',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'apikey', 'sb_publishable_dCjisFLm-9blSu06oD_Q8Q_NXNdOhSH',
      'x-cron-token', (select decrypted_secret from vault.decrypted_secrets where name = 'price_watch_cron_token')
    ),
    body := jsonb_build_object('cron', true, 'site', 'https://rossoneri1899-sudo.github.io/price-watch/'),
    timeout_milliseconds := 120000
  );
$job$);

-- To see recent runs:   select * from cron.job_run_details order by start_time desc limit 5;
-- To stop the daily check:   select cron.unschedule('price-watch-daily');
