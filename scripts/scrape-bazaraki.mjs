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
 * The Cloudflare wall still guards `/api/`, so we clear the challenge once with a
 * stealth-patched headless browser (playwright-extra + puppeteer-extra-plugin-
 * stealth), then read the API from inside that cleared page context — same-origin
 * `fetch()` carries the cf_clearance cookie. This is the Bazaraki analogue of the
 * eAuction "clear the challenge in a real browser, then fetch same-origin" trick.
 *
 * Env:
 *   BAZARAKI_PAGES - API pages (10 listings each) to pull per district (default 10)
 */
import { chromium } from 'playwright-extra';
import stealth from 'puppeteer-extra-plugin-stealth';

chromium.use(stealth());

const PAGES = Number(process.env.BAZARAKI_PAGES ?? 30);

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
    ref: String(raw.id),
  };
}

export async function scrapeBazaraki() {
  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({
    userAgent:
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    viewport: { width: 1366, height: 768 },
    locale: 'en-US',
  });
  const page = await ctx.newPage();

  // Clear the Cloudflare challenge once on the homepage; the cf_clearance cookie
  // then lets same-origin API fetches through for the rest of the session.
  await page.goto('https://www.bazaraki.com/', { waitUntil: 'domcontentloaded' });
  for (let i = 0; i < 20; i++) {
    await page.waitForTimeout(1000);
    const title = await page.title();
    if (!/just a moment/i.test(title)) break;
  }

  const all = [];
  const seen = new Set();

  for (const district of DISTRICTS) {
    for (let pg = 1; pg <= PAGES; pg++) {
      const url =
        `/api/items/?rubric=${HOUSES_RUBRIC}&city=${district.city}` +
        `&page=${pg}&ordering=-created_dt`;
      let payload;
      try {
        payload = await page.evaluate(async (u) => {
          const r = await fetch(u, { headers: { 'X-Requested-With': 'XMLHttpRequest' } });
          if (!r.ok) return { error: r.status };
          return r.json();
        }, url);
      } catch (err) {
        console.error(`  Bazaraki ${district.name} p${pg} fetch error: ${err.message}`);
        break;
      }
      if (!payload || payload.error || !Array.isArray(payload.results)) {
        if (payload?.error) console.error(`  Bazaraki ${district.name} p${pg} -> HTTP ${payload.error}`);
        break;
      }
      for (const raw of payload.results) {
        if (seen.has(raw.id)) continue;
        seen.add(raw.id);
        all.push(mapItem(raw, district.name));
      }
      if (payload.results.length < 10 || !payload.next) break;
      await page.waitForTimeout(400); // gentle, mirrors eAuction's self-throttle
    }
  }

  await browser.close();
  return all;
}

import { pathToFileURL } from 'node:url';
if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const data = await scrapeBazaraki();
  console.log(JSON.stringify(data, null, 1));
  console.error(`Scraped ${data.length} Bazaraki listings.`);
}
