# Cyprus House Listings — Wiki

Developer/user wiki for the Cyprus house-listings aggregator. These pages are mirrored to the [GitHub wiki](https://github.com/Mylonas/cyprus-house-listings/wiki) — keep both in sync when editing.

**Live site:** [cyprus-house-listings.pages.dev](https://cyprus-house-listings.pages.dev)
**Repository:** [github.com/Mylonas/cyprus-house-listings](https://github.com/Mylonas/cyprus-house-listings)
**Current version:** v2.1.1

---

## Pages

| Page | What it covers |
|------|---------------|
| [Data-Sources](Data-Sources.md) | All 10 sources, how each is scraped, current availability, dedup rules |
| [Filters-and-UI](Filters-and-UI.md) | Every filter and sort on the page, including the v2.1.0 additions |
| [GitHub-Actions](GitHub-Actions.md) | The three workflows, schedules, secrets, and failure modes |

---

## Quick Reference

### Branching
```
feature/my-feature → dev → master
```
Never commit directly to `dev` or `master`.

### Refresh the data locally
```
npm install
npx playwright install chromium
npm run scrape          # all 10 sources → dedup → src/data/listings.json → public/index.html
npm run scrape:realting # any single source (see package.json for the full list)
```

### Deploy
Every push to `master` deploys `public/` to Cloudflare Pages; the 6-hourly data refresh deploys directly from its own workflow run.
