// Price Watch "Check now": a Supabase Edge Function.
// The site posts {code} here; if the invite code is right, this fetches every
// product page, reads the price from the structured data stores publish for
// search engines (JSON-LD, microdata or Open Graph tags), and saves it.
//
// When a price drops or reaches its target, it emails everyone signed up for
// that product (table product_alerts) through Gmail, using the Edge Function
// secrets GMAIL_ADDRESS and GMAIL_APP_PASSWORD.
//
// Deploy in the Supabase dashboard: Edge Functions -> Deploy a new function ->
// Via Editor, name it "check-prices", paste this file, and turn OFF
// "Verify JWT" (the function checks the invite code itself).

import nodemailer from "npm:nodemailer@6.9.16";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const MAX_HISTORY = 365;
const SKIP_IF_CHECKED_WITHIN_MS = 10 * 60 * 1000; // repeat taps don't refetch for 10 minutes
const CONCURRENCY = 4;

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "apikey, authorization, content-type, x-client-info",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const BROWSER_HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36",
  "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "Accept-Language": "en-US,en;q=0.9",
};

type Product = {
  id: string; url: string; name: string | null; store: string | null; target: number | null;
  price: number | null; currency: string | null; status: string; last_checked: string | null;
  history: { d: string; p: number }[];
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });
}

async function db(path: string, init: RequestInit = {}) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    ...init,
    headers: {
      apikey: SERVICE_KEY,
      Authorization: `Bearer ${SERVICE_KEY}`,
      "Content-Type": "application/json",
      Prefer: "return=minimal",
      ...(init.headers ?? {}),
    },
  });
  const text = await r.text();
  if (!r.ok) throw new Error(`database ${r.status}: ${text}`);
  return text ? JSON.parse(text) : null;
}

function toNumber(value: unknown): number | null {
  if (typeof value === "number") return value > 0 ? value : null;
  if (typeof value !== "string") return null;
  let s = value.replace(/[^\d.,]/g, "");
  if (!s) return null;
  // "1.299,99" -> 1299.99 ; "1,299.99" -> 1299.99 ; "12,99" -> 12.99
  if (s.includes(",") && s.includes(".")) {
    s = s.lastIndexOf(",") > s.lastIndexOf(".") ? s.replace(/\./g, "").replace(",", ".") : s.replace(/,/g, "");
  } else if (s.includes(",")) {
    const tail = s.slice(s.lastIndexOf(",") + 1);
    s = tail.length === 2 ? s.slice(0, s.lastIndexOf(",")).replace(/,/g, "") + "." + tail : s.replace(/,/g, "");
  }
  const n = Number(s);
  return isFinite(n) && n > 0 ? n : null;
}

function* walk(node: unknown): Generator<Record<string, unknown>> {
  if (Array.isArray(node)) for (const v of node) yield* walk(v);
  else if (node && typeof node === "object") {
    yield node as Record<string, unknown>;
    for (const v of Object.values(node)) yield* walk(v);
  }
}

const isType = (n: Record<string, unknown>, name: string) =>
  n["@type"] === name || (Array.isArray(n["@type"]) && (n["@type"] as unknown[]).includes(name));

const unescape = (s: string) =>
  s.replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");

function parsePrice(page: string): { price: number; currency: string | null; name: string | null } | null {
  const blocks = page.matchAll(/<script[^>]+application\/ld\+json[^>]*>([\s\S]*?)<\/script>/gi);
  for (const [, block] of blocks) {
    let tree: unknown;
    try { tree = JSON.parse(block.trim()); } catch { try { tree = JSON.parse(unescape(block.trim())); } catch { continue; } }
    for (const node of walk(tree)) {
      if (!isType(node, "Product") || !node.offers) continue;
      for (const offer of walk(node.offers)) {
        let price = toNumber(offer.price ?? offer.lowPrice);
        let currency = (offer.priceCurrency as string) ?? null;
        if (price == null && offer.priceSpecification) {
          for (const spec of walk(offer.priceSpecification)) {
            price = toNumber(spec.price);
            if (price != null) { currency = (spec.priceCurrency as string) ?? currency; break; }
          }
        }
        if (price != null) return { price, currency, name: typeof node.name === "string" ? node.name : null };
      }
    }
  }
  const meta = (...names: string[]) => {
    for (const n of names) {
      const esc = n.replace(/[.*+?^${}()|[\]\\:]/g, "\\$&");
      const m = page.match(new RegExp(`<meta[^>]+(?:property|itemprop|name)=["']${esc}["'][^>]*content=["']([^"']+)`, "i")) ??
        page.match(new RegExp(`<meta[^>]+content=["']([^"']+)["'][^>]*(?:property|itemprop|name)=["']${esc}["']`, "i"));
      if (m) return unescape(m[1]);
    }
    return null;
  };
  let price = toNumber(meta("product:price:amount", "og:price:amount", "price"));
  if (price == null) {
    const m = page.match(/itemprop=["']price["'][^>]*content=["']([^"']+)/i);
    price = m ? toNumber(m[1]) : null;
  }
  if (price == null) return null;
  return { price, currency: meta("product:price:currency", "og:price:currency", "priceCurrency"), name: meta("og:title") };
}

type Alert = { id: string; name: string; url: string; old: number | null; now: number; currency: string | null; target: number | null; reason: string };

function money(v: number | null, cur: string | null) {
  if (v == null) return "-";
  try { return new Intl.NumberFormat("en-US", { style: "currency", currency: cur || "USD" }).format(v); }
  catch { return `${cur ? cur + " " : ""}${v.toFixed(2)}`; }
}

async function sendAlerts(alerts: Alert[], siteUrl: string | null): Promise<number> {
  const user = Deno.env.get("GMAIL_ADDRESS"), pass = Deno.env.get("GMAIL_APP_PASSWORD");
  if (!alerts.length || !user || !pass) return 0;
  const ids = alerts.map((a) => a.id).join(",");
  const subs: { product_id: string; email: string }[] =
    await db(`product_alerts?select=product_id,email&product_id=in.(${ids})`, { headers: { Prefer: "" } });
  const byEmail = new Map<string, Alert[]>();
  for (const s of subs) {
    const a = alerts.find((x) => x.id === s.product_id);
    if (a) byEmail.set(s.email, [...(byEmail.get(s.email) ?? []), a]);
  }
  if (!byEmail.size) return 0;

  const mail = nodemailer.createTransport({ host: "smtp.gmail.com", port: 465, secure: true, auth: { user, pass } });
  let sent = 0;
  for (const [to, list] of byEmail) {
    const lines = list.flatMap((a) => [
      a.name,
      `  ${money(a.old, a.currency)} -> ${money(a.now, a.currency)}` + (a.target != null ? `   (target ${money(a.target, a.currency)})` : ""),
      `  ${a.reason}`,
      `  ${a.url}`,
      "",
    ]);
    if (siteUrl) lines.push(`Price Watch: ${siteUrl}`);
    lines.push("", "You're getting this because someone signed this address up for price alerts on Price Watch.");
    try {
      await mail.sendMail({
        from: `Price Watch <${user}>`, to,
        subject: list.length === 1 ? `Price Watch: ${list[0].name.slice(0, 60)} is now ${money(list[0].now, list[0].currency)}` : `Price Watch: ${list.length} price drops`,
        text: lines.join("\n"),
      });
      sent++;
    } catch (e) { console.error("email failed", to.replace(/^(.).*@/, "$1***@"), String(e)); }
  }
  return sent;
}

async function checkOne(p: Product, now: Date, alerts: Alert[]): Promise<"ok" | "error"> {
  let found: ReturnType<typeof parsePrice> = null;
  try {
    const r = await fetch(p.url, { headers: BROWSER_HEADERS, redirect: "follow", signal: AbortSignal.timeout(20000) });
    if (r.ok) found = parsePrice(await r.text());
  } catch { /* network error, timeout or block */ }

  const update: Record<string, unknown> = { last_checked: now.toISOString() };
  if (!found) {
    update.status = "error";
  } else {
    const today = now.toISOString().slice(0, 10);
    const hist = [...(p.history ?? [])];
    if (hist.length && hist[hist.length - 1].d === today) hist[hist.length - 1] = { d: today, p: found.price };
    else hist.push({ d: today, p: found.price });
    Object.assign(update, {
      price: found.price, currency: found.currency ?? p.currency, status: "ok", history: hist.slice(-MAX_HISTORY),
    });
    if (p.price != null) update.prev_price = p.price;
    if (!p.name && found.name) update.name = unescape(found.name).trim().slice(0, 120);

    const prev = p.price != null ? Number(p.price) : null;
    const target = p.target != null ? Number(p.target) : null;
    const reasons: string[] = [];
    if (prev != null && found.price < prev) reasons.push("Price dropped");
    if (target != null && found.price <= target && !(prev != null && prev <= target)) reasons.push("Reached the target price");
    if (reasons.length) {
      alerts.push({
        id: p.id, name: (update.name as string) || p.name || p.store || p.url, url: p.url, old: prev, now: found.price,
        currency: (update.currency as string) ?? null, target, reason: reasons.join(" and "),
      });
    }
  }
  await db(`products?id=eq.${p.id}`, { method: "PATCH", body: JSON.stringify(update) });
  return found ? "ok" : "error";
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ error: "Use POST" }, 405);

  let code = "", siteUrl: string | null = null;
  try {
    const body = await req.json();
    code = String(body.code ?? "");
    if (typeof body.site === "string" && /^https:\/\/[^\s]{1,200}$/.test(body.site)) siteUrl = body.site;
  } catch { /* empty body */ }
  const ok = await db("rpc/verify_code", { method: "POST", body: JSON.stringify({ code }), headers: { Prefer: "" } });
  if (ok !== true) return json({ error: "wrong invite code" }, 403);

  const rows: Product[] = await db("products?select=*&order=created_at.asc", { headers: { Prefer: "" } });
  const now = new Date();
  const due = rows.filter((p) => !p.last_checked || now.getTime() - Date.parse(p.last_checked) > SKIP_IF_CHECKED_WITHIN_MS);

  let found = 0, failed = 0;
  const alerts: Alert[] = [];
  for (let i = 0; i < due.length; i += CONCURRENCY) {
    const results = await Promise.all(due.slice(i, i + CONCURRENCY).map((p) => checkOne(p, now, alerts).catch(() => "error" as const)));
    for (const r of results) r === "ok" ? found++ : failed++;
  }
  let emailed = 0;
  try { emailed = await sendAlerts(alerts, siteUrl); } catch (e) { console.error("alerts failed", String(e)); }
  return json({
    total: rows.length, checked: due.length, found, failed, skipped: rows.length - due.length,
    drops: alerts.length, emailed, emailReady: !!(Deno.env.get("GMAIL_ADDRESS") && Deno.env.get("GMAIL_APP_PASSWORD")),
  });
});
