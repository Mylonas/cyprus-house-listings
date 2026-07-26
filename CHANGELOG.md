# Changelog

All notable changes to this project are documented here. Format loosely follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versioning follows [SemVer](https://semver.org/).

## [Unreleased]

### Added
- **Map view on both pages** (Grid/Map toggle, shared filter state). Bazaraki publishes real per-listing coordinates and the advertiser's map zoom; both were being discarded by the scrapers and are now captured as `lat`, `lng` and `geoZoom`. Leaflet + markercluster are vendored in `public/vendor/` so there is no runtime CDN dependency; tiles come from OpenStreetMap. Only listings with genuine coordinates are plotted — the map reports its coverage against the active filter rather than placing the rest at town centres, which would look identical to real pins. Built lazily on first click.
- **Full Bazaraki catalogue for houses and plots.** Both scrapers walked a bounded 30-page-per-district sample; they now walk to the end. Houses 1,500 → **9,069**, matching Bazaraki's own per-district counts exactly. Plots **0 → 6,210** — `scrape-bazaraki-plots.mjs` was still on the stealth-browser transport that stopped working, so it had been returning nothing silently. `npm run refresh:local` now covers plots as well as houses. Totals: 10,909 → 18,478 listings, 2,985 → 9,195 plots.

### Fixed
- **Cross-source dedupe no longer deletes listings on a coincidence.** `sameProperty` fell back to `bedrooms + price + district` whenever either side lacked a covered area — a coincidence detector at scale, since asking prices cluster on round numbers. It surfaced the moment Bazaraki's listings were carried back into a CI run: all 360 Zyprus rows lack `houseSqm`, 2,449 collided with Bazaraki on beds+price+district, none confirmed by area, and 84% of the source was deleted. A size must now confirm a match (house area, else plot area, else no decision), recovering 405 listings. A visible duplicate beats an invisibly deleted listing.
- Bazaraki returns `{latitude: 0, longitude: 0}` when an advertiser never placed a pin; those are now rejected rather than plotted in the Gulf of Guinea (10 rows across houses and plots).
- **CI no longer deletes the laptop-scraped sources.** `scrape-all.mjs` and `scrape-plots.mjs` rewrite their JSON from scratch, so any source returning zero simply disappeared from the dataset — and Bazaraki and Zyprus return zero from CI by design, since Cloudflare blocks the runners. The 13:19 run on 2026-07-26 wiped 9,069 Bazaraki houses, 360 Zyprus listings and 6,210 Bazaraki plots, about eleven hours after `npm run refresh:local` produced them. Both scripts now carry over the previous rows for any source that scraped nothing.
- **A dropped connection no longer costs a whole district.** The scrapers stop walking a district on any error, and `curlFetch` treated a connection failure (curl status `000`) the same as an HTTP error, so a single blip truncated everything after it — the first full run lost all 1,712 Larnaca houses to one failed request on page 1. Connection-level failures now retry three times with backoff; a real HTTP status still fails fast rather than burning requests.
- **Plot districts** went through `scrape-plots.mjs`'s own two-line canon map rather than `lib/districts.mjs`, so the plots page's district filter listed 180+ options — whole listing titles, Greek forms (`ΛΑΡΝΑΚΑ`, `Λεμεσό`), and misspellings (`Larrnaca`, `Laranca`). It now uses the shared resolver, which gained accent-insensitive Greek matching and those real-world misspellings. Filter is back to All + the five districts; 90 plots recovered, zero regressions.
- **Page weight**: `images` (6.9 photos per listing) was inlined into the self-contained pages but never read by either template — only the first photo, `image`, is used. Dropping it from the inlined payload cut `index.html` from 19 MB to 7.9 MB and `plots.html` from 6.1 MB to 4.3 MB. The full arrays stay in the JSON for enrichment and future galleries.
- **District resolution** (`scripts/lib/districts.mjs`) — 194 listings carried a `district` that was not a district: listing titles leaked in by scrapers falling back on an empty location field (`Studio`, `Property`, `Sea caves luxury villas`), town names used in place of their parent district (`Aradippou`, `Peyia`, `Pyrgos`), spelling variants (`Larnaka`), and plain `null`. All of them were silently dropped by the page's district filter and by `npm run analyze`. Resolution now happens once in `scrape-all.mjs` — district, then location, then title, then link, then a town→district map — recovering 189 of the 194 with no regressions; the remaining 5 come from sources that publish no location at all. `src/data/listings.json` was backfilled and the page rebuilt.
- **Bazaraki and Zyprus scrape again — from the laptop.** Both had been returning zero behind Cloudflare. Node's `fetch()` and a stealth headless browser are both challenged where plain `curl` passes, so both scrapers now fetch via `scripts/lib/curl-fetch.mjs`; Bazaraki drops Playwright entirely (~40s/run faster) and Zyprus parses the server-rendered `<article>` cards directly. Measured from a CI runner, however, *every* client is challenged including curl — the block is by IP reputation, so these two cannot run in Actions at all. Added `npm run refresh:local` (`scripts/refresh-local.mjs`), which re-scrapes just those two from a residential connection and merges them into `listings.json` without touching the other 15 sources. Restored 1,500 Bazaraki + 360 Zyprus listings.
- **A source returning zero now counts as a failure** in `scrape-all.mjs`. It previously counted as success, which is why this outage reported "17/17 sources succeeded" for weeks while two sources contributed nothing.

### Added
- **Price-per-m² analysis** (`npm run analyze`, `scripts/analyze-ppm.mjs`) — median/quartile/mean €/m² of covered area overall and by district, bedroom count and source, plus €/plot m² where plot size is published. Read-only. Ported from `nicosia-house-prices`; the original's suburb breakdown became district, and its new-build/resale split was dropped (only 147 listings carry a build year) in favour of the plot-m² section.
- **Price history** (`npm run snapshot`, `scripts/snapshot-history.mjs`) — dated `history/YYYY-MM-DD/` snapshots of the listing set plus a `changes.md` diff of new, removed and price-changed listings versus the previous snapshot, per source and ranked by percentage move. Runs weekly via `snapshot-history.yml`. Ported from the retired `nicosia-house-prices` repo, which tracked the same thing for three Nicosia sources.

## [2.2.0] - 2026-07-19

### Added
- **Seven new sources** since v2.1.1, bringing the total to seventeen scrapers:
  - Kadis Estates (`scrape-kadis.mjs`) — WordPress admin-ajax EstateBud endpoint, houses + plots
  - Kazo Real Estate (`scrape-estatebud.mjs`) — generic EstateBud SPA-mode scraper, full ~240-page walk, houses + plots
  - Cyprus Properties (`scrape-cyprusproperties.mjs`) — EstateBud with a clean server-side pager; full-depth in seconds without a browser
  - NCH Real Estate (`scrape-estatebud-wp.mjs`) — generic WordPress-EstateBud admin-ajax scraper (map-mode endpoint)
  - DOM real estate (`scrape-dom.mjs`) — Prime Property Group portal, ~4.5k houses via the server-rendered Bitrix catalog pager, plain fetch
  - Pafilia (`scrape-pafilia.mjs`) — developer; Houzez `property` post type on the public WP REST API (full price/size/beds meta), filtered to English + Cyprus + sale-side
  - Giovani Homes (`scrape-giovani.mjs`) — developer; WP REST list + per-property detail-page parse for the postmeta the API hides
- **Plots & Land companion page** (`plots.html`) — parallel pipeline (`npm run scrape:plots` → `src/data/plots.json` → `build-plots-page.mjs`) aggregating plot/land listings with plot size, type, planning zone; cross-linked with the houses page
- eAuction Cyprus integration via its unprotected `POST /Home/HomeListAuctions` XHR endpoint + PDF ingest (photos and Greek legal-table fields merged from an enrichment cache)
- Bazaraki scraper rebuilt on the `/api/items/` JSON API through a stealth browser — full photos, plot size, build year, real go-live dates
- Detail-page enrichment for Realting, Altamira, and A Place in the Sun (plot/covered areas)
- Price-per-plot-m² sort on both pages; source tag colors for all new sources
- `eauction-cyprus` operating-manual skill; wiki `docs/` expanded (EstateBud platform notes, source-discovery backlog, portal & developer sources)

### Changed
- Cross-source dedupe priority extended: developers (Pafilia, Giovani Homes) rank just after the direct portals; DOM real estate ranks with the agency portals
- Price-on-request listings are excluded across EstateBud, DOM, Pafilia, and Giovani sources
- Per-source hard timeout (15 min) with per-agency walk budgets for the EstateBud SPA scrapers

### Fixed
- home.cy scraper fails fast against its Cloudflare wall instead of burning its timeout

### Rollback
- Redeploy the `v2.1.1` tag via the Cloudflare Pages dashboard, or revert the release merge commit on `master` and push

## [2.1.1] - 2026-07-16

### Fixed
- eAuction scraper still used the broken `networkidle` wait missed in v2.1.0 — switched to `domcontentloaded` + content wait (it was silently returning 0 listings)

### Added
- Wiki documentation: `docs/` pages (Home, Data-Sources, Filters-and-UI, GitHub-Actions), mirrored to the GitHub wiki now that the repo is public

### Known Limitations
- eAuction Cyprus now returns an Imperva/Incapsula 403 on its search endpoint — joins Bazaraki/Zyprus/BuySellCyprus as bot-blocked; scraper kept and resumes automatically if the block lifts

### Rollback
- Redeploy the `v2.1.0` tag via the Cloudflare Pages dashboard, or revert the release merge commit on `master` and push

## [2.1.0] - 2026-07-16

### Added
- Two new reseller/aggregator sources, bringing the total to 10:
  - Realting (international aggregator — plain-fetch scraper, `?currency=EUR` for uniform pricing, municipality→district mapping)
  - A Place in the Sun (international reseller portal — plain-fetch scraper via the `/property/cyprus/page/N` path grammar; EUR price taken from the bracketed figure on each card)
- `scripts/scrape-realting.mjs`, `scripts/scrape-apits.mjs`
- Cross-source deduplication in `scrape-all.mjs`: when two sources list the same property (exact bedrooms + price match, confirmed by covered area within 5% or by district when area is missing), the copy from the higher-priority source is kept — direct portals and auction sites win over resellers
- District normalization across all sources (Pafos→Paphos, Germasogeia→Limassol, etc.) so the district filter no longer shows spelling variants
- New source tag colors in the UI for Realting and A Place in the Sun
- Three new filters: min plot m², max plot m², and built-after year (listings without the datum are excluded while the filter is active, matching the existing min-house-m² behaviour)

### Changed
- `scrape-all.mjs` now runs 10 scrapers and deduplicates before writing `listings.json`

### Fixed
- Scheduled scrape runs no longer hang after finishing: scrapers that fail mid-navigation leave a Chromium process open, which kept Node alive indefinitely (the cause of the multi-hour stuck Actions runs) — `scrape-all.mjs` now exits explicitly, and each source additionally gets a 10-minute hard ceiling
- `update-listings.yml` gets `timeout-minutes: 45` as a backstop
- Bazaraki, Altamira, Zyprus, and BuySellCyprus scrapers were all failing with `page.goto: Timeout` — `waitUntil: 'networkidle'` never settles on these ad/analytics-heavy pages anymore; they now use `domcontentloaded` plus an explicit wait for the listing elements
- Altamira additionally gained a cookie-consent overlay that intercepted the "View more" click — the overlay is removed before clicking (no consent is given)

### Known Limitations
- Bazaraki, Zyprus, and BuySellCyprus now serve a Cloudflare bot-verification challenge to automated browsers and cannot currently be scraped; their scrapers remain in place and resume automatically if the sites relax the protection

### Rollback
- Redeploy the `v2.0.0` tag via the Cloudflare Pages dashboard, or revert the release merge commit on `master` and push — `deploy.yml` republishes the previous page automatically

## [2.0.0] - 2026-07-15

### Added
- Three new sources, bringing the total to 517 listings across 8 sources:
  - BuySellCyprus.com (53 listings — bounded "recently listed" sample of a ~28,000-listing catalogue)
  - home.cy (105 listings — also captures the presenting agency/developer name per listing)
  - FOX Realty (60 listings — scraped from the agency's own site, the largest single presence found via home.cy)
- `scripts/scrape-buysellcyprus.mjs`, `scripts/scrape-homecy.mjs`, `scripts/scrape-foxrealty.mjs`
- Recovered photos for a subset of eAuction Cyprus listings via their direct `/Auction/GetAuctionImage` endpoint (most eAuction listings still have no photo — see Known Limitations)
- New source tag colors in the UI for BuySellCyprus, home.cy, and FOX Realty

### Changed
- `scrape-all.mjs` now runs 8 scrapers instead of 5
- README rewritten with all 8 sources and updated counts

## [1.0.0] - 2026-07-15

### Added
- Initial release: 298 house-for-sale listings aggregated from 5 Cyprus sources:
  - Altamira Real Estate (99 listings — bank-owned/collateral houses)
  - Bazaraki (125 listings — general classifieds)
  - eAuction Cyprus (42 listings — official bank foreclosure auctions)
  - Zyprus (24 listings — agency-listed houses)
  - BidX1 (8 listings — pan-European auction platform, Cyprus/Houses filter)
- Single-page static site (`public/index.html`) with client-side filtering by district, price range, minimum house size, minimum bedrooms, source site, and free-text search
- Sorting by price, house size, plot size, and most-recently-posted
- `scripts/scrape-*.mjs` — one Playwright scraper per source
- `scripts/scrape-all.mjs` — orchestrator that merges all sources and rebuilds the page, tolerant of individual source failures
- `scripts/build-page.mjs` — injects `src/data/listings.json` into the HTML template
- GitHub Actions: `deploy.yml` (Cloudflare Pages on push to master), `update-listings.yml` (scrape every 6h), `watchdog.yml` (freshness check every 12h, opens an Issue if data is stale beyond ~30h)

### Known Limitations
- Build year not available from any of the 5 sources' listing/search pages
- eAuction Cyprus does not publish photos or floor sizes on its listing pages
- A handful of Bazaraki listings link to the district search page rather than the specific ad, where a stable direct link could not be resolved from the card
