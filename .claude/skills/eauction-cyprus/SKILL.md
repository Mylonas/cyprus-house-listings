---
name: eauction-cyprus
description: >-
  Work with eauction-cy.com, the official Cyprus Banks Association foreclosure
  auction portal, as integrated into the cyprus-house-listings project. Use this
  skill WHENEVER the task touches eAuction Cyprus, the foreclosure/auction
  source, "the auction site", scraping or refreshing auction listings, the
  eauction enrichment cache, harvesting auction plot sizes or photos, the
  GetAuctionImage / GetFile endpoints, or debugging why the eAuction scraper
  returns nothing — even if the user doesn't name the site. It carries the
  hard-won knowledge about the site's Imperva anti-bot wall, the one unprotected
  XHR endpoint that makes CI scraping possible, the browser-only detail harvest,
  the photo-in-PDF trick, IP-block avoidance, and the deploy gotcha, so you
  don't rediscover them the hard way.
---

# eAuction Cyprus

`eauction-cy.com` is the official portal of the Cyprus Banks Association
(ACB E-AUCTIONS LTD) for online foreclosure auctions of mortgaged property.
It is one of ten sources feeding the **cyprus-house-listings** project. This
skill is the operating manual for that source — everything about the site is
shaped by one fact: **it sits behind an Imperva/Incapsula anti-bot wall.**

## The Imperva wall — the central constraint

Every human-facing HTML page (search results, auction detail) is gated by an
Imperva JavaScript challenge. Plain `fetch`/`curl` and headless browsers cannot
clear it, which is why the original Playwright scraper returned nothing from CI.
There are exactly two ways through, each with a different job:

1. **The unprotected XHR endpoint** — for the automated list scrape (CI-safe).
2. **A real, challenge-cleared browser** — for out-of-band detail enrichment.

Understanding which route to use for which task is the whole game. Don't try to
brute-force the HTML pages with plain HTTP; you'll only get the challenge page.

### Route 1: the XHR endpoint (list data, works from CI)

`POST /Home/HomeListAuctions` is **not** challenged and returns the same result
cards as the search page, as JSON-embedded HTML. This is what
[`scripts/scrape-eauction.mjs`](../../../scripts/scrape-eauction.mjs) hits with a
plain `fetch` — no browser, works from GitHub Actions. Key request facts:

- Header `X-Requested-With: XMLHttpRequest` and a `Referer` of the search page.
- Body is JSON; the fields that matter:
  - `AuctionSubTypeId` → property category. **All eleven are populated**, not
    just Residence: `5` Residence, `6` Other Commercial, `7` Store, `8` Office,
    `9` Parking, `10` Warehouse, `11` Industrial Building, `12` Plot, `13` Plot
    with building, `14` Land, `15` Land with building. `scrape-eauction.mjs`
    requests `5` (the houses page); `harvest-eauction.mjs` walks all of them.
    An earlier note claiming only 5/6/8 exist was measured with a status filter
    that happened to be empty for the rest — always probe subtype × status.
  - `AuctionStatusId` → filter by status. We request only **biddable** ones:
    `3` Posted, `6` Ready to be Conducted, `7` Open, `5` Finalized List of
    Eligible Bidders. `8` Suspended, `9` Conducted and `10` Cancelled are
    intentionally excluded — `9` alone is thousands of lots of dead archive.
    In practice almost everything live sits in status `3`.
  - **Roughly 420 ads are advertised at any time** across all subtypes (46
    Residence, 174 Land, 109 Plot with building, 58 Land with building, the
    rest commercial). Residence-only is ~46.
  - `pageNumber` (stringified), `lang: 'en-US'`.
- Parsing is regex over the returned HTML blocks split on `AList-BoxContainer`.
  Each card yields code, status, price, auction date, district, community,
  posting date, and the detail link. A card with no **Unique Code** is skipped.
- Stop paging when a page returns fewer than 20 cards or zero new codes.

If the scraper suddenly returns 0 listings, first check whether the site changed
the card markup (the `AList-*` class names) or the endpoint contract — not
whether it's "blocked". This endpoint being open is load-bearing; if it ever
gets challenged too, the whole CI integration needs rethinking.

### Route 2: a challenge-clearing browser (detail harvest)

Areas, build year, rooms, documents and photos live **only** on the
challenge-protected detail pages and their attachments. **Stealth Playwright
clears the challenge**, so this is fully automated in
[`scripts/harvest-eauction.mjs`](../../../scripts/harvest-eauction.mjs) — clear
the challenge once on the search page, then every later `page.goto()` and every
same-origin in-page `fetch()` (attachment downloads included) rides that
session. The Browser pane works too if you're exploring by hand.

## Refreshing the listings data (the normal task)

This is almost always what "refresh the auction data" means, and it does **not**
require touching the enrichment cache or the browser:

```bash
npm run scrape          # runs all 10 sources, writes src/data/listings.json,
                        # rebuilds public/index.html
npm run scrape:eauction # eAuction only, prints JSON to stdout (for debugging)
```

`scrape-all.mjs` is resilient by design: individual sources may fail (Bazaraki
timing out, Zyprus/BuySellCyprus returning 0) without failing the run — it exits
non-zero only if *every* source fails. A stable total (~900 listings) with
"9/10 sources succeeded" is normal, not a problem. eAuction itself should return
~40 biddable Residence auctions.

## The detail harvest (`harvest-eauction.mjs`) — where everything else comes from

[`scripts/harvest-eauction.mjs`](../../../scripts/harvest-eauction.mjs) is the
one place that opens auction detail pages. It walks **every advertised ad in
every subtype** (~420), and for each one reads three layers:

**1. The detail page's own field grid.** This is the most under-used source on
the site and the most reliable. Fields sit in
`div.AuctionDetailsDiv{,R,Right} > label` pairs (caption first, value last):
Real Estate Type, **Area sq.m.**, Registration Number, Sheet / Plan Plot,
Address, Registered share or interest, Mortgage Lender's Name, Guarantee
Amount, Notification Date, and the free-text **Property's other details**, which
carries the `ΕΜΒΑΔΟ ΜΟΝΑΔΑΣ / Κλειστός χώρος : N Τ.μ.` covered-area block.

> **`Area sq.m.` is Έκταση — the registered extent of the parcel, i.e. the
> plot**, even for a house. It is a floor area *only* when the registration is a
> unit inside a building. Writing it into `houseSqm` for a Residence is wrong
> and was a real bug.
>
> Subtype does not tell you which case you're in: a lot listed as **Residence**
> can be "ΔΙΩΡΟΦΗ ΚΑΤΟΙΚΙΑ ΑΡ. 2 ΣΤΟ ΙΣΟΓΕΙΟ" with a share of the common
> property, whose registered 99 m² is the unit's floor area, while the valuer's
> sheet gives the land as 141 m². So the unit test also reads **Property's other
> details** for `ΕΜΒΑΔΟ ΜΟΝΑΔΑΣ`, `ΚΟΙΝΟΚΤΗΤΗ ΙΔΙΟΚΤΗΣΙΑ`, `κοινόκτητη` and
> `ΑΡ. N ΣΤΟ ΙΣΟΓΕΙΟ/ΟΡΟΦΟ`. And when the documents state a `Land area` /
> `Building area` outright, those win over the registry extent — they say what
> they measure.

**2. Every attachment** (`a[href*=GetFile]`), fetched same-origin from the
cleared page. Types are decided by **magic bytes, not filename**:
PDFs go through `pdfjs-dist`; `.docx`/`.doc`/`.rtf`/bare images go through the
dependency-free [`scripts/lib/documents.mjs`](../../../scripts/lib/documents.mjs)
(a `.docx` is a ZIP — a small central-directory reader plus `zlib` gets both
`word/document.xml` text and `word/media/*` photos, no library needed). Legacy
`.doc` is text-only by design and logs that it was lossy.

The Word path is not theoretical: the 2026-07-27 cold run read **651
attachments — 644 PDF and 7 `.docx`** ("Press Release - 13.678.docx",
"ΔΕΛΤΙΟ.docx"), and those yielded both text and photos. Never type an
attachment by its filename.

Typical ad: one legal-notice document; better ads carry four (notice +
"ADDITIONAL INFORMATION" / "ΠΡΟΣΘΕΤΕΣ ΠΛΗΡΟΦΟΡΙΕΣ", Greek and English). The **additional
information sheet is the jackpot** — a valuer's field report with `Land area`,
`Building area`, `No. Of Floors`, planning zone/density/coverage/height, and
prose like *"the property is about 38 years old … three bedrooms and a
bathroom"*.

**3. Photos.** The site's own `GetAuctionImage` gallery (hot-linkable, stable
tokens — kept as URLs, `thumb=true` swapped for `thumb=false`) plus images
embedded in the documents. Embedded images are filtered by the HSV
discriminator — **saturation mean ≥ 12 and white-fraction ≤ 0.5**, min 200×200 —
which keeps photos (sat 28–46) and drops cadastral maps and the form banner
(sat ≈ 3–4, white ≈ 0.8). Kept photos are re-encoded (max 1600 px, q82) and
written to `public/eauction-photos/<sha1-12>.jpg`: **content-hashed, not
code-named**, because a multi-lot auction repeats the same appendix for every
lot and the Greek/English sheets embed the same photos twice. `GetFile` URLs
are per-session and expire, so these must be committed as static assets.

### Extracting facts from the prose (`lib/property-facts.mjs`)

Two things make naive regexes fail, and both are handled there:

- **PDF text extraction shreds spacing** — `13,50` arrives as `1 3 , 5 0`,
  `REGISTRATION` as `REG ISTRATION`. So labelled fields are matched against a
  *whitespace-stripped* view of the text, which makes the shredding irrelevant.
- **Build year is almost never stated.** What the valuer writes is an age
  ("about 38 years old" / "ηλικίας περίπου 38 ετών"), so the year is derived
  from the age relative to the document's own date (Notification Date), and
  tagged `buildYearSource: 'age' | 'stated'`.

Every label exists in Greek and English. Bedrooms/bathrooms come from spelled-out
numerals in both languages (`τριών υπνοδωματίων` → 3).

### The enrichment cache

[`src/data/eauction-details.json`](../../../src/data/eauction-details.json) is a
flat map keyed by auction **code**, merged into each listing by
`scrape-eauction.mjs`. Entries carry `v` (schema version — bump `SCHEMA` in the
harvester to force a full re-harvest, which is also how you resume a
half-finished cold run without redoing the finished ads), `harvestedAt`,
subtype/status,
`plotSqm`, `houseSqm`, `buildYear`, `beds`, `baths`, `floors`, `planningZone`,
`share`, `registration`, `address`, `docs[]` (what was read, with the detected
kind) and `image` + `images[]`.

- Listings without an entry still appear with their core fields — enrichment is
  purely additive.
- The harvest is **incremental**: an ad is re-read only if it's new, its auction
  date changed, its entry predates the current schema, or it's older than
  `EAUCTION_MAX_AGE_DAYS` (45). `EAUCTION_REHARVEST=1` forces everything.
- It **prunes**: ads that are no longer advertised are dropped from the cache and
  their photo files deleted (unless `EAUCTION_PRUNE=0`). This is what keeps the
  committed asset directory from growing without bound.

### What a full run yields (2026-07-27 baseline)

419 ads, 0 failures, ~70 minutes at a 3 s inter-ad delay: **354 ads with photos**
(731 image files), **384 with plot area**, 66 with covered area, 49 with build
year, 139 with bedrooms, and share / registration / property type / lender on
all 419. Covered area and build year are low because only the minority of ads
carrying an "additional information" sheet publish them — that is the source's
limit, not a parser gap. `public/eauction-photos/` sits at ~31 MB / ~500 files;
if that becomes a problem, the resize in `toJpeg` (1600 px, q82) is the knob.

### Running it

```bash
npm run harvest:eauction                          # incremental, all subtypes
EAUCTION_HARVEST_LIMIT=5 npm run harvest:eauction # quick test
EAUCTION_REHARVEST=1 npm run harvest:eauction     # rebuild every entry
EAUCTION_SUBTYPES=5 npm run harvest:eauction      # Residence only
```

### CI is scheduled but currently blocked — the data comes from the laptop

`.github/workflows/harvest-eauction.yml` runs weekly (Sundays 02:40 UTC) plus
`workflow_dispatch` with `reharvest`/`limit`. **Measured on 2026-07-27: it
harvests nothing from a GitHub-hosted runner.** The unprotected list endpoint
answers fine — the runner enumerated all 419 ads — but every detail page came
back 200 and never rendered: `detail grid never rendered` ×5, `Harvested 0/5`.
Imperva refuses datacenter IPs, the same wall that keeps Bazaraki and Zyprus out
of CI.

So treat the workflow as a standing probe, not the data path:

- The harvester exits **3** when every ad fails (and **leaves the cache and
  photos untouched**, pruning included). The job turns that into a
  `::warning::` and skips the commit, so it neither goes falsely green with an
  unchanged cache nor floods you with red every Sunday. A genuine crash still
  fails the job.
- **The real refresh is local**: `npm run harvest:eauction`, or just
  `npm run refresh:local`, which now runs the harvest first (skip it with
  `SKIP_EAUCTION=1`). This is the same laptop-only arrangement Bazaraki and
  Zyprus already use.
- If eAuction ever stops refusing datacenter IPs, the weekly job starts working
  on its own — it commits the cache and photos and deploys `public/`, with the
  listings JSON that references the new photos rebuilt by the next 6-hourly
  scrape. Don't reach for a self-hosted runner.

## Rate limits and IP blocks — back off early

Heavy activity (parallel iframe harvesting + bulk attachment downloads) will
trip an **Imperva IP-level block** — a 403 that hits *everything from your IP,
including the browser session.* When that happens:

- Stop all requests immediately. Retrying makes the cooldown longer.
- Wait several minutes, then probe with a *single* lightweight request (load the
  homepage in the browser) before resuming.
- Resume gently: serial, small delays, no parallel workers. The XHR list
  endpoint (Route 1) already self-throttles with a 400 ms delay between pages —
  match that spirit for anything else.

Prevention beats recovery: prefer the XHR endpoint, avoid re-harvesting detail
pages you don't need, and never run concurrent iframe loads.

### The throttle looks like an empty page, not a 403 (learned 2026-07-27)

Before the outright block there is a softer stage, and it is easy to mistake for
clean data. The detail page still returns 200, `<title>` is normal (no "Just a
moment"), but **the client-side render never runs**: no field grid, no attachment
links, no gallery. The tell is the timing — navigation drops to ~90-110 ms
(against 230-330 ms when healthy) and the render wait then times out.

This matters because a bare-looking page is indistinguishable from an ad with
nothing on it, so a naive harvester happily writes an empty entry over a good
one. Three defences are in `harvest-eauction.mjs` and should stay there:

1. **Fewer than 3 detail fields = failure, not an empty ad.** The entry is
   skipped and whatever was cached survives.
2. **Eight consecutive failures aborts the run** with a warning. Grinding
   through 400 blocked ads lengthens the cooldown and collects nothing.
3. **`needsHarvest` retries evidence-free entries** (no property type and no
   documents), so anything blanked by an earlier bad run self-heals on the next
   pass without a manual re-harvest.

Recovery is the standard one: stop, wait ~10 minutes, probe with a single detail
page, resume. Roughly 60-80 detail loads in an afternoon (several aborted cold
runs) was enough to trigger it, so on a laptop prefer incremental runs and let
the weekly CI job do the bulk work. The harvester **checkpoints the cache every
25 ads**, so an interrupted run keeps what it already fetched.

## The deploy gotcha (`[skip ci]` skips the deploy too)

The site is a Cloudflare Pages deploy of `public/`. The workflows that matter here:

- `update-listings.yml` — scheduled (every 6h) scrape; commits with
  **`[skip ci]`** and then **deploys directly as its own step**, because pushes
  made with `GITHUB_TOKEN` don't trigger other workflows.
- `harvest-eauction.yml` — weekly detail harvest; same commit-then-deploy shape.
  It sets `COMMIT_REPLACE_DIRS=1` for `commit-data.sh`, because that helper
  *merges* directory arguments into the remote's copy by default — which would
  restore every photo the harvest just pruned.
- `deploy.yml` — deploys `public/` on push to `master` (and now
  `workflow_dispatch`).
- `watchdog.yml` — reopens the update workflow / files an issue if data goes stale.

The trap: if **you** push a data refresh from a local machine with a
`[skip ci]` commit message, `[skip ci]` suppresses *all* workflows — including
`deploy.yml` — and there's no direct-deploy step on a manual push. Result: the
data lands on `master` but the live site is never updated. Two correct options:

1. Push the refresh commit **without `[skip ci]`** so `deploy.yml` fires, or
2. After a `[skip ci]` push, trigger the deploy manually:
   `gh workflow run deploy.yml`.

Verify a deploy actually happened: `gh run list --workflow=deploy.yml`, then
confirm the live count matches your build — the data is injected into
`public/index.html` at `__DATA__`, so fetching the live HTML and counting
`"source":` occurrences should equal `listings.json` length.

## Conventions carried from the project

- **Git workflow:** feature/fix work goes new branch → `dev` → `master`. Routine
  data refreshes follow the repo's own convention (`chore: refresh listings data
  [skip ci]`) — but remember the deploy gotcha above.
- **Trilingual rule:** this project's *page* is single-language, but if work ever
  spills into the sibling deals-blog, all changes must land in EN/EL/RU.
