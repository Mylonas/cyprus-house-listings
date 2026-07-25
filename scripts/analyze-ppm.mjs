#!/usr/bin/env node
/**
 * analyze-ppm.mjs
 * Price-per-square-metre analysis of src/data/listings.json — overall, by
 * district, by bedroom count, by source, and per plot m² where plot size is
 * published.
 *
 * Ported from nicosia-house-prices/scripts/analyze_ppm.py. Two changes from the
 * original: suburb breakdown became district (this repo is Cyprus-wide and has
 * no suburb field), and the new-build/resale split was dropped for a plot-m²
 * section — only 147 of ~9,000 listings publish a build year, too few to say
 * anything, while 4,193 publish a plot size.
 *
 * Read-only. Prints a report; writes nothing.
 *
 * Usage: npm run analyze
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');

// Scrapers occasionally leak a title or a stray label into `district`. Report
// only the real ones so a parse bug can't invent a district with n=1.
const DISTRICTS = ['Nicosia', 'Limassol', 'Larnaca', 'Paphos', 'Famagusta'];

const listings = JSON.parse(readFileSync(path.join(root, 'src/data/listings.json'), 'utf-8'));

const quantile = (sorted, q) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))];
const median = (sorted) => {
  const m = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[m] : (sorted[m - 1] + sorted[m]) / 2;
};
const round = (n) => Math.round(n).toLocaleString('en-US');

const stats = (values) => {
  const s = [...values].sort((a, b) => a - b);
  const mean = s.reduce((a, b) => a + b, 0) / s.length;
  return `n=${String(s.length).padStart(5)}  p25=${round(quantile(s, 0.25)).padStart(6)}  median=${round(median(s)).padStart(6)}  p75=${round(quantile(s, 0.75)).padStart(6)}  mean=${round(mean).padStart(6)}`;
};

const report = (label, values, minN = 1) => {
  if (values.length >= minN) console.log(`  ${label.padEnd(22)}`, stats(values));
};

// Guard rails match the original: a €5,000 "price" or a 3 m² "house" is a parse
// artefact, and including them moves the medians more than any real listing.
const valid = listings.filter((l) => l.price > 10000 && l.houseSqm >= 20 && l.houseSqm <= 2000);
const ppm = (l) => l.price / l.houseSqm;

console.log(`Price per covered m² — ${valid.length} of ${listings.length} listings usable\n`);
console.log('  all                   ', stats(valid.map(ppm)));

console.log('\n== by district (n>=15) ==');
const byDistrict = DISTRICTS.map((d) => [d, valid.filter((l) => l.district === d).map(ppm)])
  .filter(([, v]) => v.length >= 15)
  .sort((a, b) => median([...b[1]].sort((x, y) => x - y)) - median([...a[1]].sort((x, y) => x - y)));
for (const [d, v] of byDistrict) report(d, v);

console.log('\n== by bedrooms (n>=10) ==');
for (const b of [1, 2, 3, 4, 5, 6]) {
  report(`${b}br`, valid.filter((l) => l.beds === b).map(ppm), 10);
}

console.log('\n== by source (n>=10) ==');
const sources = [...new Set(valid.map((l) => l.source))].sort();
const bySource = sources
  .map((s) => [s, valid.filter((l) => l.source === s).map(ppm)])
  .filter(([, v]) => v.length >= 10)
  .sort((a, b) => median([...b[1]].sort((x, y) => x - y)) - median([...a[1]].sort((x, y) => x - y)));
for (const [s, v] of bySource) report(s, v);

const plotValid = listings.filter((l) => l.price > 10000 && l.plotSqm >= 50 && l.plotSqm <= 20000);
const ppmPlot = (l) => l.price / l.plotSqm;
console.log(`\n== price per plot m² — ${plotValid.length} listings publish a usable plot size ==`);
console.log('  all                   ', stats(plotValid.map(ppmPlot)));
for (const d of DISTRICTS) {
  report(d, plotValid.filter((l) => l.district === d).map(ppmPlot), 15);
}
