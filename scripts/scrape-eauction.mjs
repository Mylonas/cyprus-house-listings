#!/usr/bin/env node
/**
 * scrape-eauction.mjs
 * Scrapes upcoming "Residence" (AuctionSubTypeId=5) auctions from
 * eauction-cy.com, the official Cyprus Banks Association foreclosure portal.
 *
 * How this avoids the Imperva/Incapsula block
 * -------------------------------------------
 * The HTML pages (search results, auction detail) sit behind an Imperva JS
 * challenge that headless browsers can't clear, which is why the old
 * Playwright-based scraper returned nothing from CI. The site's XHR endpoint
 * `POST /Home/HomeListAuctions`, however, is NOT challenged and returns the
 * same result cards as JSON-embedded HTML — so we hit that directly with a
 * plain fetch. No browser required, works from GitHub Actions.
 *
 * We request only the biddable statuses (Posted / Ready / Open / Finalized
 * list) — i.e. auctions you can still act on — rather than the full archive of
 * ~1,300 already-conducted lots.
 *
 * Per-listing detail (areas, build year, photos, rooms) only lives on the
 * challenge-protected detail pages and their PDF/Word attachments, so it can't
 * be fetched here. Instead we merge a committed enrichment cache,
 * `src/data/eauction-details.json` (keyed by auction code), produced weekly by
 * `harvest-eauction.mjs` through a challenge-clearing browser. Listings without
 * a cache entry still appear with their core fields (price, location, date,
 * link).
 *
 * Env:
 *   EAUCTION_MAX_PAGES - safety cap on pages walked per status (default 10)
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import { listAds, parseDate, BASE } from './lib/eauction-list.mjs';

const MAX_PAGES = Number(process.env.EAUCTION_MAX_PAGES ?? 15);
const RESIDENCE = 5;

function loadEnrichment() {
  try {
    const __dirname = path.dirname(fileURLToPath(import.meta.url));
    const p = path.resolve(__dirname, '../src/data/eauction-details.json');
    return JSON.parse(readFileSync(p, 'utf-8'));
  } catch {
    return {};
  }
}

export async function scrapeEauction() {
  const enrichment = loadEnrichment();
  const ads = await listAds({ subTypeIds: [RESIDENCE], maxPages: MAX_PAGES });

  return ads.map(i => {
    const enr = enrichment[i.code] || {};
    const lastSeg = i.community.split(',').pop().trim() || i.district;
    return {
      source: 'eAuction Cyprus',
      title: `Residence auction — ${lastSeg}`,
      price: i.price,
      priceDisplay: i.price ? `€${i.price.toLocaleString('en-US')} (reserve price)` : null,
      location: i.location,
      district: i.district,
      image: enr.image ?? null,
      images: enr.images ?? null,
      link: i.link || `${BASE}/en/Home/HlektronikoiPleistiriasmoi?type=5`,
      houseSqm: enr.houseSqm ?? null,
      plotSqm: enr.plotSqm ?? null,
      beds: enr.beds ?? null,
      baths: enr.baths ?? null,
      posted: i.posted,
      // The card's posting date is exact, so give the page's "recent" sort a
      // real timestamp instead of making it parse the string.
      postedTs: parseDate(i.posted),
      buildYear: enr.buildYear ?? null,
      ref: i.code,
      auctionDate: i.auctionDate,
      status: i.status,
      // Harvested from the auction's detail page and its attachments — see
      // harvest-eauction.mjs:
      share: enr.share ?? null,               // Εγγεγραμμένο συμφέρον (e.g. 1/1, 33/118)
      propertyType: enr.propertyType ?? null, // Είδος (Residence / Apartment / Plot …)
      registration: enr.registration ?? null, // Αριθμός Εγγραφής
      floors: enr.floors ?? null,
      planningZone: enr.planningZone ?? null,
      address: enr.address ?? null,
    };
  });
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const data = await scrapeEauction();
  console.log(JSON.stringify(data, null, 1));
  console.error(`Scraped ${data.length} eAuction listings.`);
}
