#!/usr/bin/env node
/**
 * scrape-cyprusrealestate.mjs
 * Scrapes Cyprus house listings from cyprus-real.estate — a large international
 * aggregator (~13k sale listings from 100+ agencies). Server-rendered HTML
 * with pagination at /property/page/N/. No browser needed.
 *
 * Listing cards carry price, beds, baths, covered area, property type,
 * location, and image — no detail-page fetch required.
 *
 * Env:
 *   CRE_MAX_PAGES - max result pages to walk, ~20 listings/page (default 100)
 */

const MAX_PAGES = Number(process.env.CRE_MAX_PAGES ?? 100);
const BASE = 'https://cyprus-real.estate';
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

const DISTRICTS = ['Nicosia', 'Limassol', 'Larnaca', 'Paphos', 'Famagusta'];
const DISTRICT_ALIASES = {
  Lefkosia: 'Nicosia', Lefkosa: 'Nicosia', Strovolos: 'Nicosia',
  Latsia: 'Nicosia', Lakatameia: 'Nicosia', Egkomi: 'Nicosia',
  Aglantzia: 'Nicosia', Geri: 'Nicosia', Tseri: 'Nicosia',
  Dali: 'Nicosia', Deftera: 'Nicosia', Kokkinotrimithia: 'Nicosia',

  Lemesos: 'Limassol', 'Agios Athanasios': 'Limassol',
  'Agios Tychonas': 'Limassol', Germasogeia: 'Limassol',
  Erimi: 'Limassol', Parekklisia: 'Limassol', Ypsonas: 'Limassol',
  Palodeia: 'Limassol', Pyrgos: 'Limassol', Souni: 'Limassol',
  Mouttagiaka: 'Limassol', Pissouri: 'Limassol', Kolossi: 'Limassol',
  Monagroulli: 'Limassol', Zakaki: 'Limassol',

  Larnaka: 'Larnaca', Dromolaxia: 'Larnaca', Oroklini: 'Larnaca',
  Kiti: 'Larnaca', Pervolia: 'Larnaca', Pyla: 'Larnaca',
  Livadia: 'Larnaca', Aradippou: 'Larnaca', Mazotos: 'Larnaca',
  Tersefanou: 'Larnaca',

  Pafos: 'Paphos', Peyia: 'Paphos', Pegeia: 'Paphos',
  Yeroskipou: 'Paphos', Geroskipou: 'Paphos', Kouklia: 'Paphos',
  Tala: 'Paphos', Polis: 'Paphos', Kissonerga: 'Paphos',
  Chloraka: 'Paphos', Konia: 'Paphos', Mesogi: 'Paphos',
  Emba: 'Paphos', Tremithousa: 'Paphos',

  Ammochostos: 'Famagusta', Paralimni: 'Famagusta',
  'Ayia Napa': 'Famagusta', 'Agia Napa': 'Famagusta',
  Sotira: 'Famagusta', Frenaros: 'Famagusta', Protaras: 'Famagusta',
  Deryneia: 'Famagusta', Liopetri: 'Famagusta',
};

function districtFrom(text) {
  if (!text) return null;
  const direct = DISTRICTS.find(d => text.includes(d));
  if (direct) return direct;
  for (const [alias, canon] of Object.entries(DISTRICT_ALIASES)) {
    if (text.includes(alias)) return canon;
  }
  return null;
}

function parsePrice(html) {
  const m = html.match(/good-item__price[^>]*>.*?€.*?([\d\s]+)/s);
  if (!m) return null;
  const n = parseInt(m[1].replace(/\s/g, ''), 10);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function parseCard(card) {
  const linkMatch = card.match(/href="https:\/\/cyprus-real\.estate\/property\/o(\d+)\/"/);
  if (!linkMatch) return null;
  const id = linkMatch[1];

  const price = parsePrice(card);
  if (!price) return null;

  const titleMatch = card.match(/title="([^"]+)"/);
  const title = titleMatch ? titleMatch[1] : 'Property for sale';

  const bedsMatch = card.match(/(\d+)\s*Bedroom/i);
  const bathsMatch = card.match(/(\d+)\s*Bathroom/i);
  const areaMatch = card.match(/([\d,.]+)\s*sq\.?\s*m/i);
  const imgMatch = card.match(/src="(https:\/\/storage1\.cyprus-real\.estate\/[^"]+)"/);
  const typeMatch = card.match(/bold-font text-secondary-300">([^<]+)</);

  const location = title.replace(/^\d+\s*bedrooms?\s*/i, '')
    .replace(/^(Apartment|Villa|Duplex|Penthouse|Townhouse|House|Maisonette)\s+in\s+/i, '')
    .replace(/\s*No\.\s*\d+$/, '')
    .trim();

  return {
    source: 'Cyprus-Real.Estate',
    title,
    price,
    priceDisplay: `€${price.toLocaleString('en-US')}`,
    location: location || 'Cyprus',
    district: districtFrom(title),
    image: imgMatch ? imgMatch[1] : null,
    link: `${BASE}/property/o${id}/`,
    houseSqm: areaMatch ? parseFloat(areaMatch[1].replace(/,/g, '')) : null,
    plotSqm: null,
    beds: bedsMatch ? parseInt(bedsMatch[1], 10) : null,
    baths: bathsMatch ? parseInt(bathsMatch[1], 10) : null,
    posted: null,
    buildYear: null,
    ref: `cre-${id}`,
  };
}

export async function scrapeCyprusRealEstate() {
  const all = [];
  const seen = new Set();
  let emptyStreak = 0;

  for (let p = 1; p <= MAX_PAGES; p++) {
    const url = p === 1
      ? `${BASE}/property/`
      : `${BASE}/property/page/${p}/`;
    let html;
    try {
      const res = await fetch(url, { headers: { 'User-Agent': UA } });
      if (!res.ok) { emptyStreak++; if (emptyStreak >= 3) break; continue; }
      html = await res.text();
    } catch { emptyStreak++; if (emptyStreak >= 3) break; continue; }

    const cards = html.split(/class="good-item\b/).slice(1);
    let added = 0;
    for (const card of cards) {
      const listing = parseCard(card);
      if (!listing || seen.has(listing.ref)) continue;
      seen.add(listing.ref);
      all.push(listing);
      added++;
    }

    if (added === 0) { emptyStreak++; if (emptyStreak >= 3) break; }
    else emptyStreak = 0;

    if (p % 50 === 0) console.log(`  … page ${p}, ${all.length} listings so far`);
    await new Promise(r => setTimeout(r, 300));
  }

  return all;
}

import { pathToFileURL } from 'node:url';
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const data = await scrapeCyprusRealEstate();
  console.log(JSON.stringify(data, null, 1));
  console.error(`Scraped ${data.length} Cyprus-Real.Estate listings.`);
}
