# Price Watch

A price tracker that runs on GitHub. A GitHub Action checks every product once a day, saves prices to `data.json`, and emails you when a price drops or reaches your target. GitHub Pages shows the results at `https://<your-username>.github.io/price-watch/`.

## Add a product

Edit `products.json` (the GitHub app or website works on a phone):

```json
[
  { "url": "https://www.example-store.com/product/123", "name": "Noise-cancelling headphones", "target": 249.99 }
]
```

`name` and `target` are optional. Saving the file starts a price check straight away.

## Email alerts

In the repository, go to **Settings → Secrets and variables → Actions → New repository secret** and add:

| Secret | Value |
| --- | --- |
| `PRICE_WATCH_GMAIL` | The Gmail address that sends alerts |
| `PRICE_WATCH_APP_PASS` | A Gmail app password (Google Account → Security → App passwords) |
| `PRICE_WATCH_TO` | Optional: where alerts go. Defaults to the Gmail address |

## Schedule

The check runs at 13:00 UTC. To change it, edit the `cron` line in `.github/workflows/check-prices.yml`. To run it now, open **Actions → Check prices → Run workflow**.
