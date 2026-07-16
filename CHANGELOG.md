# Changelog

All notable changes to this project are documented here. Format loosely follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versioning follows [SemVer](https://semver.org/).

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
