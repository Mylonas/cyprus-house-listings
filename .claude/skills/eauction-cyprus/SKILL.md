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
  - `AuctionSubTypeId: '5'` → **Residence** (what this project tracks).
  - `AuctionStatusId` → filter by status. We request only **biddable** ones:
    `3` Posted, `6` Ready to be Conducted, `7` Open, `5` Finalized List of
    Eligible Bidders. Conducted/Cancelled/Suspended are intentionally excluded —
    they're the ~1,300-lot dead archive.
  - `pageNumber` (stringified), `lang: 'en-US'`.
- Parsing is regex over the returned HTML blocks split on `AList-BoxContainer`.
  Each card yields code, status, price, auction date, district, community,
  posting date, and the detail link. A card with no **Unique Code** is skipped.
- Stop paging when a page returns fewer than 20 cards or zero new codes.

If the scraper suddenly returns 0 listings, first check whether the site changed
the card markup (the `AList-*` class names) or the endpoint contract — not
whether it's "blocked". This endpoint being open is load-bearing; if it ever
gets challenged too, the whole CI integration needs rethinking.

### Route 2: the real browser (detail enrichment, out-of-band only)

Plot area and photos live **only** on the challenge-protected detail pages, so
they can't come from CI. They're harvested manually through a real browser that
has cleared the challenge, then committed as an enrichment cache (below). Use the
Browser pane (`preview_start` with the detail URL), let the Imperva challenge
resolve once in the main tab, then the tab's session cookie lets in-page
`fetch()` reach same-origin endpoints.

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

## The enrichment cache

[`src/data/eauction-details.json`](../../../src/data/eauction-details.json) is a
flat map, keyed by auction **code**, merged into each listing by the scraper:

```json
{ "PSW0LRXUYQ": { "plotSqm": 203, "image": "https://www.eauction-cy.com/Auction/GetAuctionImage?auctionId=...&fileId=...&thumb=false" } }
```

- **One `image` per listing.** The consumer (`scrape-eauction.mjs`) reads a
  single `enr.image`; there is no multi-image support. A listing having several
  photos on the site doesn't mean the cache is wrong — storing the best one is
  correct under the current schema. Adding a gallery is a real schema +
  template + trilingual-page change, not a cache edit.
- **`GetAuctionImage` URLs are hot-linkable** and stable — they carry
  URL-encoded `auctionId`/`fileId` tokens, not a session cookie, so they render
  fine when committed to the cache. Verify one resolves (HTTP 200, a real
  JPEG of a few hundred KB) before trusting it.
- Listings without a cache entry still appear with their core fields; enrichment
  is purely additive.

### Harvesting detail data safely

When you must (re)harvest detail pages for plot sizes / images, go through the
browser and **stay gentle** — see rate-limits below. A serial pass with delays
is slower but survives; parallel iframe workers hammering the renderer are what
triggered the last IP block.

## Photos hidden in PDF attachments (advanced, usually skip)

Every listing carries PDF attachments (legal notice, "additional information",
Greek + English copies). Some carry a **`...ph.pdf` photo appendix**, and a few
of those belong to listings that have *no* `GetAuctionImage` photo — so the PDFs
are the only way to raise photo coverage. But this route is deliberately heavy:

- The `ph.pdf` files mix **real property photos with cadastral/land-registry
  maps.** A validated discriminator: treat an embedded image as a photo when
  HSV **saturation mean ≥ 12** and **white-fraction ≤ 0.5** (maps are grayscale
  line-art: sat ≈ 3, white ≈ 0.8; photos: sat ≈ 28–46, white ≤ 0.27). Bank-logo
  PNGs are tiny (~8 KB) — filter by size too.
- **`GetFile` attachment URLs are per-session and expire** — they can't be
  hot-linked from the cache. Using these photos means extracting them and
  **committing them as static assets** under `public/`, then pointing the cache
  at local paths. That adds stale, one-time assets that go out of date whenever
  the auction set changes, plus the single-image-schema constraint above.

Because of that cost, **do not pursue PDF-photo extraction unless the user
explicitly asks for it** and accepts hosting static assets. The default answer
to "get more photos" is: it requires a hosting decision, here are the tradeoffs.

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

## The deploy gotcha (`[skip ci]` skips the deploy too)

The site is a Cloudflare Pages deploy of `public/`. There are three workflows:

- `update-listings.yml` — scheduled (every 6h) scrape; commits with
  **`[skip ci]`** and then **deploys directly as its own step**, because pushes
  made with `GITHUB_TOKEN` don't trigger other workflows.
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
