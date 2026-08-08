/**
 * Palworld TCG price feed — pulls live eBay listings, writes prices.json
 *
 * Run:  EBAY_APP_ID=xxx EBAY_CERT_ID=yyy node fetch-prices.js
 * Node 20+ (uses built-in fetch). No npm packages needed.
 *
 * Reads   cards.json    — your master card list
 * Writes  prices.json   — what the Shopify page reads
 * Writes  history.json  — daily medians, so % change can be calculated
 */

const fs = require("fs");
const path = require("path");

const APP_ID = process.env.EBAY_APP_ID;
const CERT_ID = process.env.EBAY_CERT_ID;
const MARKETPLACE = process.env.EBAY_MARKETPLACE || "EBAY_US";
const CATEGORY_ID = "183454";           // CCG Individual Cards
const MIN_LISTINGS = 3;                 // fewer than this = no price published
const REQUEST_DELAY_MS = 250;           // stay well under eBay's rate limit
const MAX_CARDS = Number(process.env.MAX_CARDS || 0); // 0 = all

const DIR = __dirname;
const read = (f, fallback) => {
  try { return JSON.parse(fs.readFileSync(path.join(DIR, f), "utf8")); }
  catch { return fallback; }
};
const write = (f, obj) => fs.writeFileSync(path.join(DIR, f), JSON.stringify(obj, null, 2));

if (!APP_ID || !CERT_ID) {
  console.error("Missing EBAY_APP_ID / EBAY_CERT_ID environment variables.");
  process.exit(1);
}

/* Words that mean the listing isn't a single raw card */
const BAD_WORDS = [
  "psa", "bgs", "cgc", "sgc", "graded", "slab",
  "lot", "bundle", "playset", "set of", "x4", "x10",
  "sealed", "booster", "box", "pack", "tin", "collection box",
  "proxy", "custom", "fan made", "fan-made", "orica", "reprint",
  "sleeve", "binder", "toploader", "playmat", "deck box"
];

const sleep = ms => new Promise(r => setTimeout(r, ms));
const median = arr => {
  const s = [...arr].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const pctChange = (now, then) =>
  then && then > 0 ? Math.round(((now - then) / then) * 1000) / 10 : 0;

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
 * Does this listing title actually describe the card we asked for?
 *
 * Card codes read SETCODE-NNN with the parallel rarity appended:
 *   EBP01-001      base printing (RR here)
 *   EBP01-001OSR   Over Super Rare parallel
 *   EBP01-001SSP   Super Special Parallel
 * A base printing and its parallels are different cards worth very
 * different money, so the suffix has to match exactly.
 */
const CODE_RE = /\b(e?bp01|td01|td02|pr)\s*-\s*(\d{1,3})\s*(sss|ssp|osr|tsr|tsp|sr|sp|rr)?\b/i;

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

  const namePart = card.name.toLowerCase().replace(/[^a-z ]/g, "");
  if (namePart && !t.includes(namePart.split(" ")[0])) return false;

  const want = parseCode(card.code);
  const got = parseCode(title);

  if (got && want) {
    // Title states a code — set, number and parallel suffix must all agree
    return got.set === want.set && got.num === want.num && got.suffix === want.suffix;
  }

  // No code in the title. Only trust it for base printings, and only if the
  // title doesn't advertise some other parallel rarity.
  if (want && want.suffix) {
    return new RegExp(`\\b${want.suffix.toLowerCase()}\\b`).test(t);
  }
  return !/\b(sss|ssp|osr|tsr|tsp|sr|sp)\b/.test(t);
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
  if (!res.ok) { console.warn(`  ${card.id}: HTTP ${res.status}`); return null; }

  const data = await res.json();
  const items = data.itemSummaries || [];

  let prices = items
    .filter(i => i.title && i.price && titleMatches(i.title, card))
    .map(i => Number(i.price.value))
    .filter(p => p >= 0.5 && p < 100000);

  if (prices.length < MIN_LISTINGS) return null;

  // Trim outliers around a first-pass median, then re-median
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

(async function main() {
  const cards = read("cards.json", []);
  const history = read("history.json", {});
  const previous = read("prices.json", { cards: [] });
  const prevById = Object.fromEntries((previous.cards || []).map(c => [c.id, c]));

  const list = MAX_CARDS ? cards.slice(0, MAX_CARDS) : cards;
  console.log(`Pricing ${list.length} cards…`);

  const token = await getToken();
  const today = new Date().toISOString().slice(0, 10);
  history[today] = history[today] || {};

  const out = [];
  let priced = 0, stale = 0;

  for (const card of list) {
    let result = null;
    try { result = await priceCard(token, card); }
    catch (e) { console.warn(`  ${card.id}: ${e.message}`); }

    const prev = prevById[card.id];
    if (!result && prev) { result = { price: prev.price, low: prev.low, high: prev.high, count: prev.count }; stale++; }
    if (!result) { console.log(`  skip ${card.id} (too few listings)`); await sleep(REQUEST_DELAY_MS); continue; }

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

  write("prices.json", { updated: new Date().toISOString(), cards: out });
  write("history.json", history);
  console.log(`Done. ${priced} priced (${stale} carried over from last run), ${list.length - priced} skipped.`);
})();
