#!/usr/bin/env node
/**
 * snapshot-history.mjs
 * Records a dated snapshot of src/data/listings.json into history/YYYY-MM-DD/
 * and writes changes.md there: new, removed and price-changed listings versus
 * the previous snapshot, broken down per source.
 *
 * Ported from nicosia-house-prices/scripts/snapshot_history.py, which tracked
 * the same thing across three Nicosia sources before this repo superseded it.
 *
 * Listings are keyed by `link` — verified unique across all sources, and stable
 * across runs in a way `ref` is not (sources reuse ref numbers).
 *
 * The snapshot is slim NDJSON sorted by link, not a copy of the full 8 MB
 * listings.json: images and prose are dropped, and the stable sort keeps git
 * deltas between snapshots small.
 *
 * Usage: npm run snapshot
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const histDir = path.join(root, 'history');

const SNAPSHOT_FIELDS = ['link', 'source', 'price', 'beds', 'houseSqm', 'plotSqm', 'district', 'title'];

const slim = (l) => Object.fromEntries(SNAPSHOT_FIELDS.map((f) => [f, l[f] ?? null]));

const writeSnapshot = (dir, listings) => {
  const sorted = [...listings].sort((a, b) => a.link.localeCompare(b.link));
  const ndjson = sorted.map((l) => JSON.stringify(slim(l))).join('\n') + '\n';
  writeFileSync(path.join(dir, 'listings.ndjson'), ndjson, 'utf-8');
};

const readSnapshot = (dir) => {
  const file = path.join(dir, 'listings.ndjson');
  if (!existsSync(file)) return null;
  const map = new Map();
  for (const line of readFileSync(file, 'utf-8').split('\n')) {
    if (!line.trim()) continue;
    const l = JSON.parse(line);
    map.set(l.link, l);
  }
  return map;
};

const eur = (v) => (typeof v === 'number' && Number.isFinite(v) ? `€${v.toLocaleString('en-US')}` : '?');

const today = new Date().toISOString().slice(0, 10);
const snapDir = path.join(histDir, today);
mkdirSync(snapDir, { recursive: true });

const listings = JSON.parse(readFileSync(path.join(root, 'src/data/listings.json'), 'utf-8'));

const previousDates = existsSync(histDir)
  ? readdirSync(histDir, { withFileTypes: true })
      .filter((d) => d.isDirectory() && /^\d{4}-\d{2}-\d{2}$/.test(d.name) && d.name < today)
      .map((d) => d.name)
      .sort()
  : [];
const prevDate = previousDates.at(-1) ?? null;
const prev = prevDate ? readSnapshot(path.join(histDir, prevDate)) : null;

writeSnapshot(snapDir, listings);

const cur = new Map(listings.map((l) => [l.link, l]));
const sources = [...new Set(listings.map((l) => l.source))].sort();

const lines = [
  `# Listing changes — ${today}`,
  '',
  `Compared against: ${prevDate ?? 'none (first snapshot)'}`,
  `Current listings: ${cur.size}${prev ? ` (was ${prev.size})` : ''}`,
  '',
];

if (!prev) {
  lines.push('First snapshot — no diff to report.', '');
} else {
  // A source that scraped to zero this run has not lost its stock, it failed.
  // Reporting that as thousands of removals would bury the real changes.
  const curBySource = new Set(sources);
  const droppedSources = [...new Set([...prev.values()].map((l) => l.source))]
    .filter((s) => !curBySource.has(s))
    .sort();
  if (droppedSources.length) {
    lines.push(
      `> **${droppedSources.length} source(s) returned nothing this run:** ${droppedSources.join(', ')}.`,
      '> Their listings are excluded from the removal counts below — a failed scrape is not a delisting.',
      ''
    );
  }
  const ignored = new Set(droppedSources);

  const added = [...cur.values()].filter((l) => !prev.has(l.link));
  const removed = [...prev.values()].filter((l) => !cur.has(l.link) && !ignored.has(l.source));
  const changed = [...cur.values()]
    .filter((l) => prev.has(l.link))
    .map((l) => ({ cur: l, old: prev.get(l.link) }))
    .filter(({ cur: c, old: o }) => typeof c.price === 'number' && typeof o.price === 'number' && c.price !== o.price);

  lines.push(
    `**New: ${added.length} · Removed: ${removed.length} · Price changed: ${changed.length}**`,
    ''
  );

  for (const src of sources) {
    const a = added.filter((l) => l.source === src).length;
    const r = removed.filter((l) => l.source === src).length;
    const c = changed.filter(({ cur: l }) => l.source === src);
    if (!a && !r && !c.length) continue;

    lines.push(`## ${src}`, '', `New: ${a} | Removed: ${r} | Price changed: ${c.length}`, '');

    // Steepest moves first — a €5k trim on a €2M villa is noise next to a €90k cut.
    const byMagnitude = c
      .map((e) => ({ ...e, pct: (e.cur.price - e.old.price) / e.old.price }))
      .sort((x, y) => Math.abs(y.pct) - Math.abs(x.pct));

    for (const { cur: l, old: o, pct } of byMagnitude) {
      const dir = l.price < o.price ? 'cut' : 'up';
      const sign = pct > 0 ? '+' : '';
      const desc = [l.beds ? `${l.beds}br` : null, l.houseSqm ? `${l.houseSqm}m²` : null, l.district]
        .filter(Boolean)
        .join(' ');
      lines.push(`- [${dir}] ${eur(o.price)} → ${eur(l.price)} (${sign}${(pct * 100).toFixed(1)}%) | ${desc} | ${l.link}`);
    }
    lines.push('');
  }
}

writeFileSync(path.join(snapDir, 'changes.md'), lines.join('\n'), 'utf-8');
console.log(`Snapshot written to history/${today}/ (${cur.size} listings).`);
console.log(lines.slice(0, 8).join('\n'));
