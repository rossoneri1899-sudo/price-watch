"""Daily price check for Price Watch.

Reads products.json, fetches each product page, pulls the price from the
structured data stores publish for search engines (JSON-LD, microdata or
Open Graph tags), updates data.json, and emails an alert on drops.

Standard library only, so the GitHub Action needs no installs.
Email settings come from environment variables (GitHub secrets):
  PRICE_WATCH_GMAIL, PRICE_WATCH_APP_PASS, PRICE_WATCH_TO (optional)
  PRICE_WATCH_SITE (optional, the site link put at the end of emails)
"""
import gzip
import html
import json
import os
import re
import smtplib
import sys
import urllib.request
import zlib
from datetime import datetime, timezone
from email.message import EmailMessage
from pathlib import Path
from urllib.parse import urlparse

ROOT = Path(__file__).resolve().parent.parent
PRODUCTS = ROOT / "products.json"
DATA = ROOT / "data.json"
MAX_HISTORY = 365

HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/130.0 Safari/537.36",
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "en-US,en;q=0.9",
    "Accept-Encoding": "gzip, deflate",
}


def fetch(url: str) -> str:
    req = urllib.request.Request(url, headers=HEADERS)
    with urllib.request.urlopen(req, timeout=30) as resp:
        raw = resp.read()
        enc = resp.headers.get("Content-Encoding", "")
        if enc == "gzip":
            raw = gzip.decompress(raw)
        elif enc == "deflate":
            raw = zlib.decompress(raw)
        charset = resp.headers.get_content_charset() or "utf-8"
    return raw.decode(charset, errors="replace")


def to_number(value):
    if isinstance(value, (int, float)):
        return float(value)
    if not isinstance(value, str):
        return None
    s = re.sub(r"[^\d.,]", "", value)
    if not s:
        return None
    # "1.299,99" -> 1299.99 ; "1,299.99" -> 1299.99 ; "12,99" -> 12.99
    if "," in s and "." in s:
        s = s.replace(".", "").replace(",", ".") if s.rfind(",") > s.rfind(".") else s.replace(",", "")
    elif "," in s:
        head, _, tail = s.rpartition(",")
        s = head.replace(",", "") + "." + tail if len(tail) == 2 else s.replace(",", "")
    try:
        n = float(s)
    except ValueError:
        return None
    return n if n > 0 else None


def walk(node):
    """Yield every dict inside a JSON-LD tree."""
    if isinstance(node, dict):
        yield node
        for v in node.values():
            yield from walk(v)
    elif isinstance(node, list):
        for v in node:
            yield from walk(v)


def is_type(node, name):
    t = node.get("@type")
    return t == name or (isinstance(t, list) and name in t)


def from_offer(offer):
    price = to_number(offer.get("price") or offer.get("lowPrice"))
    if price is None and isinstance(offer.get("priceSpecification"), (dict, list)):
        for spec in walk(offer["priceSpecification"]):
            price = to_number(spec.get("price"))
            if price is not None:
                return price, spec.get("priceCurrency") or offer.get("priceCurrency")
    return price, offer.get("priceCurrency")


def parse_price(page: str):
    """Return (price, currency, name) or (None, None, None)."""
    for block in re.findall(r'<script[^>]+application/ld\+json[^>]*>(.*?)</script>', page, re.S | re.I):
        try:
            tree = json.loads(html.unescape(block.strip()))
        except json.JSONDecodeError:
            continue
        for node in walk(tree):
            if not is_type(node, "Product"):
                continue
            offers = node.get("offers")
            for offer in walk(offers) if offers else []:
                if is_type(offer, "Offer") or is_type(offer, "AggregateOffer") or "price" in offer:
                    price, cur = from_offer(offer)
                    if price is not None:
                        return price, cur, node.get("name")

    def meta(*names):
        for n in names:
            m = re.search(
                r'<meta[^>]+(?:property|itemprop|name)=["\']%s["\'][^>]*content=["\']([^"\']+)' % re.escape(n), page, re.I
            ) or re.search(
                r'<meta[^>]+content=["\']([^"\']+)["\'][^>]*(?:property|itemprop|name)=["\']%s["\']' % re.escape(n), page, re.I
            )
            if m:
                return html.unescape(m.group(1))
        return None

    price = to_number(meta("product:price:amount", "og:price:amount", "price"))
    if price is None:
        m = re.search(r'itemprop=["\']price["\'][^>]*content=["\']([^"\']+)', page, re.I)
        price = to_number(m.group(1)) if m else None
    if price is None:
        return None, None, None
    cur = meta("product:price:currency", "og:price:currency", "priceCurrency")
    return price, cur, meta("og:title")


def money(v, cur):
    if v is None:
        return "-"
    return f"{cur + ' ' if cur else ''}{v:,.2f}"


def send_email(alerts):
    sender = os.environ.get("PRICE_WATCH_GMAIL")
    password = os.environ.get("PRICE_WATCH_APP_PASS")
    to = os.environ.get("PRICE_WATCH_TO") or sender
    if not sender or not password:
        print("Email skipped: PRICE_WATCH_GMAIL / PRICE_WATCH_APP_PASS secrets are not set.")
        return
    lines = []
    for a in alerts:
        lines.append(a["name"])
        lines.append(f"  {money(a['old'], a['cur'])} -> {money(a['new'], a['cur'])}"
                     + (f"   (target {money(a['target'], a['cur'])})" if a["target"] is not None else ""))
        if a["reason"]:
            lines.append(f"  {a['reason']}")
        lines.append(f"  {a['url']}")
        lines.append("")
    site = os.environ.get("PRICE_WATCH_SITE")
    if site:
        lines.append(f"Tracker: {site}")
    msg = EmailMessage()
    msg["From"] = sender
    msg["To"] = to
    msg["Subject"] = f"Price Watch: {len(alerts)} price {'drop' if len(alerts) == 1 else 'drops'}"
    msg.set_content("\n".join(lines))
    with smtplib.SMTP_SSL("smtp.gmail.com", 465, timeout=30) as smtp:
        smtp.login(sender, password)
        smtp.send_message(msg)
    print(f"Alert email sent to {to}.")


def main() -> int:
    products = json.loads(PRODUCTS.read_text(encoding="utf-8"))
    data = json.loads(DATA.read_text(encoding="utf-8")) if DATA.exists() else {}
    old = data.get("products", {})
    now = datetime.now(timezone.utc)
    today = now.strftime("%Y-%m-%d")
    out, alerts = {}, []

    for p in products:
        url = (p.get("url") or "").strip()
        if not url.startswith(("http://", "https://")):
            continue
        rec = dict(old.get(url, {}))
        rec.update({
            "url": url,
            "store": urlparse(url).hostname.removeprefix("www."),
            "target": p.get("target"),
            "lastChecked": now.isoformat(timespec="seconds"),
        })
        rec.setdefault("history", [])
        try:
            price, cur, found_name = parse_price(fetch(url))
        except Exception as e:  # network errors, blocks, bad encodings
            print(f"FAIL {url}: {e}")
            price, cur, found_name = None, None, None

        rec["name"] = p.get("name") or rec.get("name") or (found_name or "")[:80] or rec["store"]
        if price is None:
            rec["status"] = "error"
            print(f"NO PRICE {url}")
        else:
            prev = rec.get("price")
            if isinstance(prev, (int, float)):
                rec["prevPrice"] = prev
            rec.update({"price": price, "currency": cur or rec.get("currency"), "status": "ok"})
            hist = rec["history"]
            if hist and hist[-1].get("d") == today:
                hist[-1]["p"] = price
            else:
                hist.append({"d": today, "p": price})
            rec["history"] = hist[-MAX_HISTORY:]
            print(f"OK {url}: {price} {cur or ''}")

            target = p.get("target")
            reasons = []
            if isinstance(prev, (int, float)) and price < prev:
                reasons.append("Price dropped")
            if isinstance(target, (int, float)) and price <= target and not (isinstance(prev, (int, float)) and prev <= target):
                reasons.append("Reached your target")
            if reasons:
                alerts.append({"name": rec["name"], "url": url, "old": prev, "new": price,
                               "cur": rec.get("currency"), "target": target, "reason": " and ".join(reasons)})
        out[url] = rec

    data = {"lastRun": now.isoformat(timespec="seconds"), "order": [p.get("url") for p in products if p.get("url") in out], "products": out}
    DATA.write_text(json.dumps(data, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")

    if alerts:
        try:
            send_email(alerts)
        except Exception as e:
            print(f"Email failed: {e}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
