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
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { scrapeBazarakiPlots } from './scrape-bazaraki-plots.mjs';
import { scrapeKadisPlots } from './scrape-kadis-plots.mjs';
import { scrapeEstateBudPlots } from './scrape-estatebud.mjs';

// Note: eAuction currently exposes no biddable land/plot subtype (only
// Residence/Commercial/Office are populated), so it contributes no plots and is
// intentionally not a plots source. Reseller plot stock (Realting/APITS) is a
// future add — Bazaraki + Kadis already cover the direct market.

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const outPath = path.join(root, 'src/data/plots.json');

const sources = [
  ['Bazaraki', scrapeBazarakiPlots],
  ['Kadis Estates', scrapeKadisPlots],
  ['EstateBud agencies', scrapeEstateBudPlots],
];

const SOURCE_PRIORITY = ['Bazaraki', 'eAuction Cyprus', 'Kadis Estates', 'Kazo Real Estate', 'Realting', 'A Place in the Sun'];

const DISTRICT_CANON = {
  Pafos: 'Paphos', Lefkosia: 'Nicosia', Ammochostos: 'Famagusta',
  Germasogeia: 'Limassol', Lemesos: 'Limassol',
};
function normalizeDistrict(l) {
  if (l.district && DISTRICT_CANON[l.district]) l.district = DISTRICT_CANON[l.district];
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

const deduped = dedupe(results.map(normalizeDistrict));
writeFileSync(outPath, JSON.stringify(deduped, null, 1), 'utf-8');
console.log(`Wrote ${deduped.length} plots (${results.length} scraped) to src/data/plots.json (${successCount}/${sources.length} sources succeeded).`);

await import('./build-plots-page.mjs');
process.exit(0);
