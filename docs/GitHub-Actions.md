# GitHub Actions

Three workflows. All commits made by workflows carry `[skip ci]`; note that pushes made with `GITHUB_TOKEN` never trigger other workflows anyway, which is why the refresh workflow deploys directly (see below).

## `deploy.yml` — Deploy to Cloudflare Pages

- **Trigger:** push to `master`
- **Does:** `wrangler pages deploy public --project-name=cyprus-house-listings`
- **Needs:** `CLOUDFLARE_API_TOKEN` (Account → Cloudflare Pages → Edit), `CLOUDFLARE_ACCOUNT_ID`

## `update-listings.yml` — Update Cyprus house listings

- **Trigger:** every 6 hours (`0 */6 * * *`) + manual `workflow_dispatch`
- **Does:** installs Playwright Chromium → `npm run scrape` (10 sources → dedup → rebuild page) → commits `listings.json` + `index.html` if changed → **deploys to Cloudflare Pages itself** when the data changed
- **Guards:** `timeout-minutes: 45` on the job; 10-minute ceiling per source inside `scrape-all.mjs`; explicit `process.exit(0)` so leaked Chromium processes can't hang the step
- **Permissions:** `contents: write` (the refresh commit — default token is read-only and pushes 403 without it)
- **Needs:** the same two Cloudflare secrets (for its deploy step)

Why it deploys directly: its refresh commit is made with `GITHUB_TOKEN`, and GitHub deliberately does not fire workflows from such pushes — without the inline deploy step, refreshed data would never reach the live site.

## `watchdog.yml` — Freshness check

- **Trigger:** every 12 hours
- **Does:** checks `src/data/listings.json` freshness; re-triggers `update-listings.yml` if stale; opens a GitHub Issue if still stale after ~30h
- **Permissions:** `issues: write`

## Secrets

| Secret | Used by |
|---|---|
| `CLOUDFLARE_API_TOKEN` | `deploy.yml`, `update-listings.yml` |
| `CLOUDFLARE_ACCOUNT_ID` | `deploy.yml`, `update-listings.yml` |

## Known failure modes

| Symptom | Cause | Handling |
|---|---|---|
| Sources return 0 listings / fail with goto timeout | Cloudflare bot challenge (Bazaraki, Zyprus, BuySellCyprus) or transient site slowness | Run degrades gracefully; blocked sources resume automatically if unblocked |
| Run cancelled at 45 min | Something new hangs past every inner guard | Check the step log for the last "Scraping X..." line |
| Refresh commit push fails 403 | `permissions: contents: write` missing after a workflow edit | Restore the permissions block |
