# Data Sources

Ten sources as of v2.1.0; the EstateBud agencies (Kazo, Cyprus Properties, NCH) were added post-v2.1.0, and DOM real estate, Pafilia and Giovani Homes in v2.2.0 — seventeen source scrapers in total. Each has a scraper in `scripts/scrape-<name>.mjs`; `scrape-all.mjs` runs them all, merges, deduplicates, and rebuilds the page. A source failing never fails the run — the merge degrades gracefully to whatever succeeded.

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

## EstateBud platform sources (added post-v2.1.0)

Several Cyprus agencies run the **EstateBud** listings platform, which comes in
two integration modes. Recognising the platform is the leverage: adding another
agency on the same mode is a one-line config, not a new scraper.

**URL/SPA mode** — `scrape-estatebud.mjs`. The site renders `estbd.io` card
images in the browser and paginates by clicking a numbered pager. The extractor
anchors on the `estbd.io` image + a detail link and is theme-agnostic (handles
`€70,000` and `3,995,000€` price formats, `m²`/`sqm` areas, slug-less
`/property/<id>` links, and labelled or positional bed/bath counts).

| Agency | Mode | Kind | Notes |
|---|---|---|---|
| Kazo Real Estate | URL/SPA | houses + plots | ~2.9k houses, ~0.8k plots; price-on-request items excluded |
| Cyprus Properties (cyprusproperties.com.cy) | URL/SPA | houses + plots | ~3.7k total; houses = `/properties` filtered to items with beds, plots = `?type=land` |

**WordPress admin-ajax mode** — `scrape-estatebud-wp.mjs`. The plugin delivers
cards from `/wp-admin/admin-ajax.php?action=estatebud_get_listing[_map]` behind a
WP nonce. We open the archive in a browser, capture the exact AJAX URL the page
fires (nonce included), then page by `offset`/`category`. Parses both the
`<strong>3</strong> Beds` and icon (`fa-bed`) card templates.

| Agency | Mode | Kind | Notes |
|---|---|---|---|
| Kadis Estates | WP admin-ajax | houses + plots | original hand-rolled scraper (`scrape-kadis.mjs`) |
| NCH Real Estate (nchrealestate.com) | WP admin-ajax | houses + plots | map-mode endpoint, icon card template |

## Portal & developer sources (added in v2.2.0)

A deep-scan pass over the remaining big portals and the island's major
property developers. Most developer sites (Leptos, Cybarco, Karma, Aristo,
Cyfield) market whole *projects* without per-unit prices, or hide results
behind JS-only search forms — not ingestible. Three were:

| Source | What it covers | Method | Notes |
|---|---|---|---|
| [DOM real estate](https://dom.com.cy) (`scrape-dom.mjs`) | Prime Property Group portal, ~4.5k houses all districts | Plain fetch — server-rendered Bitrix catalog, `/en/catalog/sale/type-house/?page=page-N`, 20 cards/page | schema.org Product cards: price meta, total/plot area, bedrooms, slider images. The earlier "403 to plain fetch" finding no longer holds — the catalog now serves plain fetches |
| [Pafilia](https://www.pafilia.com) (`scrape-pafilia.mjs`) | Developer — Paphos/Limassol new builds | WP REST — Houzez `property` CPT with full `property_meta` (price/size/beds/baths), `_embed` for photos | Posts are duplicated per language (en/de/pl/ru/vi/zh) and include Greece projects; filtered to English + Cyprus cities + sale-side |
| [Giovani Homes](https://www.giovani.com.cy) (`scrape-giovani.mjs`) | Developer — east coast (Protaras/Paralimni/Ayia Napa), Larnaca, Nicosia | WP REST list (WP Residence `estate_property` CPT) + per-property page fetch | WP Residence keeps price/size/beds in postmeta the REST API hides, so each property page's `listing_detail` blocks are parsed (8 in parallel); Shop category and rentals excluded |

## Source-discovery backlog (feasibility triage)

A sweep of Cyprus agency sites, ranked by ingest cost vs. unique value. Probed
for the `estbd.io`/`estatebud` fingerprint, anti-bot walls, and whether prices
render server-side.

| Candidate | Finding | Verdict |
|---|---|---|
| propertyincyprus.com (Blue Sky) | EstateBud URL-mode, but detail links `/…-for-sale/<area>/<id>` don't contain `/propert`; JS-rendered | **Feasible** — add once the URL-mode link matcher is generalised |
| dom.com.cy | ~~Returns 403 to plain fetch~~ — re-probed 2026-07: server-rendered catalog answers plain fetches | **Done** — live as `scrape-dom.mjs` (v2.2.0) |
| index.cy | Biggest marketplace (60k+/100 cos) but an **aggregator** — stock overlaps sources we already carry; Cloudflare | Low unique value; skip |
| myrealestatecyprus.com, properties-in-cyprus.com, galaxiaestates.com, cyprusestateagency.com | WordPress, prices in raw HTML, no EstateBud | Feasible as bespoke direct scrapers; medium effort each |
| land.cy, stephensons.eu, cypruspropertyfinder.com | Cloudflare / 403 wall (like home.cy) | Blocked; do not bypass |
| chapteroneproperties.com, bluesky-houses.com, cyprianstarestates.com, lextrusrealestate.com, cyprusemerald.com | Custom themes, no fingerprint | Feasible but low priority; bespoke each |

North-Cyprus portals (ncestateagents, busybees, propertync, landmark) are out of
scope — different market from the Republic-of-Cyprus focus of this aggregator.
