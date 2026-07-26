#!/usr/bin/env node
/**
 * scrape-bazaraki.mjs
 * Scrapes house listings from bazaraki.com via its JSON API.
 *
 * Why the API and not the DOM:
 *   Bazaraki moved every human-facing page (including the old infinite-scroll
 *   grid this scraper used to read) behind a Cloudflare "Just a moment" managed
 *   challenge. Headless Chromium can't clear it, so the DOM scraper started
 *   returning zero. The site's React front-end talks to an internal JSON API at
 *   `/api/items/`, which is far richer than the cards ever were — it carries the
 *   covered area, plot area, bedrooms, bathrooms, construction year, every photo,
 *   and crucially the real `created_dt` (the date the ad went live).
 *
 * The Cloudflare wall in front of `/api/` lets curl through where both headless
 * Chromium and Node's `fetch()` get a 403, so this reads the API with curl (see
 * lib/curl-fetch.mjs) and needs no browser at all. That replaced a stealth-
 * patched Playwright session which Cloudflare had also begun flagging, at which
 * point this source silently returned zero.
 *
 * Only works from a residential IP: from the CI runners every client is
 * challenged, so this source refreshes via `npm run refresh:local` instead of
 * the 6-hourly workflow. See README.md.
 *
 * Walks the full catalogue by default — ~9,000 houses across the five districts
 * — rather than the bounded 30-page sample it used to take.
 *
 * Env:
 *   BAZARAKI_PAGES - cap on API pages (10 listings each) per district (default: no cap)
 */
import { curlFetchJson } from './lib/curl-fetch.mjs';

const PAGES = Number(process.env.BAZARAKI_PAGES ?? 0) || Infinity;

// Houses category on Bazaraki is rubric 678. `city` filters by district; the
// numeric ids map to Cyprus districts as follows (confirmed against the API).
const HOUSES_RUBRIC = 678;
const DISTRICTS = [
  { city: 12, name: 'Limassol' },
  { city: 11, name: 'Nicosia' },
  { city: 10, name: 'Larnaca' },
  { city: 13, name: 'Paphos' },
  { city: 8, name: 'Famagusta' },
];

// attrs__number-of-bedrooms is sometimes a "studio" code rather than a count.
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

  return {
    source: 'Bazaraki',
    title: raw.title || null,
    price: priceNum,
    priceDisplay: priceNum ? `${raw.currency || '€'}${priceNum.toLocaleString('en-US')}` : null,
    location: districtName,
    district: districtName,
    image: img ? (img.url || img.orig) : null,
    images: (raw.images || []).map(i => i.url || i.orig).filter(Boolean),
    link: `https://www.bazaraki.com/adv/${raw.id}_${raw.slug || ''}/`,
    houseSqm: toInt(a['attrs__area']),
    plotSqm: toInt(a['attrs__plot-area']),
    beds: toInt(a['attrs__number-of-bedrooms']),
    baths: toInt(a['attrs__number-of-bathrooms']),
    posted: validCreated
      ? validCreated.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })
      : null,
    postedTs: validCreated ? validCreated.getTime() : null,
    buildYear: toInt(a['attrs__construction'] ?? a['attrs__construction-year']),
    // Bazaraki publishes a real per-listing pin, plus the zoom the advertiser
    // used — low zoom means they placed it vaguely, so it doubles as a
    // precision hint for the map. Both were being discarded until 2026-07-26.
    ...geo(raw.coordinates),
    geoZoom: typeof raw.zoom === 'number' ? raw.zoom : null,
    ref: String(raw.id),
  };
}

export async function scrapeBazaraki() {
  const all = [];
  const seen = new Set();

  for (const district of DISTRICTS) {
    for (let pg = 1; pg <= PAGES; pg++) {
      const url =
        `https://www.bazaraki.com/api/items/?rubric=${HOUSES_RUBRIC}&city=${district.city}` +
        `&page=${pg}&ordering=-created_dt`;
      let payload;
      try {
        payload = await curlFetchJson(url);
      } catch (err) {
        console.error(`  Bazaraki ${district.name} p${pg} fetch error: ${err.message}`);
        break;
      }
      if (!payload || !Array.isArray(payload.results)) break;

      for (const raw of payload.results) {
        if (seen.has(raw.id)) continue;
        seen.add(raw.id);
        all.push(mapItem(raw, district.name));
      }
      if (payload.results.length < 10 || !payload.next) break;
      await new Promise((r) => setTimeout(r, 400)); // gentle, mirrors eAuction's self-throttle
    }
  }

  return all;
}

import { pathToFileURL } from 'node:url';
if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const data = await scrapeBazaraki();
  console.log(JSON.stringify(data, null, 1));
  console.error(`Scraped ${data.length} Bazaraki listings.`);
}
