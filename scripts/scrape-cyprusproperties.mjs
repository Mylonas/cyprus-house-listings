#!/usr/bin/env node
/**
 * scrape-cyprusproperties.mjs
 * Cyprus Properties (cyprusproperties.com.cy) runs the EstateBud platform but,
 * unlike the SPA agencies in scrape-estatebud.mjs, its result list has a clean
 * server-side pagination endpoint:
 *   /properties?p=N&searchview=hide&area_1[]=CY&category=buy&type=<type>&sort=latest
 * The response is a JSON-escaped HTML fragment holding 12 cards. Fetching it
 * directly (no browser) pages through the whole inventory in seconds, so we get
 * full depth here instead of the ~66-page ceiling the click-driven SPA walk hit
 * within its wall-clock budget.
 *
 * Houses = type=house + type=apartment; plots = type=land. Each card yields
 * price, beds/baths, covered/plot area, title, location, image and the
 * /property/<id> link.
 *
 * Env:
 *   CYPROP_MAX_PAGES - hard page cap per type (12/page, default 400)
 */
import { pathToFileURL } from 'node:url';

const MAX_PAGES = Number(process.env.CYPROP_MAX_PAGES ?? 400);
const ORIGIN = 'https://www.cyprusproperties.com.cy';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

const DISTRICTS = ['Nicosia', 'Limassol', 'Larnaca', 'Paphos', 'Famagusta'];
const AREA_DISTRICT = {
  Germasoyeia: 'Limassol', Germasogeia: 'Limassol', Neapolis: 'Limassol', Kouklia: 'Paphos',
  Strovolos: 'Nicosia', Lakatameia: 'Nicosia', Latsia: 'Nicosia', Aglantzia: 'Nicosia', Engomi: 'Nicosia',
  Paralimni: 'Famagusta', Deryneia: 'Famagusta', Livadia: 'Larnaca', Oroklini: 'Larnaca', Pedoulas: 'Nicosia',
};
function districtFrom(loc) {
  const s = loc || '';
  for (const d of DISTRICTS) if (new RegExp(`\\b${d}\\b`, 'i').test(s)) return d;
  for (const [a, d] of Object.entries(AREA_DISTRICT)) if (new RegExp(`\\b${a}`, 'i').test(s)) return d;
  const tail = (s.split(',').pop() || '').trim();
  return tail || null;
}
function plotTypeFromTitle(t) {
  const s = (t || '').toLowerCase();
  for (const kw of ['residential', 'commercial', 'agricultural', 'industrial', 'tourist']) {
    if (s.includes(kw)) return kw[0].toUpperCase() + kw.slice(1);
  }
  return null;
}

function unescapeFragment(s) {
  return s.replace(/\\\//g, '/').replace(/\\u20ac/g, '€').replace(/\\[rnt]/g, ' ').replace(/\\"/g, '"');
}

function parseCards(fragment, kind) {
  const h = unescapeFragment(fragment);
  const items = h.split('<div class="item">').slice(1);
  const out = [];
  for (const b of items) {
    const id = (b.match(/href="\/property\/(\d+)"/) || [])[1];
    if (!id) continue;
    const image = (b.match(/(https:\/\/estbd\.io\/[^"]+)/) || [])[1] || null;
    const priceM = b.match(/class="price">\s*([\d.,]+)\s*€/);
    const price = priceM ? Number(priceM[1].replace(/[.,]/g, '')) : null;
    const beds = (b.match(/property-bed-icon\.svg[\s\S]*?value">\s*(\d+)/) || [])[1];
    const baths = (b.match(/property-bath-icon\.svg[\s\S]*?value">\s*(\d+)/) || [])[1];
    const area = (b.match(/value">\s*([\d.,]+)\s*sqm/i) || [])[1];
    // Location: the spec value that is text (has letters), not a number/sqm.
    const values = [...b.matchAll(/value">\s*([^<]+?)\s*</g)].map(m => m[1].trim());
    const location = values.find(v => /[a-z]/i.test(v) && !/sqm/i.test(v)) || null;
    const title = (b.match(/<h3>\s*([^<]+?)\s*<\/h3>/) || [])[1]?.replace(/&amp;/g, '&') || null;
    out.push({
      id, price, beds, baths,
      area: area ? Math.round(Number(area.replace(/[.,]/g, ''))) : null,
      location, title, image,
      link: `${ORIGIN}/property/${id}`,
    });
  }
  return out;
}

async function scrapeType(type, kind) {
  const all = [];
  const seen = new Set();
  for (let pg = 1; pg <= MAX_PAGES; pg++) {
    const url = `${ORIGIN}/properties?p=${pg}&searchview=hide&reference=&area_1[]=CY&category=buy&type=${type}&sort=latest`;
    let fragment;
    try {
      const res = await fetch(url, { headers: { 'User-Agent': UA, 'X-Requested-With': 'XMLHttpRequest' } });
      if (!res.ok) break;
      fragment = await res.text();
    } catch { break; }
    const cards = parseCards(fragment, kind);
    if (cards.length === 0) break;
    let added = 0;
    for (const c of cards) {
      if (seen.has(c.id)) continue;
      seen.add(c.id);
      if (c.price == null) continue; // skip price-on-request
      all.push(normalize(c, kind));
      added++;
    }
    if (added === 0) break; // page repeated the previous set -> end
  }
  return all;
}

function normalize(c, kind) {
  const base = {
    source: 'Cyprus Properties',
    title: c.title || (kind === 'plot' ? 'Plot for sale' : 'Property for sale'),
    price: c.price,
    priceDisplay: c.price ? `€${c.price.toLocaleString('en-US')}` : null,
    location: c.location || 'Cyprus',
    district: districtFrom(c.location || c.title),
    image: c.image,
    images: c.image ? [c.image] : [],
    link: c.link,
    beds: c.beds ? Number(c.beds) : null,
    baths: c.baths ? Number(c.baths) : null,
    posted: null, postedTs: null, buildYear: null,
    ref: c.id,
  };
  return kind === 'plot'
    ? { ...base, kind: 'plot', houseSqm: null, plotSqm: c.area, plotType: plotTypeFromTitle(c.title), zone: null }
    : { ...base, houseSqm: c.area, plotSqm: null };
}

export async function scrapeCyprusProperties(kind = 'house') {
  const types = kind === 'plot' ? ['land'] : ['house', 'apartment'];
  const all = [];
  for (const type of types) {
    const items = await scrapeType(type, kind);
    console.error(`  Cyprus Properties (${kind}/${type}): ${items.length}`);
    all.push(...items);
  }
  return all;
}

export const scrapeCyprusPropertiesHouses = () => scrapeCyprusProperties('house');
export const scrapeCyprusPropertiesPlots = () => scrapeCyprusProperties('plot');

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const data = await scrapeCyprusProperties(process.argv[2] || 'house');
  console.log(JSON.stringify(data, null, 1));
  console.error(`Scraped ${data.length} Cyprus Properties listings.`);
}
