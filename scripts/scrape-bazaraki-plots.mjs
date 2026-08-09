#!/usr/bin/env node
/**
 * scrape-bazaraki-plots.mjs
 * Scrapes plot / land listings from bazaraki.com via its JSON API — the plots
 * counterpart of scrape-bazaraki.mjs, and it shares that file's access model:
 * read `/api/items/` with curl (see lib/curl-fetch.mjs), no browser.
 *
 * Houses are rubric 678; residential plots are rubric 141. The plot cards carry
 * the plot area (attrs__plot-area), plot/land type, planning zone, all photos
 * and the real created_dt go-live date.
 *
 * Walks the full catalogue by default — ~6,200 plots — rather than a bounded
 * sample. Only works from a residential IP, so it runs via `npm run
 * refresh:local`, not the plots workflow. See README.md.
 *
 * Env:
 *   BAZARAKI_PLOTS_PAGES - cap on API pages (10 each) per district (default: no cap)
 */
import { curlFetchJson } from './lib/curl-fetch.mjs';
import { buildingPercent } from './lib/zones.mjs';

const PAGES = Number(process.env.BAZARAKI_PLOTS_PAGES ?? 0) || Infinity;
const PLOTS_RUBRIC = 141;
const DISTRICTS = [
  { city: 12, name: 'Limassol' },
  { city: 11, name: 'Nicosia' },
  { city: 10, name: 'Larnaca' },
  { city: 13, name: 'Paphos' },
  { city: 8, name: 'Famagusta' },
];

// The numeric attrs__plot-type codes proved unreliable; the title states the
// type in plain words ("Residential Plot", "Agricultural Field", ...), so read
// it from there.
function plotTypeFromTitle(title) {
  const t = (title || '').toLowerCase();
  for (const kw of ['residential', 'commercial', 'agricultural', 'industrial', 'tourist']) {
    if (t.includes(kw)) return kw[0].toUpperCase() + kw.slice(1);
  }
  return null;
}

function toInt(v) {
  if (v == null) return null;
  const n = Number(String(v).replace(/[^\d.]/g, ''));
  return Number.isFinite(n) && n > 0 ? Math.round(n) : null;
}

// Bazaraki returns {latitude: 0, longitude: 0} when the advertiser never placed
// a pin. Passed through, those render as markers off the coast of Africa, so
// anything outside a generous Cyprus box is treated as no coordinate at all.
const CY_BOX = { minLat: 34.4, maxLat: 35.8, minLng: 32.1, maxLng: 34.7 };
function geo(coords) {
  const lat = coords?.latitude, lng = coords?.longitude;
  if (typeof lat !== 'number' || typeof lng !== 'number') return { lat: null, lng: null };
  const ok = lat >= CY_BOX.minLat && lat <= CY_BOX.maxLat && lng >= CY_BOX.minLng && lng <= CY_BOX.maxLng;
  return ok ? { lat, lng } : { lat: null, lng: null };
}
function mapItem(raw, districtName) {
  const a = raw.attrs || {};
  const created = raw.created_dt ? new Date(raw.created_dt) : null;
  const validCreated = created && !Number.isNaN(created.getTime()) ? created : null;
  const priceNum = Number(String(raw.price ?? '').replace(/[^\d.]/g, '')) || null;
  const img = raw.images?.[0];
  const plotType = plotTypeFromTitle(raw.title);

  return {
    source: 'Bazaraki',
    kind: 'plot',
    title: raw.title || null,
    price: priceNum,
    priceDisplay: priceNum ? `${raw.currency || '€'}${priceNum.toLocaleString('en-US')}` : null,
    location: districtName,
    district: districtName,
    image: img ? (img.url || img.orig) : null,
    images: (raw.images || []).map(i => i.url || i.orig).filter(Boolean),
    link: `https://www.bazaraki.com/adv/${raw.id}_${raw.slug || ''}/`,
    houseSqm: null,
    plotSqm: toInt(a['attrs__plot-area']),
    plotType,
    zone: (a['attrs__planning-zone'] && !/^[-\s]*$/.test(a['attrs__planning-zone'])) ? a['attrs__planning-zone'] : null,
    // The buildable allowance, published on roughly half of plots and until now
    // discarded. This is the figure that decides what a plot is worth: the zone
    // code implies it, but the advertiser states it for this actual parcel.
    // Both arrive as free text in mixed notations — see buildingPercent.
    density: buildingPercent(a['attrs__density']),
    coverage: buildingPercent(a['attrs__coverage'], 100),
    beds: null,
    baths: null,
    posted: validCreated
      ? validCreated.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })
      : null,
    postedTs: validCreated ? validCreated.getTime() : null,
    buildYear: null,
    // Bazaraki publishes a real per-listing pin, plus the zoom the advertiser
    // used — low zoom means they placed it vaguely, so it doubles as a
    // precision hint for the map. Both were being discarded until 2026-07-26.
    ...geo(raw.coordinates),
    geoZoom: typeof raw.zoom === 'number' ? raw.zoom : null,
    ref: String(raw.id),
  };
}

export async function scrapeBazarakiPlots() {
  const all = [];
  const seen = new Set();

  for (const district of DISTRICTS) {
    for (let pg = 1; pg <= PAGES; pg++) {
      const url =
        `https://www.bazaraki.com/api/items/?rubric=${PLOTS_RUBRIC}&city=${district.city}` +
        `&page=${pg}&ordering=-created_dt`;
      let payload;
      try {
        payload = await curlFetchJson(url);
      } catch (err) {
        console.error(`  Bazaraki plots ${district.name} p${pg}: ${err.message}`);
        break;
      }
      if (!payload || !Array.isArray(payload.results)) break;
      for (const raw of payload.results) {
        if (seen.has(raw.id)) continue;
        seen.add(raw.id);
        all.push(mapItem(raw, district.name));
      }
      if (payload.results.length < 10 || !payload.next) break;
      await new Promise((r) => setTimeout(r, 400));
    }
    console.error(`  Bazaraki plots ${district.name}: ${all.length} so far`);
  }

  return all;
}

import { pathToFileURL } from 'node:url';
if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const data = await scrapeBazarakiPlots();
  console.log(JSON.stringify(data, null, 1));
  console.error(`Scraped ${data.length} Bazaraki plot listings.`);
}
