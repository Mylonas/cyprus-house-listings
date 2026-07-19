#!/usr/bin/env node
/**
 * scrape-pafilia.mjs
 * Pafilia (pafilia.com) — one of Cyprus' largest property developers. The site
 * runs WordPress with the Houzez theme, whose `property` post type is exposed
 * on the public REST API together with its full Houzez meta (price, covered
 * size, bedrooms, bathrooms):
 *   /wp-json/wp/v2/properties?per_page=100&page=N&_embed=wp:featuredmedia
 *
 * Every property is duplicated per site language (en/de/pl/ru/vi/zh — the
 * translations have /xx/ path prefixes in their links) and the catalogue also
 * carries the developer's Greece projects, so we keep only English posts whose
 * property_city term is a Cyprus city, and only for-sale stock (the For Rent
 * status term is excluded). Price-on-request units are skipped.
 */
import { pathToFileURL } from 'node:url';

const ORIGIN = 'https://www.pafilia.com';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

// English property_status term ids: 29 = For Rent (exclude); everything else
// (For Sale, New Listing, Resale, ...) is sale-side.
const STATUS_FOR_RENT = 29;

const CITY_DISTRICT = {
  Limassol: 'Limassol', Paphos: 'Paphos', Pafos: 'Paphos', Larnaca: 'Larnaca',
  Nicosia: 'Nicosia', Ammochostos: 'Famagusta',
};

async function getJson(url) {
  const res = await fetch(url, { headers: { 'User-Agent': UA } });
  if (!res.ok) throw new Error(`${res.status} for ${url}`);
  return { json: await res.json(), total: Number(res.headers.get('x-wp-total') || 0) };
}

export async function scrapePafilia() {
  // property_city term id -> name, to keep Cyprus stock and derive districts.
  const cityName = {};
  const { json: cities } = await getJson(`${ORIGIN}/wp-json/wp/v2/property_city?per_page=100`);
  for (const c of cities) cityName[c.id] = c.name;

  const all = [];
  for (let page = 1; page <= 20; page++) {
    let batch;
    try {
      ({ json: batch } = await getJson(
        `${ORIGIN}/wp-json/wp/v2/properties?per_page=100&page=${page}&_embed=wp:featuredmedia`,
      ));
    } catch { break; } // WP returns 400 past the last page
    if (!Array.isArray(batch) || batch.length === 0) break;

    for (const p of batch) {
      if (/pafilia\.com\/\w\w\//.test(p.link)) continue; // non-English translation
      if ((p.property_status || []).includes(STATUS_FOR_RENT)) continue;
      const district = (p.property_city || []).map(id => CITY_DISTRICT[cityName[id]]).find(Boolean);
      if (!district) continue; // Greece projects (Athens etc.)

      const meta = p.property_meta || {};
      const one = k => (meta[k] && meta[k][0]) || '';
      const price = Number(one('fave_property_price').replace(/[^\d]/g, '')) || null;
      if (!price) continue; // price on request
      const beds = parseInt(one('fave_property_bedrooms'), 10) || null;
      const baths = parseInt(one('fave_property_bathrooms'), 10) || null;
      const size = Math.round(Number(one('fave_property_size').replace(/[^\d.]/g, ''))) || null;
      const image = p._embedded?.['wp:featuredmedia']?.[0]?.source_url || null;
      const postedTs = p.date ? Date.parse(p.date) : null;
      const cityTxt = (p.property_city || []).map(id => cityName[id]).filter(Boolean).join(', ');

      all.push({
        source: 'Pafilia',
        title: (p.title?.rendered || 'Property for sale').replace(/&#8211;/g, '–').replace(/&amp;/g, '&'),
        price,
        priceDisplay: `€${price.toLocaleString('en-US')}`,
        location: cityTxt || district,
        district,
        image,
        images: image ? [image] : [],
        link: p.link,
        houseSqm: size,
        plotSqm: null,
        beds, baths,
        posted: postedTs ? new Date(postedTs).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }) : null,
        postedTs,
        buildYear: null,
        ref: String(p.id),
      });
    }
    if (batch.length < 100) break;
  }
  return all;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const data = await scrapePafilia();
  console.log(JSON.stringify(data, null, 1));
  console.error(`Scraped ${data.length} Pafilia listings.`);
}
