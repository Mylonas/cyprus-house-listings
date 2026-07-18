#!/usr/bin/env node
/**
 * scrape-kadis.mjs
 * Scrapes house listings from kadis.com.cy (C. Kadis Estates, Nicosia — one of
 * Cyprus's largest agencies, 10k+ properties).
 *
 * The site is WordPress + the EstateBud plugin. Listing cards are not in the
 * server-rendered HTML; they load from an admin-ajax endpoint:
 *   /wp-admin/admin-ajax.php?action=estatebud_get_listing&...&offset=N&limit=16
 * which returns card HTML. The call needs a WP nonce that only validates with
 * the page's own session cookie, so plain fetch gets a 403 ("-1"). We therefore
 * open one archive page in a headless browser, capture the nonce from the call
 * the page itself fires, then page through the endpoint with in-page fetch
 * (same session) — no Cloudflare wall here, a plain browser suffices.
 *
 * `type` filters property subtype; we request the house-like ones. `area_1[]=CY`
 * is all-Cyprus. `sort=published&sort_type=DESC` gives newest first.
 *
 * Env:
 *   KADIS_MAX_PAGES - AJAX pages (16 listings each) to pull (default 40 = ~640)
 */
import { chromium } from 'playwright';
import { pathToFileURL } from 'node:url';

const MAX_PAGES = Number(process.env.KADIS_MAX_PAGES ?? 40);
const HOUSE_TYPES = [
  'house', 'detached_house', 'semi_detached_house', 'bungalow',
  'townhouse', 'maisonette', 'mansion_villa',
].join(',');

const DISTRICTS = ['Nicosia', 'Limassol', 'Larnaca', 'Paphos', 'Famagusta'];
const DISTRICT_CANON = { Lefkosia: 'Nicosia', Lemesos: 'Limassol', Larnaka: 'Larnaca', Pafos: 'Paphos', Ammochostos: 'Famagusta' };

// Neighbourhoods that name no district in the card; map the common ones.
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

// Parse the card HTML blocks returned by the AJAX endpoint.
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
    const attr = (label) => {
      const m = b.match(new RegExp(`<strong>\\s*([\\d,.]+)\\s*</strong>\\s*${label}`, 'i'));
      return m ? Number(m[1].replace(/[,.]/g, '')) : null;
    };
    out.push({
      id, link, images,
      price, title, location,
      beds: attr('Beds'),
      baths: attr('Baths'),
      houseSqm: attr('m²') ?? attr('m2'),
    });
  }
  return out;
}

export async function scrapeKadis() {
  const browser = await chromium.launch();
  const page = await browser.newPage();

  let nonce = null;
  page.on('request', (r) => {
    const m = r.url().match(/estatebud_get_listing.*?security=([a-f0-9]+)/);
    if (m && !nonce) nonce = m[1];
  });

  await page.goto('https://kadis.com.cy/properties/property-for-sale-nicosia/', {
    waitUntil: 'domcontentloaded',
  });
  try {
    await page.waitForSelector('.estatebud-property', { timeout: 25000 });
  } catch {
    await browser.close();
    return [];
  }
  // Give the page a moment to fire its own AJAX call so we capture the nonce.
  for (let i = 0; i < 10 && !nonce; i++) await page.waitForTimeout(500);
  if (!nonce) { await browser.close(); return []; }

  const all = [];
  const seen = new Set();
  for (let pg = 0; pg < MAX_PAGES; pg++) {
    const offset = pg * 16;
    const url =
      `/wp-admin/admin-ajax.php?action=estatebud_get_listing&is_favorites=&lang=en_US` +
      `&security=${nonce}&sort=published&sort_type=DESC&offset=${offset}&limit=16` +
      `&category=res_sale&area_1[]=CY&type=${encodeURIComponent(HOUSE_TYPES)}`;
    let html;
    try {
      html = await page.evaluate(async (u) => {
        const r = await fetch(u, { headers: { 'X-Requested-With': 'XMLHttpRequest' } });
        return r.ok ? r.text() : '';
      }, url);
    } catch {
      break;
    }
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
    // Deliberately gentle — this agency site is small and we are polite.
    await page.waitForTimeout(500);
  }

  await browser.close();

  await enrichPlots(all);

  return all.map((c) => ({
    source: 'Kadis Estates',
    title: c.title || 'House for sale',
    price: c.price,
    priceDisplay: c.price ? `€${c.price.toLocaleString('en-US')}` : null,
    location: c.location || 'Cyprus',
    district: districtFrom(c.location),
    image: c.images[0] || null,
    images: c.images,
    link: c.link,
    houseSqm: c.houseSqm,
    plotSqm: c.plotSqm ?? null,
    beds: c.beds,
    baths: c.baths,
    posted: null,
    buildYear: null,
    ref: c.id,
  }));
}

// Card HTML carries covered area but not plot. The detail page's meta line
// ("Plot Area 280.5m2") does, so fetch each (plain GET) and fill plotSqm.
// Kept gentle: a small worker pool with per-request spacing. No listing date is
// published anywhere on the site.
async function enrichPlots(cards) {
  const UA =
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
    '(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
  const CONCURRENCY = 4;
  let i = 0;
  async function worker() {
    while (i < cards.length) {
      const c = cards[i++];
      if (!c.link) continue;
      try {
        const res = await fetch(c.link, { headers: { 'User-Agent': UA } });
        if (!res.ok) continue;
        const h = await res.text();
        const m = h.match(/Plot Area\s*([\d,.]+)\s*m2/i);
        if (m) {
          const n = Math.round(Number(m[1].replace(/,/g, '')));
          if (Number.isFinite(n) && n > 0) c.plotSqm = n;
        }
      } catch {
        /* leave plot null on a failed detail fetch */
      }
      await new Promise(r => setTimeout(r, 200));
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const data = await scrapeKadis();
  console.log(JSON.stringify(data, null, 1));
  console.error(`Scraped ${data.length} Kadis listings.`);
}
