#!/usr/bin/env node
/**
 * scrape-kadis-plots.mjs
 * Plot / land counterpart of scrape-kadis.mjs. Same EstateBud admin-ajax access
 * (open one archive page in a headless browser, capture the WP nonce, then page
 * via in-page fetch), but with category=land and the land subtypes. For land
 * cards the single "m²" attribute is the plot area.
 *
 * Env:
 *   KADIS_PLOTS_PAGES - AJAX pages (16 each) to pull (default 40 = ~640)
 */
import { chromium } from 'playwright';
import { pathToFileURL } from 'node:url';

const MAX_PAGES = Number(process.env.KADIS_PLOTS_PAGES ?? 40);
const LAND_TYPES = ['land', 'plot', 'field', 'agricultural', 'ground'].join(',');

const DISTRICTS = ['Nicosia', 'Limassol', 'Larnaca', 'Paphos', 'Famagusta'];
const AREA_DISTRICT = {
  Lakatameia: 'Nicosia', Lakatamia: 'Nicosia', Strovolos: 'Nicosia', Latsia: 'Nicosia',
  Aglantzia: 'Nicosia', Engomi: 'Nicosia', Egkomi: 'Nicosia', Dali: 'Nicosia', Tseri: 'Nicosia',
  Germasogeia: 'Limassol', Pyrgos: 'Limassol', Paralimni: 'Famagusta', Deryneia: 'Famagusta',
};
function districtFrom(location) {
  const loc = location || '';
  for (const d of DISTRICTS) if (new RegExp(`\\b${d}\\b`, 'i').test(loc)) return d;
  const first = loc.split(',')[0].trim();
  for (const [area, d] of Object.entries(AREA_DISTRICT)) if (first.startsWith(area)) return d;
  return first || null;
}

function plotTypeFromTitle(title) {
  const t = (title || '').toLowerCase();
  for (const kw of ['residential', 'commercial', 'agricultural', 'industrial', 'tourist']) {
    if (t.includes(kw)) return kw[0].toUpperCase() + kw.slice(1);
  }
  if (/\bfield\b/.test(t)) return 'Agricultural';
  return null;
}

function parseCards(html) {
  const blocks = html.split('<div class="estatebud-property">').slice(1);
  const out = [];
  for (const b of blocks) {
    const link = (b.match(/href="(https:\/\/kadis\.com\.cy\/property-\d+\/[^"]+)"/) || [])[1];
    if (!link) continue;
    const id = (link.match(/property-(\d+)/) || [])[1] || null;
    const images = [...new Set([...b.matchAll(/<img[^>]+src="(https:\/\/estbd\.io\/[^"]+)"/g)].map(m => m[1]))];
    const priceVal = (b.match(/data-start-value='(\d+)'/) || [])[1];
    const price = priceVal ? Number(priceVal) : null;
    const title = (b.match(/estatebud-property-title'>\s*([^<]+?)\s*</) || [])[1] || null;
    const location = (b.match(/estatebud-property-location">\s*([^<]+?)\s*</) || [])[1] || null;
    const areaM = b.match(/<strong>\s*([\d,.]+)\s*<\/strong>\s*m²/i);
    const plotSqm = areaM ? Math.round(Number(areaM[1].replace(/[,.]/g, ''))) : null;
    out.push({ id, link, images, price, title, location, plotSqm });
  }
  return out;
}

export async function scrapeKadisPlots() {
  const browser = await chromium.launch();
  const page = await browser.newPage();
  let nonce = null;
  page.on('request', (r) => {
    const m = r.url().match(/estatebud_get_listing.*?security=([a-f0-9]+)/);
    if (m && !nonce) nonce = m[1];
  });

  await page.goto('https://kadis.com.cy/properties/property-for-sale-nicosia/', { waitUntil: 'domcontentloaded' });
  try {
    await page.waitForSelector('.estatebud-property', { timeout: 35000 });
  } catch {
    await browser.close();
    return [];
  }
  for (let i = 0; i < 10 && !nonce; i++) await page.waitForTimeout(500);
  if (!nonce) { await browser.close(); return []; }

  const all = [];
  const seen = new Set();
  for (let pg = 0; pg < MAX_PAGES; pg++) {
    const offset = pg * 16;
    const url =
      `/wp-admin/admin-ajax.php?action=estatebud_get_listing&is_favorites=&lang=en_US` +
      `&security=${nonce}&sort=published&sort_type=DESC&offset=${offset}&limit=16` +
      `&category=land&area_1[]=CY&type=${encodeURIComponent(LAND_TYPES)}`;
    let html;
    try {
      html = await page.evaluate(async (u) => {
        const r = await fetch(u, { headers: { 'X-Requested-With': 'XMLHttpRequest' } });
        return r.ok ? r.text() : '';
      }, url);
    } catch { break; }
    const cards = parseCards(html || '');
    if (cards.length === 0) break;
    let added = 0;
    for (const c of cards) {
      if (c.id && seen.has(c.id)) continue;
      if (c.id) seen.add(c.id);
      all.push(c);
      added++;
    }
    if (added === 0) break;
    await page.waitForTimeout(500);
  }
  await browser.close();

  return all.map((c) => ({
    source: 'Kadis Estates',
    kind: 'plot',
    title: c.title || 'Plot for sale',
    price: c.price,
    priceDisplay: c.price ? `€${c.price.toLocaleString('en-US')}` : null,
    location: c.location || 'Cyprus',
    district: districtFrom(c.location),
    image: c.images[0] || null,
    images: c.images,
    link: c.link,
    houseSqm: null,
    plotSqm: c.plotSqm,
    plotType: plotTypeFromTitle(c.title),
    zone: null,
    beds: null,
    baths: null,
    posted: null,
    postedTs: null,
    buildYear: null,
    ref: c.id,
  }));
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const data = await scrapeKadisPlots();
  console.log(JSON.stringify(data, null, 1));
  console.error(`Scraped ${data.length} Kadis plot listings.`);
}
