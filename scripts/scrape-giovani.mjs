#!/usr/bin/env node
/**
 * scrape-giovani.mjs
 * Giovani Homes (giovani.com.cy / giovani.cy) — major developer on the east
 * coast (Protaras/Paralimni/Ayia Napa) with stock in Larnaca and Nicosia too.
 * WordPress + WP Residence theme: the `estate_property` post type is public on
 * the REST API, but WP Residence keeps price/size/beds in postmeta that the
 * API does not expose — so we list via REST (sale-side, non-shop) and then
 * fetch each property page, whose "listing_detail" blocks carry Price,
 * Property Size, Property Lot Size, Bedrooms and Bathrooms.
 *
 * Env:
 *   GIOVANI_CONCURRENCY - parallel detail-page fetches (default 8)
 */
import { pathToFileURL } from 'node:url';

const ORIGIN = 'https://www.giovani.com.cy';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
const CONCURRENCY = Number(process.env.GIOVANI_CONCURRENCY ?? 8);

const ACTION_SALES = 64;   // property_action_category: Sales
const CATEGORY_SHOP = 172; // property_category: Shop (commercial — exclude)

const CITY_DISTRICT = {
  Paralimni: 'Famagusta', Protaras: 'Famagusta', Pernera: 'Famagusta',
  'Ayia Napa': 'Famagusta', Kapparis: 'Famagusta', 'Cape Greco': 'Famagusta',
  Famagusta: 'Famagusta', Larnaca: 'Larnaca', Aradippou: 'Larnaca', Nicosia: 'Nicosia',
};

async function getJson(url) {
  const res = await fetch(url, { headers: { 'User-Agent': UA } });
  if (!res.ok) throw new Error(`${res.status} for ${url}`);
  return res.json();
}

function parseDetail(html) {
  const block = label =>
    (html.match(new RegExp(`<strong>${label}\\s*:?\\s*</strong>\\s*(?:<span>)?\\s*([^<]+)`)) || [])[1];
  const num = v => (v ? Math.round(Number(v.replace(/[^\d.]/g, ''))) || null : null);
  const priceTxt = block('Price');
  return {
    price: priceTxt && /\d/.test(priceTxt) ? Number(priceTxt.replace(/[^\d]/g, '')) : null,
    houseSqm: num(block('Property Size')),
    plotSqm: num(block('Property Lot Size')),
    beds: num(block('Bedrooms')),
    baths: num(block('Bathrooms')),
  };
}

export async function scrapeGiovani() {
  const cityName = {};
  for (const c of await getJson(`${ORIGIN}/wp-json/wp/v2/property_city?per_page=100`)) {
    cityName[c.id] = c.name;
  }

  const posts = [];
  for (let page = 1; page <= 20; page++) {
    let batch;
    try {
      batch = await getJson(`${ORIGIN}/wp-json/wp/v2/estate_property?per_page=100&page=${page}&_embed=wp:featuredmedia`);
    } catch { break; }
    if (!Array.isArray(batch) || batch.length === 0) break;
    posts.push(...batch);
    if (batch.length < 100) break;
  }

  const sale = posts.filter(p =>
    (p.property_action_category || []).includes(ACTION_SALES)
    && !(p.property_category || []).includes(CATEGORY_SHOP));

  const all = [];
  for (let i = 0; i < sale.length; i += CONCURRENCY) {
    const chunk = sale.slice(i, i + CONCURRENCY);
    const details = await Promise.all(chunk.map(p =>
      fetch(p.link, { headers: { 'User-Agent': UA } })
        .then(r => (r.ok ? r.text() : ''))
        .then(parseDetail)
        .catch(() => ({}))));
    chunk.forEach((p, j) => {
      const d = details[j];
      if (!d || !d.price) return; // price on request / fetch failure
      const cityTxt = (p.property_city || []).map(id => cityName[id]).filter(Boolean).join(', ');
      const district = (p.property_city || []).map(id => CITY_DISTRICT[cityName[id]]).find(Boolean) || null;
      const image = p._embedded?.['wp:featuredmedia']?.[0]?.source_url || null;
      const postedTs = p.date ? Date.parse(p.date) : null;
      all.push({
        source: 'Giovani Homes',
        title: (p.title?.rendered || 'Property for sale').replace(/&#8211;/g, '–').replace(/&amp;/g, '&'),
        price: d.price,
        priceDisplay: `€${d.price.toLocaleString('en-US')}`,
        location: cityTxt || 'Cyprus',
        district,
        image,
        images: image ? [image] : [],
        link: p.link,
        houseSqm: d.houseSqm,
        plotSqm: d.plotSqm,
        beds: d.beds,
        baths: d.baths,
        posted: postedTs ? new Date(postedTs).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }) : null,
        postedTs,
        buildYear: null,
        ref: String(p.id),
      });
    });
  }
  return all;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const data = await scrapeGiovani();
  console.log(JSON.stringify(data, null, 1));
  console.error(`Scraped ${data.length} Giovani Homes listings.`);
}
