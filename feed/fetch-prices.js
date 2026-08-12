/**
 * Palworld TCG price feed
 * -----------------------
 * 1. Pulls the full card list (including parallel printings) from the
 *    palworldtcg.gg public API — no hand-maintained card list.
 * 2. Prices each card from live eBay listings (median, outlier-trimmed,
 *    one listing per seller).
 * 3. Writes prices.json, which the Shopify page reads.
 *
 * Run:  EBAY_APP_ID=xxx EBAY_CERT_ID=yyy node fetch-prices.js
 * Node 20+ (built-in fetch). No npm packages.
 *
 * Card data © Bushiroad / Pocketpair, supplied by palworldtcg.gg.
 * Prices are derived from public eBay listings (asking prices, not sold).
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
const CONFIDENT_LISTINGS = 5;                          // below this, flag provisional
const MAX_STALE_DAYS = 7;                              // drop a carried-over price after this
const REQUEST_DELAY_MS = 250;                          // stay under eBay's rate limit
const MAX_CARDS = Number(process.env.MAX_CARDS || 0);  // 0 = all

const DIR = __dirname;
const read = (f, fallback) => {
  try { return JSON.parse(fs.readFileSync(path.join(DIR, f), "utf8")); }
  catch { return fallback; }
};
const write = (f, obj) => fs.writeFileSync(path.join(DIR, f), JSON.stringify(obj, null, 2));
const sleep = ms => new Promise(r => setTimeout(r, ms));

/* Codes merged in from extra-cards.json, logged individually so a supplemental
   card that finds no listings is visible in the run output. */
const SUPPLEMENTAL = new Set();

if (!APP_ID || !CERT_ID) {
  console.error("Missing EBAY_APP_ID / EBAY_CERT_ID environment variables.");
  process.exit(1);
}

/* Words that mean the listing isn't a single raw card. Short entries are
   matched as whole words — as bare substrings, "tin" hits "listing" and "case"
   hits "showcase", silently discarding good listings. */
const BAD_WORDS = [
  "psa", "bgs", "cgc", "sgc", "graded", "slab",
  "lot", "bundle", "playset", "set of", "x4", "x10",
  "sealed", "booster box", "booster pack", "trial deck", "starter deck",
  "deck box", "tin", "case",
  "proxy", "custom", "fan made", "fan-made", "orica", "reprint",
  "sleeve", "binder", "toploader", "playmat"
];
const BAD_WORD_BOUNDED = new RegExp(
  "\\b(?:" + BAD_WORDS.map(w => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|") + ")\\b",
  "i"
);
const hasBadWord = t => BAD_WORD_BOUNDED.test(t);

const median = arr => {
  const s = [...arr].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

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
      const code = String(c.card_number).includes("-")
        ? String(c.card_number)
        : `${c.set_code}-${c.card_number}`;

      const rawImg = c.thumbnail_url || c.image_url;

      /* Search on the Pal/card name only — NOT the flavour subtitle.
         "Jormuntide Ignis – Savage Lava Dragon" as a query matches almost
         nothing, because sellers rarely type the subtitle and the en-dash
         breaks the match. That was starving every card of listings. */
      const shortName = (c.pal_name || String(c.name).split(/[–—-]/)[0]).trim();

      out.push({
        id: c.slug || code,
        code,
        name: c.name,
        shortName,
        set: c.set_code,
        rarity: c.rarity,
        type: c.card_type,
        img: rawImg ? new URL(rawImg, CARD_ORIGIN).href : null
      });
    }
    page++;
    await sleep(150);
  } while (page <= totalPages);

  /* Cards the API does not carry yet. Its database currently covers only BP01,
     TD01 and TD02 — the ESOUL gold Soul cards are absent entirely, which is why
     they never appeared in the feed no matter how the code matching changed.
     Both filenames are accepted: GitHub's "Create new file" does not add the
     .json extension, so the file is easily saved as plain "extra-cards". */
  const extra = read("extra-cards.json", null) || read("extra-cards", []);
  const known = new Set(out.map(c => c.code.toUpperCase()));
  let merged = 0;
  for (const e of extra) {
    if (!e.code || known.has(e.code.toUpperCase())) continue;
    out.push({
      id: e.id || e.code.toLowerCase(),
      code: e.code,
      name: e.name || e.code,
      shortName: (e.shortName || String(e.name || "").split(/[–—-]/)[0]).trim(),
      set: e.set || e.code.split("-")[0],
      rarity: e.rarity || "",
      type: e.type || "",
      img: e.img || null
    });
    known.add(e.code.toUpperCase());
    SUPPLEMENTAL.add(e.code.toUpperCase());
    merged++;
  }
  if (merged) console.log(`${merged} supplemental card(s) merged: ${[...SUPPLEMENTAL].join(", ")}`);
  else console.warn("No supplemental cards merged — is extra-cards.json present and valid JSON?");

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
 * Card codes read SETCODE-NNN, with a parallel rarity as an optional third
 * hyphenated part:
 *   BP01-001       base printing (its rarity may be C/U/R/RR — still a base)
 *   BP01-001-OSR   Over Super Rare parallel
 *   ESOUL-002-SSS  Gold Soul card
 * The set code is parsed generically rather than from a whitelist. A hardcoded
 * list of BP/TD/PR silently dropped every ESOUL printing — including the most
 * valuable cards in the game — because they simply failed to parse.
 * Sellers sometimes run the suffix on without the hyphen, so both are allowed.
 * RR is deliberately NOT a suffix: it is a base rarity, and treating it as one
 * would make a base listing that names its rarity fail to match its own card.
 */
const SUFFIXES = "sss|ssp|osr|sec|tsr|tsp|sr|sp";
const CODE_RE = new RegExp(`\\b([a-z]{2,6}\\d{0,2})\\s*-\\s*(\\d{1,3})(?:\\s*-?\\s*(${SUFFIXES}))?\\b`, "gi");

/* English reprints prefix the set code with E (BP01 / EBP01, SOUL / ESOUL).
   Normalise so the two never look like different sets. */
const normSet = s => s.toLowerCase().replace(/^e(?=[a-z])/, "");

function parseCodes(s) {
  const out = [];
  CODE_RE.lastIndex = 0;
  let m;
  while ((m = CODE_RE.exec(s)) !== null) {
    out.push({ set: normSet(m[1]), num: String(Number(m[2])), suffix: (m[3] || "").toUpperCase() });
  }
  return out;
}

function parseCode(s) {
  return parseCodes(s)[0] || null;
}

/* Parallel names sellers spell out instead of abbreviating. Applied only to
   genuinely base printings — a card whose own rarity IS a parallel naturally
   says so in its title. */
const SPELLED_PARALLEL = /(super special|over super|secret rare|ultra secret|gold card|parallel|full art|alt art|alternate art|holo foil)/i;

/* Rarities that are plain base printings. Anything else IS a parallel/special,
   so parallel wording in its title describes the card itself, not a mismatch. */
const BASE_RARITIES = ["", "C", "U", "R", "RR", "TD", "PR"];

function titleMatches(title, card) {
  const t = title.toLowerCase();
  if (!t.includes("palworld")) return false;
  if (hasBadWord(t)) return false;

  const key = card.shortName.toLowerCase().replace(/[^a-z ]/g, "").split(" ")[0];
  if (key && !t.includes(key)) return false;

  const want = parseCode(card.code);
  if (!want) return false;

  /* Require the exact card code in the listing title. Inferring identity from
     the Pal name alone is what let parallels contaminate base cards: one Pal
     has up to four printings spanning $2 to $1,600 with an identical name.
     Scan every code in the title, not just the first — titles often carry a
     set code and a card code. */
  const found = parseCodes(title);
  if (!found.length) return false;
  if (!found.some(g => g.set === want.set && g.num === want.num && g.suffix === want.suffix)) return false;

  /* The card's own rarity, whether it comes from the code suffix (BP01-025-SSP)
     or from the card record (ESOUL-002, whose SSS is not in the code at all).
     Without this, the Gold Soul card rejected 100% of its own listings: every
     one says "SSS", and the base-printing guard treated that as a mismatch. */
  const mine = (want.suffix || card.rarity || "").toLowerCase();
  const foreign = SUFFIXES.split("|").filter(s => s !== mine);

  // Reject a title naming a DIFFERENT printing's rarity. Whole tokens only,
  // since "SSP" contains "sp" as a substring.
  const tokens = t.match(/\b[a-z]{2,3}\b/g) || [];
  if (tokens.some(tok => foreign.includes(tok))) return false;

  // Spelled-out parallel wording only disqualifies genuinely base printings.
  const isBase = BASE_RARITIES.includes(String(card.rarity || "").toUpperCase());
  if (isBase && SPELLED_PARALLEL.test(t)) return false;

  return true;
}

async function search(token, q) {
  const url = "https://api.ebay.com/buy/browse/v1/item_summary/search"
    + `?q=${encodeURIComponent(q)}`
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

  if (res.status === 429) { console.warn("  rate limited — pausing 60s"); await sleep(60000); return search(token, q); }
  if (!res.ok) { console.warn(`  query "${q}": HTTP ${res.status}`); return []; }
  return (await res.json()).itemSummaries || [];
}

async function priceCard(token, card) {
  /* Two passes: code-qualified first (most precise), then name-only to pick up
     the many sellers who never type the card number. Merged and de-duplicated. */
  const seen = new Map();
  const collect = items => items.forEach(i => { if (i.itemId && !seen.has(i.itemId)) seen.set(i.itemId, i); });

  collect(await search(token, `Palworld ${card.shortName} ${card.code}`));
  if (seen.size < CONFIDENT_LISTINGS) {
    await sleep(REQUEST_DELAY_MS);
    collect(await search(token, `Palworld ${card.code}`));
  }

  const matched = [...seen.values()].filter(i => i.title && i.price && titleMatches(i.title, card));

  /* One listing per seller, cheapest kept. A single seller with 12 copies of
     the same card would otherwise dictate the median on their own. */
  const perSeller = new Map();
  for (const i of matched) {
    const seller = (i.seller && i.seller.username) || i.itemId;
    const p = Number(i.price.value);
    if (!(p >= 0.5 && p < 100000)) continue;
    if (!perSeller.has(seller) || p < perSeller.get(seller)) perSeller.set(seller, p);
  }

  let prices = [...perSeller.values()];
  if (prices.length < MIN_LISTINGS) return null;

  /* Representative photo for cards the card-art database has no image for
     (the ESOUL Soul cards). Prefer a mid-priced listing: the cheapest is often
     a bad photo or the wrong card, the dearest is often a staged shot. */
  const byPrice = matched
    .filter(i => i.image && i.image.imageUrl)
    .sort((a, b) => Number(a.price.value) - Number(b.price.value));
  const fallbackImg = byPrice.length
    ? byPrice[Math.floor(byPrice.length / 2)].image.imageUrl
    : null;

  /* Trim outliers twice around the running median. The old single pass used a
     0.2x–5x window — a 25x spread — which let $20 and $400 listings both sit
     inside the same "clean" set. */
  for (let pass = 0; pass < 2; pass++) {
    const mid = median(prices);
    const kept = prices.filter(p => p >= mid * 0.4 && p <= mid * 2.5);
    if (kept.length < MIN_LISTINGS) break;
    prices = kept;
  }
  if (prices.length < MIN_LISTINGS) return null;

  return {
    price: Math.round(median(prices) * 100) / 100,
    low: Math.round(Math.min(...prices) * 100) / 100,
    high: Math.round(Math.max(...prices) * 100) / 100,
    count: prices.length,
    sellers: perSeller.size,
    provisional: prices.length < CONFIDENT_LISTINGS,
    fallbackImg
  };
}

/* ---------- 3. Run ---------- */

(async function main() {
  console.log("Fetching card list…");
  const cards = await getCardList();
  console.log(`${cards.length} printings in the database.`);
  const sets = [...new Set(cards.map(c => c.set))].sort();
  console.log(`Sets: ${sets.join(", ")}`);

  const history = read("history.json", {});
  const previous = read("prices.json", { cards: [] });
  const prevById = Object.fromEntries((previous.cards || []).map(c => [c.id, c]));

  const list = MAX_CARDS ? cards.slice(0, MAX_CARDS) : cards;
  const token = await getToken();
  const today = new Date().toISOString().slice(0, 10);
  history[today] = history[today] || {};

  /* A price that moves more than this in a day is a matching artefact, not a
     market move — suppress the figure rather than publishing +2925%. */
  const MAX_PLAUSIBLE_MOVE = 200;

  /* Look back to the NEAREST recorded day within a window, not an exact date.
     If the job misses a day (GitHub cron is best-effort), an exact-date lookup
     finds nothing and every change column silently reads 0.00%. */
  const priceAgo = (id, days) => {
    for (let d = days; d <= days + 3; d++) {
      const key = new Date(Date.now() - d * 86400000).toISOString().slice(0, 10);
      if (history[key] && history[key][id] != null) return history[key][id];
    }
    return null;
  };
  const pctChange = (now, then) => {
    if (!then || then <= 0) return null;
    const pct = Math.round(((now - then) / then) * 1000) / 10;
    return Math.abs(pct) > MAX_PLAUSIBLE_MOVE ? null : pct;
  };

  const out = [];
  let priced = 0, carried = 0, dropped = 0, skipped = 0;

  for (const card of list) {
    let result = null, staleDays = 0;
    try { result = await priceCard(token, card); }
    catch (e) { console.warn(`  ${card.code}: ${e.message}`); }

    if (result) {
      /* Only FRESH prices go into history. Writing a carried-over price would
         make tomorrow compare a copy against its own copy — permanently 0%. */
      history[today][card.id] = result.price;
      priced++;
      if (SUPPLEMENTAL.has(card.code.toUpperCase())) {
        console.log(`  ${card.code} priced at $${result.price} from ${result.count} listing(s).`);
      }
    } else {
      const prev = prevById[card.id];
      staleDays = prev ? (prev.staleDays || 0) + 1 : 0;
      if (prev && staleDays <= MAX_STALE_DAYS) {
        result = {
          price: prev.price, low: prev.low, high: prev.high,
          count: prev.count, sellers: prev.sellers, provisional: true
        };
        carried++;
      } else {
        if (prev) dropped++; else skipped++;
        if (SUPPLEMENTAL.has(card.code.toUpperCase())) {
          console.warn(`  ${card.code}: no matching listings found.`);
        }
        await sleep(REQUEST_DELAY_MS);
        continue;
      }
    }

    out.push({
      id: card.id,
      name: card.name,
      set: card.set,
      num: card.code,
      rarity: card.rarity,
      type: card.type,
      img: card.img || result.fallbackImg || (prevById[card.id] || {}).img || null,
      price: result.price,
      low: result.low,
      high: result.high,
      count: result.count,
      sellers: result.sellers,
      provisional: !!result.provisional,
      stale: staleDays > 0,
      staleDays,
      d1: pctChange(result.price, priceAgo(card.id, 1)),
      d3: pctChange(result.price, priceAgo(card.id, 3)),
      d7: pctChange(result.price, priceAgo(card.id, 7)),
      d30: pctChange(result.price, priceAgo(card.id, 30))
    });

    await sleep(REQUEST_DELAY_MS);
  }

  // Keep 60 days of history so the file doesn't grow forever
  const cutoff = new Date(Date.now() - 60 * 86400000).toISOString().slice(0, 10);
  for (const day of Object.keys(history)) if (day < cutoff) delete history[day];

  write("prices.json", {
    updated: new Date().toISOString(),
    source: "Median of live eBay asking prices, one listing per seller. Card data from palworldtcg.gg.",
    freshCount: priced,
    cards: out
  });
  write("history.json", history);

  console.log(
    `Done. ${priced} freshly priced, ${carried} carried over, ` +
    `${dropped} dropped (stale >${MAX_STALE_DAYS}d), ${skipped} never had enough listings.`
  );
  if (priced === 0) {
    console.error("WARNING: nothing was priced fresh this run — check the eBay credentials and query matching.");
    process.exitCode = 1;
  }
})();
