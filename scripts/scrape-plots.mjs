#!/usr/bin/env node
/**
 * scrape-plots.mjs
 * The plots/land counterpart of scrape-all.mjs. Runs every plot-source scraper,
 * merges and deduplicates the results, writes src/data/plots.json, then rebuilds
 * public/plots.html via build-plots-page.mjs.
 *
 * Resilient by design: a single source failing does not fail the run; it exits
 * non-zero only if every source failed.
 */
import { writeFileSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { scrapeBazarakiPlots } from './scrape-bazaraki-plots.mjs';
import { scrapeKadisPlots } from './scrape-kadis-plots.mjs';
import { estateBudSources } from './scrape-estatebud.mjs';
import { scrapeEstateBudWpPlots } from './scrape-estatebud-wp.mjs';
import { scrapeCyprusPropertiesPlots } from './scrape-cyprusproperties.mjs';
import { scrapeEauctionPlots } from './scrape-eauction-plots.mjs';
import { resolveDistrict } from './lib/districts.mjs';

// eAuction was long excluded here on the belief that it exposes no biddable
// land subtype. It exposes four (Plot, Plot with building, Land, Land with
// building) and they are the bulk of its inventory — ~347 of ~420 live ads.
// Reseller plot stock (Realting/APITS) is still a future add.

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const outPath = path.join(root, 'src/data/plots.json');

const sources = [
  ['Bazaraki', scrapeBazarakiPlots],
  ['eAuction Cyprus', scrapeEauctionPlots],
  ['Kadis Estates', scrapeKadisPlots],
  ...estateBudSources('plot'),
  ['Cyprus Properties', scrapeCyprusPropertiesPlots],
  ['EstateBud-WP agencies', scrapeEstateBudWpPlots],
];

const SOURCE_PRIORITY = ['Bazaraki', 'eAuction Cyprus', 'Kadis Estates', 'Kazo Real Estate', 'Cyprus Properties', 'NCH Real Estate', 'Realting', 'A Place in the Sun'];

function normalizeDistrict(l) {
  l.district = resolveDistrict(l);
  return l;
}

// Two plots are the same when price and plot area match closely in the same
// district — plots have no beds, so area+price+district is the signature.
function samePlot(a, b) {
  if (a.price == null || a.plotSqm == null || b.plotSqm == null) return false;
  if (a.price !== b.price) return false;
  if (a.district !== b.district) return false;
  return Math.abs(a.plotSqm - b.plotSqm) / Math.max(a.plotSqm, b.plotSqm) <= 0.03;
}

function dedupe(listings) {
  const rank = s => { const i = SOURCE_PRIORITY.indexOf(s); return i === -1 ? SOURCE_PRIORITY.length : i; };
  const ordered = [...listings].sort((a, b) => rank(a.source) - rank(b.source));
  const kept = [];
  const byLink = new Set();
  const byPrice = new Map();
  let linkDupes = 0, crossDupes = 0;
  for (const l of ordered) {
    const linkKey = (l.link || '').toLowerCase().replace(/\/+$/, '');
    if (linkKey && byLink.has(linkKey)) { linkDupes++; continue; }
    const bucket = byPrice.get(l.price);
    if (bucket?.find(k => k.source !== l.source && samePlot(k, l))) { crossDupes++; continue; }
    kept.push(l);
    if (linkKey) byLink.add(linkKey);
    if (!byPrice.has(l.price)) byPrice.set(l.price, []);
    byPrice.get(l.price).push(l);
  }
  if (linkDupes || crossDupes) console.log(`Deduplication: removed ${linkDupes} same-link and ${crossDupes} cross-source duplicates.`);
  return kept;
}

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
    console.log(`Scraping ${name} plots...`);
    const data = await withTimeout(fn());
    console.log(`  -> ${data.length} plots`);
    results.push(...data);
    successCount++;
  } catch (err) {
    console.error(`  !! ${name} plots failed:`, err.message);
  }
}

if (successCount === 0) {
  console.error('All plot sources failed — leaving plots.json untouched.');
  process.exit(1);
}

// Same carry-over as scrape-all.mjs: a source that scraped nothing keeps its
// existing rows rather than vanishing from the file. Bazaraki plots are
// laptop-only (Cloudflare blocks CI), so without this every CI run deletes what
// `npm run refresh:local` just produced.
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
    console.log(`  carrying over ${n} existing ${name} plots (nothing scraped this run)`);
  }
}

const deduped = dedupe([...results, ...carried].map(normalizeDistrict));
writeFileSync(outPath, JSON.stringify(deduped, null, 1), 'utf-8');
console.log(`Wrote ${deduped.length} plots (${results.length} scraped, ${carried.length} carried over) to src/data/plots.json (${successCount}/${sources.length} sources succeeded).`);

await import('./build-plots-page.mjs');
// The zones FAQ counts plots per zone code, so it goes stale too.
await import('./build-faq-page.mjs');
process.exit(0);
