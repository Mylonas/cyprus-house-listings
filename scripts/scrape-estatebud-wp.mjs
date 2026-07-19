#!/usr/bin/env node
/**
 * scrape-estatebud-wp.mjs
 * Generic scraper for Cyprus agency sites running WordPress + the EstateBud
 * plugin, where listing cards are delivered from an admin-ajax endpoint rather
 * than server-rendered. This is the same platform Kadis uses (see scrape-kadis
 * for the original, hand-rolled version); this module generalises it so more
 * clone sites can be added as one-line configs.
 *
 * Strategy: open the site's for-sale archive in a headless browser, capture the
 * exact estatebud_get_listing[_map] AJAX URL the page fires (it carries a WP
 * nonce that only validates with the page's own session), then page through it
 * with in-page fetch (same session), swapping the offset and category params.
 * The endpoint returns JSON whose `html` field holds the card markup, which we
 * parse with the shared EstateBud card parser.
 *
 * Add an agency by appending to WP_AGENCIES: a source name, its for-sale
 * archive URL, and the plugin category tokens for houses / land.
 *
 * Env:
 *   ESTATEBUD_WP_PAGES - AJAX pages to pull per agency (18/page, default 60)
 */
import { chromium } from 'playwright';
import { pathToFileURL } from 'node:url';

const PAGES = Number(process.env.ESTATEBUD_WP_PAGES ?? 60);

// category tokens are the EstateBud plugin's own; res_sale = residential sale.
export const WP_AGENCIES = [
  {
    source: 'NCH Real Estate',
    archive: 'https://nchrealestate.com/properties-for-sale/',
    host: 'nchrealestate.com',
    houseCategory: 'res_sale',
    plotCategory: 'land',
  },
];

const DISTRICTS = ['Nicosia', 'Limassol', 'Larnaca', 'Paphos', 'Famagusta'];
const DISTRICT_CANON = { Lefkosia: 'Nicosia', Lemesos: 'Limassol', Larnaka: 'Larnaca', Pafos: 'Paphos', Ammochostos: 'Famagusta' };
const AREA_DISTRICT = {
  Lakatameia: 'Nicosia', Lakatamia: 'Nicosia', Strovolos: 'Nicosia', Latsia: 'Nicosia',
  Aglantzia: 'Nicosia', Engomi: 'Nicosia', Dali: 'Nicosia', Tseri: 'Nicosia',
  Germasogeia: 'Limassol', Mesa: 'Limassol', Paralimni: 'Famagusta', Deryneia: 'Famagusta',
};

function districtFrom(location) {
  const loc = location || '';
  for (const d of DISTRICTS) if (new RegExp(`\\b${d}\\b`, 'i').test(loc)) return d;
  for (const [canon, real] of Object.entries(DISTRICT_CANON)) if (new RegExp(`\\b${canon}\\b`, 'i').test(loc)) return real;
  const first = loc.split(',')[0].trim();
  for (const [area, d] of Object.entries(AREA_DISTRICT)) if (first.startsWith(area)) return d;
  return first || null;
}

// Parse the EstateBud card HTML blocks (identical markup across clone sites).
function parseCards(html, host) {
  const blocks = html.split('<div class="estatebud-property">').slice(1);
  const out = [];
  for (const b of blocks) {
    const link = (b.match(new RegExp(`href="(https://${host.replace(/\./g, '\\.')}/property-\\d+/[^"]+)"`)) || [])[1]
      || (b.match(/href="(https:\/\/[^"]*\/property-\d+\/[^"]+)"/) || [])[1];
    if (!link) continue;
    const id = (link.match(/property-(\d+)/) || [])[1] || null;
    const images = [...new Set([...b.matchAll(/<img[^>]+src="(https:\/\/estbd\.io\/[^"]+)"/g)].map(m => m[1]))];
    const priceVal = (b.match(/data-start-value='(\d+)'/) || [])[1];
    const price = priceVal ? Number(priceVal) : null;
    const title = (b.match(/estatebud-property-title['"]?>\s*([^<]+?)\s*</) || [])[1] || null;
    const location = (b.match(/estatebud-property-location['"]?>\s*([^<]+?)\s*</) || [])[1] || null;
    // Attributes appear in two card templates: Kadis-style "<strong>3</strong>
    // Beds" or icon-style "<i class='fas fa-bed'></i>3".
    const labelAttr = (label) => {
      const m = b.match(new RegExp(`<strong>\\s*([\\d,.]+)\\s*</strong>\\s*${label}`, 'i'));
      return m ? Number(m[1].replace(/[,.]/g, '')) : null;
    };
    const iconAttr = (icon) => {
      const m = b.match(new RegExp(`fa-${icon}[^>]*></i>\\s*([\\d,.]+)`, 'i'));
      return m ? Number(m[1].replace(/[,.]/g, '')) : null;
    };
    out.push({
      id, link, images, price, title, location,
      beds: labelAttr('Beds') ?? iconAttr('bed'),
      baths: labelAttr('Baths') ?? iconAttr('bath'),
      area: labelAttr('m²') ?? labelAttr('m2') ?? iconAttr('expand-arrows-alt') ?? iconAttr('vector-square') ?? iconAttr('ruler'),
    });
  }
  return out;
}

async function scrapeAgencyKind(page, agency, kind) {
  const category = kind === 'plot' ? agency.plotCategory : agency.houseCategory;

  // Capture the AJAX URL the archive fires (list or map variant) — it holds the
  // valid nonce and the full param set the endpoint expects.
  let ajaxUrl = null;
  const onReq = (r) => {
    const u = r.url();
    if (/estatebud_get_listing(_map)?/.test(u) && /security=[a-f0-9]+/.test(u) && !ajaxUrl) ajaxUrl = u;
  };
  page.on('request', onReq);
  try {
    await page.goto(agency.archive, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.estatebud-property', { timeout: 25000 });
  } catch {
    page.off('request', onReq);
    return [];
  }
  for (let i = 0; i < 12 && !ajaxUrl; i++) await page.waitForTimeout(500);
  page.off('request', onReq);
  if (!ajaxUrl) return [];

  // Force our category and reset offset on the captured URL.
  const setParam = (url, key, val) =>
    new RegExp(`([?&]${key}=)[^&]*`).test(url)
      ? url.replace(new RegExp(`([?&]${key}=)[^&]*`), `$1${encodeURIComponent(val)}`)
      : `${url}&${key}=${encodeURIComponent(val)}`;
  let base = setParam(ajaxUrl, 'category', category);

  const all = [];
  const seen = new Set();
  for (let pg = 0; pg < PAGES; pg++) {
    const url = setParam(base, 'offset', String(pg * 18)).replace(/^https?:\/\/[^/]+/, '');
    let payload;
    try {
      payload = await page.evaluate(async (u) => {
        const r = await fetch(u, { headers: { 'X-Requested-With': 'XMLHttpRequest' } });
        return r.ok ? r.text() : '';
      }, url);
    } catch { break; }
    if (!payload) break;
    let cardHtml = payload;
    try { const j = JSON.parse(payload); cardHtml = j.html || j.listing || ''; } catch { /* raw html */ }
    const cards = parseCards(cardHtml, agency.host);
    if (cards.length === 0) break;
    let added = 0;
    for (const c of cards) {
      if (c.id && seen.has(c.id)) continue;
      if (c.id) seen.add(c.id);
      if (c.price == null) continue;               // skip price-on-request
      if (kind === 'plot' && c.beds != null) continue;  // land pass: no dwellings
      if (kind === 'house' && c.beds == null) continue; // house pass: needs beds
      all.push(normalize(c, kind, agency.source));
      added++;
    }
    if (added === 0 && cards.every(c => c.id && seen.has(c.id))) break;
    await page.waitForTimeout(400);
  }
  return all;
}

function normalize(c, kind, source) {
  const base = {
    source,
    title: c.title || (kind === 'plot' ? 'Plot for sale' : 'House for sale'),
    price: c.price,
    priceDisplay: c.price ? `€${c.price.toLocaleString('en-US')}` : null,
    location: c.location || 'Cyprus',
    district: districtFrom(c.location),
    image: c.images[0] || null,
    images: c.images,
    link: c.link,
    beds: c.beds,
    baths: c.baths,
    posted: null, postedTs: null, buildYear: null,
    ref: c.id,
  };
  return kind === 'plot'
    ? { ...base, kind: 'plot', houseSqm: null, plotSqm: c.area, plotType: null, zone: null }
    : { ...base, houseSqm: c.area, plotSqm: null };
}

export async function scrapeEstateBudWp(kind = 'house') {
  const browser = await chromium.launch();
  const page = await browser.newPage();
  const all = [];
  for (const agency of WP_AGENCIES) {
    try {
      const items = await scrapeAgencyKind(page, agency, kind);
      console.error(`  ${agency.source} (${kind}): ${items.length}`);
      all.push(...items);
    } catch (err) {
      console.error(`  ${agency.source} (${kind}) failed: ${err.message}`);
    }
  }
  await browser.close();
  return all;
}

export const scrapeEstateBudWpHouses = () => scrapeEstateBudWp('house');
export const scrapeEstateBudWpPlots = () => scrapeEstateBudWp('plot');

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const data = await scrapeEstateBudWp(process.argv[2] || 'house');
  console.log(JSON.stringify(data, null, 1));
  console.error(`Scraped ${data.length} EstateBud-WP listings.`);
}
