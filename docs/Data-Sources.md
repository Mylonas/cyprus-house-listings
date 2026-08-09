# Data Sources

Ten sources as of v2.1.0; the EstateBud agencies (Kazo, Cyprus Properties, NCH) were added post-v2.1.0, and DOM real estate, Pafilia and Giovani Homes in v2.2.0 — seventeen source scrapers in total. Each has a scraper in `scripts/scrape-<name>.mjs`; `scrape-all.mjs` runs them all, merges, deduplicates, and rebuilds the page. A source failing never fails the run — the merge degrades gracefully to whatever succeeded.

## Direct portals & auction sites

| Source | Scraper | Method | Status |
|---|---|---|---|
| Altamira Real Estate | `scrape-altamira.mjs` | Playwright — clicks "View more" (cookie overlay stripped first) | ✅ working |
| Bazaraki | `scrape-bazaraki.mjs` | Playwright — infinite scroll per district | ⛔ Cloudflare bot challenge |
| eAuction Cyprus | `scrape-eauction.mjs` (houses), `scrape-eauction-plots.mjs` (plots/land) + `harvest-eauction.mjs` | **Plain fetch** of the unchallenged `POST /Home/HomeListAuctions` XHR endpoint for the ad list; a weekly stealth-browser harvest for detail-page fields, documents and photos | ✅ working (~46 Residence lots, ~343 plot/land lots) |
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

Bazaraki, Zyprus, and BuySellCyprus serve a Cloudflare bot-verification interstitial ("Just a moment…") to automated browsers that does not auto-clear for headless Chromium. We do not attempt to bypass bot protection. The scrapers stay in the rotation and resume automatically if the sites relax it; Bazaraki and Zyprus are refreshed from a residential connection with `npm run refresh:local`.

eAuction Cyprus is behind Imperva but is **not** in this category: its ad-list XHR endpoint is unchallenged (so the list scrape runs from CI), and the challenge on its HTML pages clears for stealth Playwright, which is what the weekly detail harvest uses.

## The eAuction detail harvest

`scripts/harvest-eauction.mjs` (weekly, `harvest-eauction.yml`; `npm run harvest:eauction` locally) is the only part of the pipeline that opens auction detail pages. It walks **every advertised lot in all eleven property subtypes** — ~420 ads: 46 Residence, 174 Land, 109 Plot with building, 58 Land with building, plus commercial — and writes `src/data/eauction-details.json`, which `scrape-eauction.mjs` merges into the listings.

Per ad it reads:

- the detail page's own field grid — registered area (Έκταση, which is the **plot** extent unless the lot is a unit in a building), registration number, sheet/plan/plot, address, ownership share, lender, guarantee, and the free-text block carrying the unit's covered area;
- **every attachment**, typed by magic bytes rather than filename: PDFs via `pdfjs-dist`, and `.docx`/`.doc`/`.rtf`/images via the dependency-free readers in `scripts/lib/documents.mjs` (a `.docx` is a ZIP — a central-directory reader plus `zlib` yields both its text and its embedded photos). The richest ads carry four PDFs: legal notice and "additional information" sheet, Greek and English;
- **all photos** — the site's `GetAuctionImage` gallery plus images embedded in the documents, filtered from cadastral maps by an HSV discriminator (saturation ≥ 12, white fraction ≤ 0.5) and stored content-hashed under `public/eauction-photos/`;
- **the facts** — plot area, covered area, **build year** (usually derived from a stated age: "about 38 years old" → 2026 − 38), floors, planning zone/density/coverage, bedrooms and bathrooms — parsed from Greek and English text by `scripts/lib/property-facts.mjs`.

The harvest is incremental (only new ads, changed auction dates or entries past `EAUCTION_MAX_AGE_DAYS`) and prunes ads that are no longer advertised, along with their photo files.

**Both pages are fed from it.** `scrape-eauction.mjs` takes subtype 5 (Residence) for the houses page; `scrape-eauction-plots.mjs` takes subtypes 12/13/14/15 (Plot, Plot with building, Land, Land with building — ~343 ads, 97% with a plot area) for the plots page. Both read the ad list from the unprotected endpoint, so **new lots appear within one scheduled scrape**, carrying price, location, district and auction date; their area, photos and planning zone arrive with the next harvest. The endpoint contract itself lives in one place, `scripts/lib/eauction-list.mjs`.

**Where the harvest runs.** The weekly workflow exists, but eAuction refuses GitHub-hosted runners: measured 2026-07-27, a runner listed all 419 ads from the unprotected endpoint and then failed to render a single detail page. So the harvest joins Bazaraki and Zyprus as a **laptop job** — `npm run harvest:eauction`, or `npm run refresh:local`, which now runs it first. The workflow stays scheduled, exits 3 without touching the cache when it is refused, and will start working on its own if the block ever lifts.

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
| Cyprus Properties (cyprusproperties.com.cy) | **Own scraper** (`scrape-cyprusproperties.mjs`) | houses + plots | Moved off the SPA walk — its `/properties?p=N&…` fragment endpoint pages server-side, so the old ~66-page click ceiling is gone. Full depth verified 2026-08-09: 770 `type=house` + 1,293 `type=apartment` + 1,370 `type=land`. **Only `house`, `apartment`, `land` and `commercial` are real `type` values** — anything else (`villa`, `bungalow`, `townhouse`, …) is silently ignored and returns the *unfiltered* list, which is easy to mistake for a deep subtype |

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

### Plots: Realting and A Place in the Sun — closed, no inventory (probed 2026-08-09)

Both were carried as "a future add" for the plots pipeline. Neither is
ingestible, and for reasons that will not change with more scraper effort:

- **A Place in the Sun has no property-type filter at all.** Its Cyprus search
  form exposes only `minbedrooms`, `maxbedrooms`, `sort_by` and `per_page`.
  `?property_type=land` returns HTTP 200 and looks like it worked — but it is
  silently ignored: same `data-total-num-pages="24"` and the same first 10
  listing ids as the unfiltered list. **Do not read a 200 as a working filter**;
  compare ids against the unfiltered page. (Same trap as Cyprus Properties'
  bogus `type` values above, where `villa` and `bungalow` return byte-identical
  pages.)
- **Realting has the category but not the stock.** `/cyprus/lands?currency=EUR`
  is a real page — HTTP 200, `<h1>Lands for sale in Cyprus</h1>` — with **zero**
  listings on it: no `/cyprus/property/<id>` links and an empty-results marker.
  Realting's Cyprus inventory is houses only. (Note the path grammar is
  `/cyprus/houses`, not `/property/cyprus` — the latter 404s.)

Re-probe only if one of those sites visibly gains land stock; there is no
scraper to write until then.
