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
import { writeFileSync } from 'node:fs';
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

const DISTRICT_CANON = {
  Pafos: 'Paphos', Lefkosia: 'Nicosia', Ammochostos: 'Famagusta',
  Germasogeia: 'Limassol', Lemesos: 'Limassol',
};

function normalizeDistrict(listing) {
  if (listing.district && DISTRICT_CANON[listing.district]) {
    listing.district = DISTRICT_CANON[listing.district];
  }
  return listing;
}

function sameProperty(a, b) {
  if (a.beds == null || a.price == null) return false;
  if (a.beds !== b.beds || a.price !== b.price) return false;
  if (a.houseSqm != null && b.houseSqm != null) {
    return Math.abs(a.houseSqm - b.houseSqm) / Math.max(a.houseSqm, b.houseSqm) <= 0.05;
  }
  return a.district != null && a.district === b.district;
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
    successCount++;
  } catch (err) {
    console.error(`  !! ${name} failed:`, err.message);
  }
}

if (successCount === 0) {
  console.error('All sources failed — leaving listings.json untouched.');
  process.exit(1);
}

const deduped = dedupe(results.map(normalizeDistrict));

writeFileSync(outPath, JSON.stringify(deduped, null, 1), 'utf-8');
console.log(`Wrote ${deduped.length} listings (${results.length} scraped) to src/data/listings.json (${successCount}/${sources.length} sources succeeded).`);

// Rebuild the static page from the fresh data
await import('./build-page.mjs');

// Scrapers that failed mid-navigation never reach their browser.close(),
// and the zombie Chromium keeps the event loop alive — exit explicitly so
// the CI step ends when the work ends.
process.exit(0);
