# Price Watch

A shared price tracker. Anyone with the link sees the prices; anyone with the invite code can add products, change targets or remove products right on the page. A GitHub Action checks prices, saves them to Supabase, and emails an alert when a price drops or reaches its target. GitHub Pages hosts the page at `https://<your-username>.github.io/price-watch/`.

## How it fits together

- `index.html`: the page. It reads products from Supabase with the project's publishable key, which can only read products and call the invite-code functions.
- `supabase/setup.sql`: the database table and the functions that check the invite code. The code is stored only as a hash.
- `scripts/check_prices.py`: runs every hour. It checks new products straight away and rechecks every product once a day.
- `data.json`: a backup copy of the products and prices, saved after each check.

## Secrets

In the repository, go to **Settings → Secrets and variables → Actions → New repository secret** and add:

| Secret | Value |
| --- | --- |
| `SUPABASE_URL` | Your project URL, like `https://abcd1234.supabase.co` |
| `SUPABASE_SECRET_KEY` | The project's secret key (Supabase → Project Settings → API Keys) |
| `PRICE_WATCH_GMAIL` | The Gmail address that sends alerts |
| `PRICE_WATCH_APP_PASS` | A Gmail app password (Google Account → Security → App passwords) |
| `PRICE_WATCH_TO` | Optional: where alerts go. Defaults to the Gmail address |

## Change the invite code

In the Supabase SQL Editor, run:

```sql
update private.settings set invite_code_hash = extensions.crypt('NEW-CODE', extensions.gen_salt('bf')) where id = 1;
```

People who saved the old code on their device are asked for the new one the next time they add something.
