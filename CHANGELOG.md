# Changelog

All notable changes to this project are documented here. Format loosely follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versioning follows [SemVer](https://semver.org/).

## [Unreleased]

## [2.3.0] - 2026-08-09

### Added
- **Planning zone filter on the Plots & Land page.** Pick a whole use ("Any residential", 1,968 plots) or a single code (`Η2`, 287). The zone was already printed on every card and was the one thing you could not filter on, which mattered most: it decides whether a plot can be built on at all. A `?` beside the label links to the zones FAQ.
  - **The field had to be canonicalised first.** `zone` is advertiser-typed free text with 444 distinct spellings across ~3,000 plots — the same trap the district filter fell into before `lib/districts.mjs`, which had produced a dropdown of 180+ options. New `scripts/lib/zones.mjs` resolves it at build time into `l.z`, so the browser gets a clean list of codes and none of the folding tables. It handles the things that actually appear: Latin *and Cyrillic* homoglyphs (`H2`, `Η2`, `Н2` are three distinct characters that render identically, and all three are in the data, plus `G` for `Γ` and a Latin `a` for the `α` suffix); longest-first prefix matching so `ΚΑ6` gives `Κα6` and not a stray `Α6`; and split zones such as `Η6 (67%) / Ζ3 (33%)`, which yield both codes because the parcel really is in both.
  - **Word-only entries resolve to a use, not a code.** `Residential`, `Οικιστική`, `αγροτικη`, `Res` cannot pin a density number but do name a use, so they answer "Any residential" without polluting the per-code options. Junk — bare percentages, plot numbers like `2230` or `ΦΥΛΛ/ΣΧ: 47/33`, town names, «δεν γνωρίζω» — resolves to nothing rather than being mis-bucketed; density numbers above 15 are rejected as parse artefacts.
  - 2,844 of the 3,046 plots that state a zone (93%) become filterable, across 107 canonical codes grouped into 9 uses.
  - The FAQ page now shares this canonicaliser instead of its own copy, which also fixed its counts — the Cyrillic fold alone recovered 28 listings it had been dropping.
- **A planning-zones FAQ** (`public/faq.html`, linked from the header of both listing pages). Plots are advertised with a code — `Η2`, `Κα6`, `Γ3`, `Ζ1` — that decides how much may be built on them, and 3,046 listings on the site carry one with no explanation anywhere. The page covers what a zone is, why there are two residential families (`Η` is the Policy Statement's village/countryside code, `Κα` the Local Plan town equivalent — the Department's legend states they correspond), how to read the four limits that apply at once, and a worked example: a 1,000 m² plot at `Η2` allows 900 m² of floor area, the same plot at `Γ3` allows 100 m².
  - **The figures come from the source, not from a blog.** `src/data/planning-zones.json` holds all 54 Policy Statement zone codes with their maximum coefficient, coverage, floors and height, extracted from the Department of Town Planning and Housing's own *Υπόμνημα Πολεοδομικών Ζωνών* published on data.gov.cy. Extraction was not free: the workbook stores the same table twice with different column orders, and the values for `Η1` and `Η2` — the single most common code on the site — exist only in the block whose columns are ordered differently again. `Η2` (0,90:1 coefficient, 0,50:1 coverage, 2 floors, 8,30 m) is corroborated independently by a third-party guide and by an advertiser who typed the full figures into a listing.
  - **Per-code counts, rebuilt with the data.** The table shows how many listings actually carry each code, which required folding the free-text `zone` field: Greek `Η` and Latin `H` render identically but are different characters, and advertisers use both, plus `G` for `Γ`, lowercase, and Latin `a` for the `α` suffix. 1,433 of the 3,046 listings with a zone resolve to a Policy Statement code; the page says so, and says the rest are Local Plan codes it deliberately does not tabulate.
  - **Three warnings, because the field invites false confidence.** The same code means different things in different Local Plans (`Κα6`'s height limit ranges 8,30–13,50 m by town); the zone on a listing is advertiser-typed free text that also arrives as percentages, plot numbers, town names and «δεν γνωρίζω»; and a plot can straddle zones (`Η6 (67%) / Ζ3 (33%)`), so a headline area can be mostly unbuildable.
  - `npm run build:faq`, and the scrapers rebuild it alongside the other two pages so the counts never drift from the data.
- **eAuction's plot and land auctions now reach the Plots & Land page** (`scripts/scrape-eauction-plots.mjs`) — ~343 lots across subtypes 12/13/14/15 (Plot, Plot with building, Land, Land with building), 97% of them carrying a plot area, most with photos. They had been excluded on the belief that the portal has no biddable land subtype; it has four, and they are the bulk of its inventory. `plotType` uses the portal's own labels, so the page's type filter gains those four options, and "with building" lots keep the covered area, bedrooms and build year the harvest found — the building is part of what is being sold. New lots appear on the next scheduled scrape with price, location and auction date, and gain their area, photos and planning zone at the next harvest.
- The eAuction list-endpoint contract now lives in one module, `scripts/lib/eauction-list.mjs`, shared by the house scraper, the plot scraper and the detail harvester, which had each grown their own copy of the request body, the card regexes and the district canonicalisation. The house listings also gained a real `postedTs` from the card's posting date, so the "recently posted" sort no longer has to parse a string.
- **Every eAuction ad is now harvested in full — documents, photos and property facts.** `scripts/harvest-eauction.mjs` (replacing `harvest-eauction-pdfs.mjs`) walks **all ~420 advertised lots across all eleven property subtypes**, not just the 46 Residence ones. Three discoveries drove this: the portal's subtypes 12-15 (Plot, Plot with building, Land, Land with building — 347 live ads) were previously believed empty, that emptiness having been measured with a status filter that happened to exclude them; the **detail page's own field grid** publishes registered area, registration number, sheet/plan/plot, address, share, lender and a free-text block with the unit's covered area, none of which the list endpoint returns; and the **"additional information" attachment** is a valuer's field report carrying land area, building area, floors, planning zone/density/coverage and prose like *"about 38 years old … three bedrooms and a bathroom"*. Result on a cold run: photos, plot area, covered area and build year for ads that previously had a price and a location.
  - **Word documents are read too.** Attachments are typed by magic bytes rather than filename and dispatched to `scripts/lib/documents.mjs`, a dependency-free reader: a `.docx` is a ZIP, so a central-directory walk plus `zlib` yields both `word/document.xml` text and the photos in `word/media/`; `.rtf` and legacy `.doc` are handled too (`.doc` text-only, and it says so in the log). No new npm dependency. The first full run read 651 attachments — 644 PDF and **7 `.docx`**, which yielded text and photos like any other.
  - **Build year, at last.** `scripts/lib/property-facts.mjs` parses Greek and English documents for plot/covered area, floors, planning zone, bedrooms and bathrooms — and derives the build year from the age the valuer states ("ηλικίας περίπου 38 ετών" → 2026 − 38), tagging it `buildYearSource: 'age' | 'stated'`. Two failure modes are handled explicitly: pdf.js shreds spacing (`13,50` arrives as `1 3 , 5 0`), so labelled fields are matched against a whitespace-stripped view of the text; and areas below 10 m² are rejected as parse artefacts rather than published as 4 m² plots.
  - **Photos are content-hashed** (`public/eauction-photos/<sha1-12>.jpg`) instead of code-named. A multi-lot auction repeats the same appendix for every lot and the Greek/English sheets embed the same images, so hashing collapses duplicates that the old naming stored several times over.
  - **Survives being throttled.** eAuction's softer defence is not a 403: the detail page returns 200 with a normal title but never runs its client-side render, which is indistinguishable from an ad that publishes nothing — so an unguarded harvester overwrites good entries with empty ones. A read yielding fewer than three fields is now a failure that keeps the cached entry, eight consecutive failures abort the run, and entries with no property type and no documents are retried on the next pass so anything blanked self-heals. The cache is checkpointed every 25 ads, so an interrupted 40-minute run keeps what it fetched.
  - **Weekly in CI, with the honest caveat.** `.github/workflows/harvest-eauction.yml` runs Sundays 02:40 UTC plus `workflow_dispatch` (`reharvest`, `limit`), and sets `COMMIT_REPLACE_DIRS=1`, a new opt-in flag in `scripts/ci/commit-data.sh`: that helper merges directory arguments into the remote's copy (right for `history/`, where a concurrent run's snapshots must not be deleted), which would have restored every pruned photo each week. **But a GitHub-hosted runner harvests nothing** — verified on a real run, which enumerated all 419 ads from the unprotected list endpoint and then failed to render a single detail page. Imperva refuses datacenter IPs, the same wall that already keeps Bazaraki and Zyprus out of CI. The harvester exits 3 on a total refusal and leaves the cache and photos untouched; the job turns that into a warning and skips the commit, so it can't go falsely green on an unchanged cache or fail every Sunday. The refresh therefore runs on the laptop: `npm run harvest:eauction`, and `npm run refresh:local` now performs it before the Bazaraki/Zyprus pass (`SKIP_EAUCTION=1` opts out). The workflow stays scheduled so it resumes by itself if the block ever lifts. The harvest is incremental (new ads, changed auction dates, entries past `EAUCTION_MAX_AGE_DAYS`) and prunes ads that are no longer advertised along with their photo files, so the committed asset directory tracks the live auction set instead of growing forever. If a runner's IP can't clear Imperva the harvester exits 2 with an explicit error rather than writing an empty cache; the fallback is `npm run harvest:eauction` from the laptop, as with Bazaraki/Zyprus.

- **Map view on both pages** (Grid/Map toggle, shared filter state). Bazaraki publishes real per-listing coordinates and the advertiser's map zoom; both were being discarded by the scrapers and are now captured as `lat`, `lng` and `geoZoom`. Leaflet + markercluster are vendored in `public/vendor/` so there is no runtime CDN dependency; tiles come from OpenStreetMap. Only listings with genuine coordinates are plotted — the map reports its coverage against the active filter rather than placing the rest at town centres, which would look identical to real pins. Built lazily on first click.
- **Full Bazaraki catalogue for houses and plots.** Both scrapers walked a bounded 30-page-per-district sample; they now walk to the end. Houses 1,500 → **9,069**, matching Bazaraki's own per-district counts exactly. Plots **0 → 6,210** — `scrape-bazaraki-plots.mjs` was still on the stealth-browser transport that stopped working, so it had been returning nothing silently. `npm run refresh:local` now covers plots as well as houses. Totals: 10,909 → 18,478 listings, 2,985 → 9,195 plots.
- **Price-per-m² analysis** (`npm run analyze`, `scripts/analyze-ppm.mjs`) — median/quartile/mean €/m² of covered area overall and by district, bedroom count and source, plus €/plot m² where plot size is published. Read-only. Ported from the retired `nicosia-house-prices` repo; the original's suburb breakdown became district, and its new-build/resale split was dropped (only 147 listings carry a build year) in favour of the plot-m² section.
- **Price history** (`npm run snapshot`, `scripts/snapshot-history.mjs`) — dated `history/YYYY-MM-DD/` snapshots of the listing set plus a `changes.md` diff of new, removed and price-changed listings versus the previous snapshot, per source and ranked by percentage move. Runs weekly via `snapshot-history.yml`. Ported from the retired `nicosia-house-prices` repo, which tracked the same thing for three Nicosia sources.

### Fixed
- **Both pages now open in about a second instead of ten.** They were building every card up front: 15,170 listings became a 228,000-node document, 8,343 plots became 119,000 nodes, and the browser spent that whole time blocked before anything appeared — for a viewport that shows a dozen cards. Measured locally in Chrome, `index.html` went from 3.7 s to interactive / 10.8 s to complete down to **0.7 s / 0.9 s**, and `plots.html` from 3.0 s / 7.0 s to **1.1 s / 1.9 s**; the initial document is now ~950 nodes on both. Four changes, no behaviour lost — the result count still reports the full match, not what is currently on screen:
  - **Cards render a chunk at a time.** 60 up front, more appended as a sentinel below the grid scrolls into view, with `content-visibility` letting the browser skip layout and paint for the ones that have scrolled past. This also means ~60 image requests on load rather than 8,000 lazy-loaded ones queued at once.
  - **The payload carries only what the templates read.** Each build script now names its fields explicitly and drops nulls instead of serialising them — `"buildYear":null,` costs 18 bytes 15,000 times over. Plots were shipping `baths`, `buildYear`, `kind`, `geoZoom`, `registration` and `status` that the page never shows. `index.html` 7.4 → 6.4 MB, `plots.html` 4.6 → 3.5 MB.
  - **The data is parsed as JSON, not as JavaScript.** It ships in a `<script type="application/json">` block and goes through `JSON.parse` in one go, which is markedly faster at this size than handing multi-megabyte object literals to the JS parser.
  - **Leaflet loads on first click of Map**, not on every page load — ~250 KB of library and stylesheets that most visitors never need.
- Filtering allocated a fresh copy of the whole dataset per criterion (eight chained `.filter()` calls) and re-ran on every keystroke; it is now a single pass, text inputs are debounced, and the lowercase search text is cached per listing.
- `.source-home\.cy` was written with a doubled backslash, so home.cy's source tag never picked up its colour and fell through to the default grey.
- `postedRank`'s relative-date regexes were written `/(\\d+)\\s*day/`, which matches a literal backslash — so "3 days ago" never parsed and every such listing sorted as if it were 500 days old. Only affected sources without a `postedTs`.
- The build scripts injected the data with `String.replace(pattern, string)`, which expands `$&` and `$'` in the replacement — a listing URL containing `$` would have silently corrupted the payload.
- **The eAuction harvest's default pace was too fast to finish.** Three runs against the live site settled it: 3 s between ads carried a full 419-ad cold harvest with zero failures, while 1.5 s was cut off after 110 ads on one day and 22 on the next — the allowance shrinking overnight, so the site's IP reputation accumulates across days rather than resetting. `EAUCTION_DELAY_MS` now defaults to 3000. A cold rebuild of every ad can't be forced through in one sitting; it converges over several daily runs, which is what the incremental check is for.
- **eAuction `houseSqm` was the plot size.** The detail page's `Area sq.m.` is Έκταση — the registered extent of the *parcel* — which the harvester wrote into both `plotSqm` and `houseSqm`, so a 759 m² plot displayed as a 759 m² house. It is now treated as a floor area only when the registration is a unit inside a building, and subtype alone doesn't establish that: a lot listed as *Residence* can be "ΔΙΩΡΟΦΗ ΚΑΤΟΙΚΙΑ ΑΡ. 2 ΣΤΟ ΙΣΟΓΕΙΟ" with a share of the common property, whose registered 99 m² is the flat's floor area while its valuation sheet puts the land at 141 m². The property text is checked for unit markers, and an explicit `Land area` / `Building area` in the documents now outranks the registry extent.
- **A rejected push no longer throws away a 35-minute scrape.** The push step was a bare `git push` with no retry: on 2026-07-26 a scheduled run and a dispatched run finished a minute apart and the second failed as non-fast-forward, discarding a complete successful scrape. Both pushing workflows now use `scripts/ci/commit-data.sh`, which re-reads the remote and replays the regenerated files on top, and `update-listings.yml` gained a concurrency group so two runs queue rather than race.
- **Cross-source dedupe no longer deletes listings on a coincidence.** `sameProperty` fell back to `bedrooms + price + district` whenever either side lacked a covered area — a coincidence detector at scale, since asking prices cluster on round numbers. It surfaced the moment Bazaraki's listings were carried back into a CI run: all 360 Zyprus rows lack `houseSqm`, 2,449 collided with Bazaraki on beds+price+district, none confirmed by area, and 84% of the source was deleted. A size must now confirm a match (house area, else plot area, else no decision), recovering 405 listings. A visible duplicate beats an invisibly deleted listing.
- Bazaraki returns `{latitude: 0, longitude: 0}` when an advertiser never placed a pin; those are now rejected rather than plotted in the Gulf of Guinea (10 rows across houses and plots).
- **CI no longer deletes the laptop-scraped sources.** `scrape-all.mjs` and `scrape-plots.mjs` rewrite their JSON from scratch, so any source returning zero simply disappeared from the dataset — and Bazaraki and Zyprus return zero from CI by design, since Cloudflare blocks the runners. The 13:19 run on 2026-07-26 wiped 9,069 Bazaraki houses, 360 Zyprus listings and 6,210 Bazaraki plots, about eleven hours after `npm run refresh:local` produced them. Both scripts now carry over the previous rows for any source that scraped nothing.
- **A dropped connection no longer costs a whole district.** The scrapers stop walking a district on any error, and `curlFetch` treated a connection failure (curl status `000`) the same as an HTTP error, so a single blip truncated everything after it — the first full run lost all 1,712 Larnaca houses to one failed request on page 1. Connection-level failures now retry three times with backoff; a real HTTP status still fails fast rather than burning requests.
- **Plot districts** went through `scrape-plots.mjs`'s own two-line canon map rather than `lib/districts.mjs`, so the plots page's district filter listed 180+ options — whole listing titles, Greek forms (`ΛΑΡΝΑΚΑ`, `Λεμεσό`), and misspellings (`Larrnaca`, `Laranca`). It now uses the shared resolver, which gained accent-insensitive Greek matching and those real-world misspellings. Filter is back to All + the five districts; 90 plots recovered, zero regressions.
- **Page weight**: `images` (6.9 photos per listing) was inlined into the self-contained pages but never read by either template — only the first photo, `image`, is used. Dropping it from the inlined payload cut `index.html` from 19 MB to 7.9 MB and `plots.html` from 6.1 MB to 4.3 MB. The full arrays stay in the JSON for enrichment and future galleries.
- **District resolution** (`scripts/lib/districts.mjs`) — 194 listings carried a `district` that was not a district: listing titles leaked in by scrapers falling back on an empty location field (`Studio`, `Property`, `Sea caves luxury villas`), town names used in place of their parent district (`Aradippou`, `Peyia`, `Pyrgos`), spelling variants (`Larnaka`), and plain `null`. All of them were silently dropped by the page's district filter and by `npm run analyze`. Resolution now happens once in `scrape-all.mjs` — district, then location, then title, then link, then a town→district map — recovering 189 of the 194 with no regressions; the remaining 5 come from sources that publish no location at all. `src/data/listings.json` was backfilled and the page rebuilt.
- **Bazaraki and Zyprus scrape again — from the laptop.** Both had been returning zero behind Cloudflare. Node's `fetch()` and a stealth headless browser are both challenged where plain `curl` passes, so both scrapers now fetch via `scripts/lib/curl-fetch.mjs`; Bazaraki drops Playwright entirely (~40s/run faster) and Zyprus parses the server-rendered `<article>` cards directly. Measured from a CI runner, however, *every* client is challenged including curl — the block is by IP reputation, so these two cannot run in Actions at all. Added `npm run refresh:local` (`scripts/refresh-local.mjs`), which re-scrapes just those two from a residential connection and merges them into `listings.json` without touching the other 15 sources. Restored 1,500 Bazaraki + 360 Zyprus listings.
- **A source returning zero now counts as a failure** in `scrape-all.mjs`. It previously counted as success, which is why this outage reported "17/17 sources succeeded" for weeks while two sources contributed nothing.

### Rollback
- Redeploy the `v2.2.0` tag via the Cloudflare Pages dashboard, or revert the release merge commit on `master` and push

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
