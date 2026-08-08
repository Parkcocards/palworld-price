# Palworld card price feed

Two files, one job: pull every Palworld TCG card, price each one from live
eBay listings, write `prices.json` for the Shopify page to read.

## What runs

`fetch-prices.js`

1. Pulls the complete card list — every printing including SR / SP / OSR /
   SSP parallels — from the free `palworldtcg.gg` public API. Nothing is
   hand-maintained; when Bushiroad reveals BP02, it appears automatically.
2. For each card, searches eBay's Browse API, throws out graded slabs,
   sealed product, lots and proxies, and matches the exact card code so a
   base printing is never priced off its parallel.
3. Takes the **median** of what survives (min 3 listings, outliers trimmed).
4. Writes `prices.json` and appends today's medians to `history.json`, which
   is what makes the 24h / 7d / 30d change columns possible.

`.github/workflows/prices.yml` runs it every 4 hours and commits the result.

## Setup

Two repository secrets, from developer.ebay.com → Application Keys → Production:

| Secret | Value |
|---|---|
| `EBAY_APP_ID` | App ID (Client ID) |
| `EBAY_CERT_ID` | Cert ID (Client Secret) |

The keyset must be enabled — if it shows "disabled", turn on **Exempted from
Marketplace Account Deletion** in the eBay notification settings first.

## Feed URL

Once the workflow has run, the page reads:

```
https://cdn.jsdelivr.net/gh/USERNAME/REPO@main/feed/prices.json
```

## Knobs

| Env var | Default | What it does |
|---|---|---|
| `MAX_CARDS` | 0 (all) | Cap the run — useful for a quick test |
| `EBAY_MARKETPLACE` | `EBAY_US` | Marketplace, drives the currency |

## Expectations for the first run

- Every `d1`/`d7`/`d30` will read `+0.0%`. Change needs history; 24h change
  appears tomorrow, 30d change in a month.
- Plenty of cards will be skipped. A card needs 3+ genuine listings to get a
  price, and a set that launched recently won't have that everywhere.
- eBay allows 5,000 Browse calls/day. At ~250 printings and 6 runs a day
  you're using about 1,500 — comfortable headroom.

## Attribution

Card names, numbers and rarities come from palworldtcg.gg's public API.
Card data is © Bushiroad / Pocketpair. Prices are derived from public eBay
listings and are market research, not financial advice.
