#!/usr/bin/env node
/**
 * scrape-all.mjs
 * Runs all eleven source scrapers, merges and deduplicates the results, writes
 * src/data/listings.json, then rebuilds public/index.html via build-page.mjs.
 *
 * This is the script GitHub Actions runs on the update-listings.yml schedule.
 * It is intentionally resilient: if one source fails (site down, markup change),
 * the others still complete and the run does not fail outright — it exits
 * non-zero only if every source failed, so the watchdog workflow can catch it.
 */
import { writeFileSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { scrapeAltamira } from './scrape-altamira.mjs';
import { scrapeBazaraki } from './scrape-bazaraki.mjs';
import { scrapeEauction } from './scrape-eauction.mjs';
import { scrapeZyprus } from './scrape-zyprus.mjs';
import { scrapeBidx1 } from './scrape-bidx1.mjs';
import { scrapeBuySellCyprus } from './scrape-buysellcyprus.mjs';
import { scrapeHomeCy } from './scrape-homecy.mjs';
import { scrapeFoxRealty } from './scrape-foxrealty.mjs';
import { scrapeRealting } from './scrape-realting.mjs';
import { scrapeAPITS } from './scrape-apits.mjs';
import { scrapeKadis } from './scrape-kadis.mjs';
import { estateBudSources } from './scrape-estatebud.mjs';
import { scrapeEstateBudWpHouses } from './scrape-estatebud-wp.mjs';
import { scrapeCyprusPropertiesHouses } from './scrape-cyprusproperties.mjs';
import { scrapeDom } from './scrape-dom.mjs';
import { scrapePafilia } from './scrape-pafilia.mjs';
import { scrapeGiovani } from './scrape-giovani.mjs';
import { resolveDistrict } from './lib/districts.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const outPath = path.join(root, 'src/data/listings.json');

const sources = [
  ['Altamira', scrapeAltamira],
  ['Bazaraki', scrapeBazaraki],
  ['eAuction', scrapeEauction],
  ['Zyprus', scrapeZyprus],
  ['BidX1', scrapeBidx1],
  ['BuySellCyprus', scrapeBuySellCyprus],
  ['home.cy', scrapeHomeCy],
  ['FOX Realty', scrapeFoxRealty],
  ['Realting', scrapeRealting],
  ['A Place in the Sun', scrapeAPITS],
  ['Kadis Estates', scrapeKadis],
  // Each EstateBud SPA agency is its own source (own timeout budget).
  ...estateBudSources('house'),
  ['Cyprus Properties', scrapeCyprusPropertiesHouses],
  ['EstateBud-WP agencies', scrapeEstateBudWpHouses],
  ['DOM real estate', scrapeDom],
  ['Pafilia', scrapePafilia],
  ['Giovani Homes', scrapeGiovani],
];

// ---------------------------------------------------------------------------
// Cross-source deduplication
//
// Aggregators/resellers (Realting, A Place in the Sun, BuySellCyprus) carry
// stock that the direct portals also list. When two listings from different
// sources describe the same property, keep the one from the higher-priority
// source: direct portals and auction sites first, resellers last.
//
// Two listings are considered the same property when bedrooms and asking
// price match exactly AND either (a) both have a covered area within 5% of
// each other, or (b) at least one lacks a covered area but the districts
// match — the (beds, exact price) collision alone is too weak, the area or
// district agreement is what confirms it (same rule as nicosia-house-prices'
// combine.py).
// ---------------------------------------------------------------------------

const SOURCE_PRIORITY = [
  'Bazaraki', 'Zyprus', 'Altamira Real Estate', 'Altamira', 'eAuction Cyprus',
  'eAuction', 'BidX1', 'Kadis Estates', 'Pafilia', 'Giovani Homes',
  'Kazo Real Estate', 'Cyprus Properties', 'NCH Real Estate', 'DOM real estate',
  'home.cy', 'FOX Realty', 'BuySellCyprus', 'Realting',
  'A Place in the Sun',
];

function normalizeDistrict(listing) {
  listing.district = resolveDistrict(listing);
  return listing;
}

// Two listings are the same property only when a size confirms it. Matching on
// bedrooms + price + district alone looked reasonable when the dataset was
// small, but it is a coincidence detector at scale: asking prices cluster on
// round numbers, so with ~9,000 Bazaraki listings almost every 3-bed at
// €250,000 in Limassol finds a "duplicate" that is a different house.
//
// It went unnoticed because Bazaraki was absent from CI runs for weeks. The
// moment its listings were carried back in (2026-07-26) it deleted 84% of
// Zyprus — all 360 Zyprus rows lack houseSqm, so every comparison fell through
// to the district fallback and 2,449 collided, none confirmed by area.
//
// Now: no size on either side means no decision. A duplicate shown twice is a
// visible annoyance; a real listing silently deleted is invisible data loss.
function sameProperty(a, b) {
  if (a.beds == null || a.price == null) return false;
  if (a.beds !== b.beds || a.price !== b.price) return false;
  const close = (x, y) => Math.abs(x - y) / Math.max(x, y) <= 0.05;
  if (a.houseSqm != null && b.houseSqm != null) return close(a.houseSqm, b.houseSqm);
  if (a.plotSqm != null && b.plotSqm != null) return close(a.plotSqm, b.plotSqm);
  return false;
}

function dedupe(listings) {
  const rank = s => {
    const i = SOURCE_PRIORITY.indexOf(s);
    return i === -1 ? SOURCE_PRIORITY.length : i;
  };
  const ordered = [...listings].sort((a, b) => rank(a.source) - rank(b.source));

  const kept = [];
  const byLink = new Set();
  const byBedsPrice = new Map(); // "beds|price" -> kept listings

  let linkDupes = 0;
  let crossDupes = 0;

  for (const l of ordered) {
    const linkKey = (l.link || '').toLowerCase().replace(/\/+$/, '');
    if (linkKey && byLink.has(linkKey)) { linkDupes++; continue; }

    const sig = `${l.beds}|${l.price}`;
    const bucket = byBedsPrice.get(sig);
    const dupe = bucket?.find(k => k.source !== l.source && sameProperty(k, l));
    if (dupe) { crossDupes++; continue; }

    kept.push(l);
    if (linkKey) byLink.add(linkKey);
    if (!byBedsPrice.has(sig)) byBedsPrice.set(sig, []);
    byBedsPrice.get(sig).push(l);
  }

  if (linkDupes || crossDupes) {
    console.log(`Deduplication: removed ${linkDupes} same-link and ${crossDupes} cross-source duplicates.`);
  }
  return kept;
}

// Hard per-source ceiling: a scraper that neither returns nor throws (site
// hanging mid-pagination) must not stall the whole run.
const SOURCE_TIMEOUT_MS = 15 * 60 * 1000;
const withTimeout = promise =>
  Promise.race([
    promise,
    new Promise((_, reject) => {
      setTimeout(() => reject(new Error(`timed out after ${SOURCE_TIMEOUT_MS / 60000} min`)), SOURCE_TIMEOUT_MS).unref();
    }),
  ]);

const results = [];
let successCount = 0;

for (const [name, fn] of sources) {
  try {
    console.log(`Scraping ${name}...`);
    const data = await withTimeout(fn());
    console.log(`  -> ${data.length} listings`);
    results.push(...data);
    // A scraper that returns an empty array has not succeeded — it has been
    // blocked or had its markup change under it. Counting that as success is
    // how Bazaraki and Zyprus reported "17/17 sources succeeded" for weeks
    // while contributing nothing.
    if (data.length > 0) successCount++;
    else console.error(`  !! ${name} returned no listings — treating as a failure.`);
  } catch (err) {
    console.error(`  !! ${name} failed:`, err.message);
  }
}

if (successCount === 0) {
  console.error('All sources failed — leaving listings.json untouched.');
  process.exit(1);
}

// Carry over any source that produced nothing this run.
//
// This file is rewritten from scratch each time, so a source that returns zero
// silently disappears from the dataset. That is wrong for a transient failure,
// and fatal for Bazaraki and Zyprus: Cloudflare blocks them from CI entirely,
// so they are refreshed from a laptop via `npm run refresh:local` — and the
// next 6-hourly CI run used to delete that work. 9,069 Bazaraki houses, 360
// Zyprus listings and 6,210 Bazaraki plots lasted about eleven hours before
// being wiped this way on 2026-07-26.
//
// A carried-over source keeps its previous rows until something can scrape it
// again. They age, which is visible and fixable; deleting them is neither.
const scrapedSources = new Set(results.map((l) => l.source));
let previous = [];
try {
  previous = JSON.parse(readFileSync(outPath, 'utf-8'));
} catch {
  // First run, or unreadable — nothing to carry.
}
const carried = previous.filter((l) => l.source && !scrapedSources.has(l.source));
if (carried.length) {
  const bySource = {};
  for (const l of carried) bySource[l.source] = (bySource[l.source] ?? 0) + 1;
  for (const [name, n] of Object.entries(bySource)) {
    console.log(`  carrying over ${n} existing ${name} listings (nothing scraped this run)`);
  }
}

const deduped = dedupe([...results, ...carried].map(normalizeDistrict));

writeFileSync(outPath, JSON.stringify(deduped, null, 1), 'utf-8');
console.log(`Wrote ${deduped.length} listings (${results.length} scraped, ${carried.length} carried over) to src/data/listings.json (${successCount}/${sources.length} sources succeeded).`);

// Rebuild the static page from the fresh data
await import('./build-page.mjs');

// Scrapers that failed mid-navigation never reach their browser.close(),
// and the zombie Chromium keeps the event loop alive — exit explicitly so
// the CI step ends when the work ends.
process.exit(0);
