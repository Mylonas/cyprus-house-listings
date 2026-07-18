#!/usr/bin/env node
/**
 * scrape-realting.mjs
 * Scrapes Cyprus house listings from realting.com (international aggregator /
 * reseller). Server-rendered HTML, no browser needed — plain fetch + regex,
 * same approach the site tolerates for the nicosia-house-prices project.
 *
 * ?currency=EUR forces all prices to EUR. Prices >= ~1M render abbreviated
 * ("€1,09M", European decimal comma) and are expanded to an approximate int.
 *
 * Env:
 *   REALTING_MAX_PAGES - result pages to walk, 30 listings/page (default 12)
 */

const MAX_PAGES = Number(process.env.REALTING_MAX_PAGES ?? 20);
const BASE = 'https://realting.com';
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

const DISTRICTS = ['Nicosia', 'Limassol', 'Larnaca', 'Paphos', 'Famagusta'];
// Municipalities/communities Realting uses as the card location, mapped to
// their district. Covers everything seen in practice; unknowns stay null.
const DISTRICT_ALIASES = {
  Lefkosia: 'Nicosia', Pafos: 'Paphos', Ammochostos: 'Famagusta',
  Peyia: 'Paphos', Pegeia: 'Paphos', Yeroskipou: 'Paphos', Geroskipou: 'Paphos',
  Kouklia: 'Paphos', Tala: 'Paphos', Polis: 'Paphos', Kissonerga: 'Paphos',
  Chloraka: 'Paphos', Argaka: 'Paphos', Konia: 'Paphos', Kamares: 'Paphos',
  Mesogi: 'Paphos', Emba: 'Paphos', Tremithousa: 'Paphos', Pomos: 'Paphos',
  Paralimni: 'Famagusta', 'Ayia Napa': 'Famagusta', 'Agia Napa': 'Famagusta',
  Sotira: 'Famagusta', Frenaros: 'Famagusta', Protaras: 'Famagusta',
  Avgorou: 'Famagusta', Deryneia: 'Famagusta', Liopetri: 'Famagusta',
  'Agios Tychonas': 'Limassol', 'Agiou Tychona': 'Limassol',
  Germasogeia: 'Limassol', Erimi: 'Limassol', 'Agiou Athanasiou': 'Limassol',
  Parekklisia: 'Limassol', Ypsonas: 'Limassol', Palodeia: 'Limassol',
  'Pyrgou Lemesou': 'Limassol', Pyrgos: 'Limassol', Souni: 'Limassol',
  Mouttagiaka: 'Limassol', Pissouri: 'Limassol', Kolossi: 'Limassol',
  Dromolaxia: 'Larnaca', Oroklini: 'Larnaca', Kiti: 'Larnaca',
  Pervolia: 'Larnaca', Pyla: 'Larnaca', Livadia: 'Larnaca',
  Aradippou: 'Larnaca', Mazotos: 'Larnaca', Tersefanou: 'Larnaca',
  Latsia: 'Nicosia', Lakatameia: 'Nicosia', Strovolos: 'Nicosia',
  Egkomi: 'Nicosia', Aglantzia: 'Nicosia', Geri: 'Nicosia', Tseri: 'Nicosia',
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

function parsePrice(card) {
  // Full form first: €647,000
  const full = card.match(/€\s?([\d,]{4,})(?![\d,]*M)/);
  if (full) return parseInt(full[1].replace(/,/g, ''), 10);
  // Abbreviated: €1,09M (European decimal comma)
  const abbr = card.match(/€\s?(\d+)(?:[.,](\d+))?M/);
  if (abbr) return Math.round(parseFloat(`${abbr[1]}.${abbr[2] ?? 0}`) * 1_000_000);
  return null; // non-EUR or unpriced card
}

export async function scrapeRealting() {
  const all = [];
  const seen = new Set();

  for (let p = 1; p <= MAX_PAGES; p++) {
    const url = `${BASE}/cyprus/houses?currency=EUR${p > 1 ? `&page=${p}` : ''}`;
    const res = await fetch(url, { headers: { 'User-Agent': UA } });
    if (!res.ok) break;
    const doc = await res.text();

    let added = 0;
    for (const card of doc.split(/teaser-tile/).slice(1)) {
      const idMatch = card.match(/data-id="(\d+)"/) ||
        card.match(/href="https:\/\/realting\.com\/cyprus\/property\/(\d+)"/);
      if (!idMatch || seen.has(idMatch[1])) continue;
      seen.add(idMatch[1]);
      added++;

      const titleMatch = card.match(/teaser-title[^>]*>(.{0,300}?)<\/(?:a|div)>/s);
      const title = titleMatch
        ? titleMatch[1].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()
        : 'House for sale';
      const locMatch = card.match(/>([^<>]{3,60}?,\s*Cyprus)</);
      const location = locMatch ? locMatch[1].trim() : 'Cyprus';
      const price = parsePrice(card);
      if (!price) continue; // skip non-EUR-priced premium tiles
      const areaMatch = card.match(/([\d,]+)\s*m²/);
      const bedMatch = title.match(/(\d+)\s*bedroom/i);
      const imgMatch = card.match(/(?:data-src|src)="(https:\/\/realting\.com\/uploads\/[^"]+\.(?:webp|jpe?g|png))"/);

      all.push({
        source: 'Realting',
        title,
        price,
        priceDisplay: `€${price.toLocaleString('en-US')}`,
        location,
        district: districtFrom(location),
        image: imgMatch ? imgMatch[1] : null,
        link: `${BASE}/cyprus/property/${idMatch[1]}`,
        houseSqm: areaMatch ? parseInt(areaMatch[1].replace(/,/g, ''), 10) : null,
        plotSqm: null,
        beds: bedMatch ? parseInt(bedMatch[1], 10) : null,
        baths: null,
        posted: null,
        buildYear: null,
        ref: idMatch[1],
      });
    }

    if (added === 0) break;
    await new Promise(r => setTimeout(r, 600));
  }

  await enrichFromDetails(all);
  return all;
}

// Result cards give covered area + beds but no plot, baths or year. The detail
// page carries a characteristics table ("Land area", "Total area", "Bathrooms",
// "The year of construction") plus a JSON-LD RealEstateListing block. Fetch each
// detail page and fill the gaps; the table is the primary source, JSON-LD the
// fallback. (Realting exposes no listing date.)
async function enrichFromDetails(listings) {
  const tableVal = (h, label) => {
    const m = h.match(new RegExp(`>${label}</div>\\s*<div>\\s*([\\d,]+)`, 'i'));
    if (!m) return null;
    const n = Number(m[1].replace(/,/g, ''));
    return Number.isFinite(n) && n > 0 ? n : null;
  };

  const CONCURRENCY = 5;
  let i = 0;
  async function worker() {
    while (i < listings.length) {
      const l = listings[i++];
      try {
        const res = await fetch(l.link, { headers: { 'User-Agent': UA } });
        if (!res.ok) continue;
        const h = await res.text();

        let ld = null;
        for (const m of h.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)) {
          try { const j = JSON.parse(m[1]); if (j.floorSize || j.yearBuilt) { ld = j; break; } } catch { /* skip */ }
        }

        l.plotSqm = tableVal(h, 'Land area');
        if (l.houseSqm == null) l.houseSqm = tableVal(h, 'Total area') ?? (ld?.floorSize?.value ?? null);
        l.baths = tableVal(h, 'Bathrooms') ?? (ld?.numberOfFullBathrooms ?? null);
        const year = tableVal(h, 'The year of construction') ?? (ld?.yearBuilt ? Number(ld.yearBuilt) : null);
        l.buildYear = year && year > 1800 && year < 2100 ? year : null;
      } catch {
        /* leave fields as-is on a failed detail fetch */
      }
      await new Promise(r => setTimeout(r, 150));
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
}

import { pathToFileURL } from 'node:url';
if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const data = await scrapeRealting();
  console.log(JSON.stringify(data, null, 1));
  console.error(`Scraped ${data.length} Realting listings.`);
}
