/**
 * Palworld TCG price feed
 * -----------------------
 * 1. Pulls the full card list (including parallel printings) from the
 *    palworldtcg.gg public API — no hand-maintained card list.
 * 2. Prices each card from live eBay listings (median, outlier-trimmed).
 * 3. Writes prices.json, which the Shopify page reads.
 *
 * Run:  EBAY_APP_ID=xxx EBAY_CERT_ID=yyy node fetch-prices.js
 * Node 20+ (built-in fetch). No npm packages.
 *
 * Card data © Bushiroad / Pocketpair, supplied by palworldtcg.gg.
 * Prices are derived from public eBay listings.
 */

const fs = require("fs");
const path = require("path");

const APP_ID = process.env.EBAY_APP_ID;
const CERT_ID = process.env.EBAY_CERT_ID;
const MARKETPLACE = process.env.EBAY_MARKETPLACE || "EBAY_US";
const CARD_ORIGIN = "https://palworldtcg.gg";
const CARD_API = "https://palworldtcg.gg/api/v1/cards";
const CATEGORY_ID = "183454";                          // CCG Individual Cards
const MIN_LISTINGS = 3;                                // below this, publish nothing
const REQUEST_DELAY_MS = 250;                          // stay under eBay's rate limit
const MAX_CARDS = Number(process.env.MAX_CARDS || 0);  // 0 = all

const DIR = __dirname;
const read = (f, fallback) => {
  try { return JSON.parse(fs.readFileSync(path.join(DIR, f), "utf8")); }
  catch { return fallback; }
};
const write = (f, obj) => fs.writeFileSync(path.join(DIR, f), JSON.stringify(obj, null, 2));
const sleep = ms => new Promise(r => setTimeout(r, ms));

if (!APP_ID || !CERT_ID) {
  console.error("Missing EBAY_APP_ID / EBAY_CERT_ID environment variables.");
  process.exit(1);
}

/* Words that mean the listing isn't a single raw card */
const BAD_WORDS = [
  "psa", "bgs", "cgc", "sgc", "graded", "slab",
  "lot", "bundle", "playset", "set of", "x4", "x10",
  "sealed", "booster box", "booster pack", "trial deck", "tin",
  "proxy", "custom", "fan made", "fan-made", "orica", "reprint",
  "sleeve", "binder", "toploader", "playmat", "deck box"
];

const median = arr => {
  const s = [...arr].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const pctChange = (now, then) =>
  then && then > 0 ? Math.round(((now - then) / then) * 1000) / 10 : 0;

/* ---------- 1. Card list ---------- */

async function getCardList() {
  const out = [];
  let page = 1, totalPages = 1;

  do {
    const url = `${CARD_API}?per_page=100&include_parallels=true&page=${page}`;
    const res = await fetch(url, { headers: { Accept: "application/json" } });
    if (!res.ok) throw new Error(`Card API ${res.status}: ${await res.text()}`);
    const body = await res.json();

    totalPages = (body.meta && body.meta.total_pages) || 1;
    for (const c of body.data || []) {
      // card_number may arrive as "EBP01-001" or bare "001"
      const code = String(c.card_number).includes("-")
        ? String(c.card_number)
        : `${c.set_code}-${c.card_number}`;

      // The API returns a site-relative path; resolve it against its own origin.
      const rawImg = c.thumbnail_url || c.image_url;
      out.push({
        id: c.slug || code,
        code,
        name: c.name,
        palName: c.pal_name || null,
        set: c.set_code,
        rarity: c.rarity,
        type: c.card_type,
        img: rawImg ? new URL(rawImg, CARD_ORIGIN).href : null,
        query: `Palworld ${c.name} ${code}`
      });
    }
    page++;
    await sleep(150);
  } while (page <= totalPages);

  return out;
}

/* ---------- 2. eBay ---------- */

async function getToken() {
  const auth = Buffer.from(`${APP_ID}:${CERT_ID}`).toString("base64");
  const res = await fetch("https://api.ebay.com/identity/v1/oauth2/token", {
    method: "POST",
    headers: {
      Authorization: `Basic ${auth}`,
      "Content-Type": "application/x-www-form-urlencoded"
    },
    body: "grant_type=client_credentials&scope=" +
          encodeURIComponent("https://api.ebay.com/oauth/api_scope")
  });
  if (!res.ok) throw new Error(`Token failed ${res.status}: ${await res.text()}`);
  return (await res.json()).access_token;
}

/**
 * Card codes read SETCODE-NNN, with a parallel rarity as a THIRD hyphenated
 * part when the printing is a parallel:
 *   BP01-001       base printing (its rarity may be C/U/R/RR — still a base)
 *   BP01-001-OSR   Over Super Rare parallel
 *   BP01-025-SSP   Super Special Parallel
 * Sellers sometimes run the suffix on without the hyphen, so both are allowed.
 * RR is deliberately NOT a suffix: it is a base rarity, and treating it as one
 * would make a base listing that names its rarity fail to match its own card.
 */
const CODE_RE = /\b(e?bp\d{2}|td\d{2}|pr)\s*-\s*(\d{1,3})\s*(?:-\s*)?(sss|ssp|osr|sec|tsr|tsp|sr|sp)?\b/i;

function parseCode(s) {
  const m = s.match(CODE_RE);
  if (!m) return null;
  return {
    set: m[1].toLowerCase().replace(/^e/, ""),
    num: String(Number(m[2])),
    suffix: (m[3] || "").toUpperCase()
  };
}

function titleMatches(title, card) {
  const t = title.toLowerCase();
  if (!t.includes("palworld")) return false;
  if (BAD_WORDS.some(w => t.includes(w))) return false;

  const key = (card.palName || card.name).toLowerCase().replace(/[^a-z ]/g, "").split(" ")[0];
  if (key && !t.includes(key)) return false;

  const want = parseCode(card.code);
  const got = parseCode(title);

  if (got && want) {
    return got.set === want.set && got.num === want.num && got.suffix === want.suffix;
  }
  if (want && want.suffix) {
    return new RegExp(`\\b${want.suffix.toLowerCase()}\\b`).test(t);
  }
  return !/\b(sss|ssp|osr|sec|tsr|tsp|sr|sp)\b/.test(t);
}

async function priceCard(token, card) {
  const url = "https://api.ebay.com/buy/browse/v1/item_summary/search"
    + `?q=${encodeURIComponent(card.query)}`
    + `&category_ids=${CATEGORY_ID}`
    + "&limit=100"
    + "&filter=" + encodeURIComponent("buyingOptions:{FIXED_PRICE}");

  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      "X-EBAY-C-MARKETPLACE-ID": MARKETPLACE,
      "Content-Type": "application/json"
    }
  });

  if (res.status === 429) { console.warn("  rate limited — pausing 60s"); await sleep(60000); return priceCard(token, card); }
  if (!res.ok) { console.warn(`  ${card.code}: HTTP ${res.status}`); return null; }

  const items = (await res.json()).itemSummaries || [];

  let prices = items
    .filter(i => i.title && i.price && titleMatches(i.title, card))
    .map(i => Number(i.price.value))
    .filter(p => p >= 0.5 && p < 100000);

  if (prices.length < MIN_LISTINGS) return null;

  const rough = median(prices);
  prices = prices.filter(p => p >= rough * 0.2 && p <= rough * 5);
  if (prices.length < MIN_LISTINGS) return null;

  return {
    price: Math.round(median(prices) * 100) / 100,
    low: Math.round(Math.min(...prices) * 100) / 100,
    high: Math.round(Math.max(...prices) * 100) / 100,
    count: prices.length
  };
}

/* ---------- 3. Run ---------- */

(async function main() {
  console.log("Fetching card list…");
  const cards = await getCardList();
  console.log(`${cards.length} printings in the database.`);

  const history = read("history.json", {});
  const previous = read("prices.json", { cards: [] });
  const prevById = Object.fromEntries((previous.cards || []).map(c => [c.id, c]));

  const list = MAX_CARDS ? cards.slice(0, MAX_CARDS) : cards;
  const token = await getToken();
  const today = new Date().toISOString().slice(0, 10);
  history[today] = history[today] || {};

  const out = [];
  let priced = 0, stale = 0, skipped = 0;

  for (const card of list) {
    let result = null;
    try { result = await priceCard(token, card); }
    catch (e) { console.warn(`  ${card.code}: ${e.message}`); }

    const prev = prevById[card.id];
    if (!result && prev) { result = { price: prev.price, low: prev.low, high: prev.high, count: prev.count }; stale++; }
    if (!result) { skipped++; await sleep(REQUEST_DELAY_MS); continue; }

    history[today][card.id] = result.price;
    priced++;

    const ago = n => {
      const d = new Date(Date.now() - n * 86400000).toISOString().slice(0, 10);
      return history[d] && history[d][card.id];
    };

    out.push({
      id: card.id,
      name: card.name,
      set: card.set,
      num: card.code,
      rarity: card.rarity,
      type: card.type,
      img: card.img,
      price: result.price,
      low: result.low,
      high: result.high,
      count: result.count,
      d1: pctChange(result.price, ago(1)),
      d3: pctChange(result.price, ago(3)),
      d7: pctChange(result.price, ago(7)),
      d30: pctChange(result.price, ago(30))
    });

    await sleep(REQUEST_DELAY_MS);
  }

  // Keep 60 days of history so the file doesn't grow forever
  const cutoff = new Date(Date.now() - 60 * 86400000).toISOString().slice(0, 10);
  for (const day of Object.keys(history)) if (day < cutoff) delete history[day];

  write("prices.json", {
    updated: new Date().toISOString(),
    source: "Median of live eBay listings. Card data from palworldtcg.gg.",
    cards: out
  });
  write("history.json", history);

  console.log(`Done. ${priced} priced (${stale} carried over), ${skipped} skipped for too few listings.`);
})();
