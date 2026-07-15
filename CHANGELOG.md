# Changelog

All notable changes to this project are documented here. Format loosely follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versioning follows [SemVer](https://semver.org/).

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
