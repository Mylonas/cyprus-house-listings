# Data Sources

Ten sources as of v2.1.0. Each has a scraper in `scripts/scrape-<name>.mjs`; `scrape-all.mjs` runs them all, merges, deduplicates, and rebuilds the page. A source failing never fails the run — the merge degrades gracefully to whatever succeeded.

## Direct portals & auction sites

| Source | Scraper | Method | Status |
|---|---|---|---|
| Altamira Real Estate | `scrape-altamira.mjs` | Playwright — clicks "View more" (cookie overlay stripped first) | ✅ working |
| Bazaraki | `scrape-bazaraki.mjs` | Playwright — infinite scroll per district | ⛔ Cloudflare bot challenge |
| eAuction Cyprus | `scrape-eauction.mjs` | Playwright — paginated search, photo recovery via `GetAuctionImage` | ⛔ Imperva/Incapsula 403 on the search endpoint |
| Zyprus | `scrape-zyprus.mjs` | Playwright — paginated grid | ⛔ Cloudflare bot challenge |
| BidX1 | `scrape-bidx1.mjs` | Playwright — Cyprus/Houses filter | ✅ working |
| home.cy | `scrape-homecy.mjs` | Playwright — includes agency/developer name | ✅ working |
| FOX Realty | `scrape-foxrealty.mjs` | Playwright — one page per district | ✅ working |
| BuySellCyprus | `scrape-buysellcyprus.mjs` | Playwright — "recently listed" sample | ⛔ Cloudflare bot challenge |

## Resellers / aggregators (added in v2.1.0)

| Source | Scraper | Method | Status |
|---|---|---|---|
| Realting | `scrape-realting.mjs` | **Plain fetch** (no browser) — `?currency=EUR` forces uniform pricing; abbreviated `€1,09M` prices expanded; municipality→district map | ✅ working (~360 listings) |
| A Place in the Sun | `scrape-apits.mjs` | **Plain fetch** — path grammar `/property/cyprus/page/N` is server-rendered; EUR price read from the bracketed figure (`£644,206 [€740,000]`); schema.org microdata for title/locality | ✅ working (~250 listings) |

Both resellers list stock the direct portals also carry — which is why v2.1.0 added deduplication.

## Cross-source deduplication

Implemented in `scrape-all.mjs`. Two listings from different sources are the same property when:

1. **Bedrooms and asking price match exactly**, and
2. **Covered areas agree within 5%** — or, when either side doesn't publish an area, the **districts match**.

The survivor is chosen by source priority: direct portals and auction sites first (Bazaraki, Zyprus, Altamira, eAuction, BidX1, home.cy, FOX Realty, BuySellCyprus), resellers last (Realting, A Place in the Sun). Identical links are also collapsed. A typical refresh removes ~75 duplicates from ~950 scraped.

District names are normalized before dedup (Pafos→Paphos, Lefkosia→Nicosia, Germasogeia→Limassol, Ammochostos→Famagusta), so the page's district filter shows exactly the five canonical districts.

## The bot-blocked sources

Bazaraki, Zyprus, and BuySellCyprus serve a Cloudflare bot-verification interstitial ("Just a moment…") to automated browsers that does not auto-clear for headless Chromium; eAuction Cyprus returns an Imperva/Incapsula 403 on its search endpoint (its homepage still loads). We do not attempt to bypass bot protection. The scrapers stay in the rotation and resume automatically if the sites relax it. Practical effects while blocked:

- Total listings ~870 after dedup instead of ~1,100+
- No foreclosure-auction lots while eAuction is blocked (BidX1 still covers a small number of auction properties)
- `buildYear` is absent from the data (Zyprus and BuySellCyprus were its only providers), so the *Built after* filter matches nothing until they return

## Failure containment

- Each source has a **10-minute hard ceiling** (`SOURCE_TIMEOUT_MS` in `scrape-all.mjs`)
- `scrape-all.mjs` calls `process.exit(0)` when done — scrapers that die mid-navigation leak Chromium processes that would otherwise keep Node alive forever (the cause of the pre-v2.1.0 multi-hour hung CI runs)
- The workflow itself has `timeout-minutes: 45` as a backstop
- Navigation uses `domcontentloaded` + an explicit wait for the listing elements; `networkidle` no longer settles on these ad-heavy sites
