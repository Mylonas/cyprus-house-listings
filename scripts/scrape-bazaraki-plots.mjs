#!/usr/bin/env node
/**
 * scrape-bazaraki-plots.mjs
 * Scrapes plot / land listings from bazaraki.com via its JSON API — the plots
 * counterpart of scrape-bazaraki.mjs. Same access model: clear the Cloudflare
 * challenge once with a stealth browser, then read the `/api/items/` API
 * same-origin.
 *
 * Houses are rubric 678; residential plots are rubric 141. The plot cards carry
 * the plot area (attrs__plot-area), plot/land type, planning zone, all photos
 * and the real created_dt go-live date.
 *
 * Env:
 *   BAZARAKI_PLOTS_PAGES - API pages (10 each) per district (default 30)
 */
import { chromium } from 'playwright-extra';
import stealth from 'puppeteer-extra-plugin-stealth';

chromium.use(stealth());

const PAGES = Number(process.env.BAZARAKI_PLOTS_PAGES ?? 30);
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
    beds: null,
    baths: null,
    posted: validCreated
      ? validCreated.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })
      : null,
    postedTs: validCreated ? validCreated.getTime() : null,
    buildYear: null,
    ref: String(raw.id),
  };
}

export async function scrapeBazarakiPlots() {
  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({
    userAgent:
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    viewport: { width: 1366, height: 768 },
    locale: 'en-US',
  });
  const page = await ctx.newPage();

  await page.goto('https://www.bazaraki.com/', { waitUntil: 'domcontentloaded' });
  for (let i = 0; i < 20; i++) {
    await page.waitForTimeout(1000);
    if (!/just a moment/i.test(await page.title())) break;
  }

  const all = [];
  const seen = new Set();

  for (const district of DISTRICTS) {
    for (let pg = 1; pg <= PAGES; pg++) {
      const url =
        `/api/items/?rubric=${PLOTS_RUBRIC}&city=${district.city}` +
        `&page=${pg}&ordering=-created_dt`;
      let payload;
      try {
        payload = await page.evaluate(async (u) => {
          const r = await fetch(u, { headers: { 'X-Requested-With': 'XMLHttpRequest' } });
          if (!r.ok) return { error: r.status };
          return r.json();
        }, url);
      } catch {
        break;
      }
      if (!payload || payload.error || !Array.isArray(payload.results)) break;
      for (const raw of payload.results) {
        if (seen.has(raw.id)) continue;
        seen.add(raw.id);
        all.push(mapItem(raw, district.name));
      }
      if (payload.results.length < 10 || !payload.next) break;
      await page.waitForTimeout(400);
    }
  }

  await browser.close();
  return all;
}

import { pathToFileURL } from 'node:url';
if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const data = await scrapeBazarakiPlots();
  console.log(JSON.stringify(data, null, 1));
  console.error(`Scraped ${data.length} Bazaraki plot listings.`);
}
