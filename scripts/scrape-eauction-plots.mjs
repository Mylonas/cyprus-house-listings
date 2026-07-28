#!/usr/bin/env node
/**
 * scrape-eauction-plots.mjs
 * The plots/land counterpart of scrape-eauction.mjs: foreclosure auctions of
 * land rather than houses, from eauction-cy.com.
 *
 * These were missing from the plots pipeline because the portal was believed to
 * have no biddable land subtype. It has four, and they are the bulk of its
 * inventory — measured 2026-07-27, 347 of ~420 live ads:
 *
 *   12 Plot (6)   13 Plot with building (109)   14 Land (174)   15 Land with building (58)
 *
 * Access is the same as the house scraper's: the unprotected
 * `POST /Home/HomeListAuctions` XHR endpoint (see lib/eauction-list.mjs), so
 * this runs from CI with a plain fetch and no browser.
 *
 * Plot area, photos, planning zone and the rest live only on the
 * challenge-protected detail pages, so they come from the enrichment cache that
 * harvest-eauction.mjs builds (src/data/eauction-details.json). A newly posted
 * lot therefore appears here with price, location and auction date immediately,
 * and gains its area and photos after the next harvest.
 *
 * Env:
 *   EAUCTION_PLOT_SUBTYPES - comma-separated subtype ids (default 12,13,14,15)
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import { listAds, parseDate, BASE } from './lib/eauction-list.mjs';

const SUBTYPE_IDS = (process.env.EAUCTION_PLOT_SUBTYPES || '12,13,14,15').split(',').map(Number);

function loadEnrichment() {
  try {
    const __dirname = path.dirname(fileURLToPath(import.meta.url));
    return JSON.parse(readFileSync(path.resolve(__dirname, '../src/data/eauction-details.json'), 'utf-8'));
  } catch {
    return {};
  }
}

// The portal's subtype is the honest plot type: "Land with building" says more
// than forcing it into Bazaraki's residential/agricultural vocabulary would.
// The registry's own Είδος (ΟΙΚΟΠΕΔΟ / ΧΩΡΑΦΙ / ...) is more specific still, so
// prefer it when the harvest captured one and it is land-like.
const REGISTRY_PLOT_TYPES = new Set(['Building plot', 'Field', 'Land', 'Parcel']);

export async function scrapeEauctionPlots() {
  const enrichment = loadEnrichment();
  const ads = await listAds({ subTypeIds: SUBTYPE_IDS });

  return ads.map(ad => {
    const enr = enrichment[ad.code] || {};
    const postedTs = parseDate(ad.posted);
    const lastSeg = ad.community.split(',').pop().trim() || ad.district;
    const plotType = REGISTRY_PLOT_TYPES.has(enr.propertyType) ? enr.propertyType : ad.subType;

    return {
      source: 'eAuction Cyprus',
      kind: 'plot',
      title: `${ad.subType} auction — ${lastSeg}`,
      price: ad.price,
      priceDisplay: ad.price ? `€${ad.price.toLocaleString('en-US')} (reserve price)` : null,
      location: ad.location,
      district: ad.district,
      image: enr.image ?? null,
      images: enr.images ?? null,
      link: ad.link || `${BASE}/en/Home/HlektronikoiPleistiriasmoi?type=${ad.subTypeId}`,
      // "with building" lots really do carry a house; keep its area rather than
      // discarding it just because this is the plots page.
      houseSqm: enr.houseSqm ?? null,
      plotSqm: enr.plotSqm ?? null,
      plotType,
      zone: enr.planningZone ?? null,
      beds: enr.beds ?? null,
      baths: enr.baths ?? null,
      posted: ad.posted,
      postedTs,
      buildYear: enr.buildYear ?? null,
      lat: null,
      lng: null,
      geoZoom: null,
      ref: ad.code,
      auctionDate: ad.auctionDate,
      status: ad.status,
      // Harvested from the detail page and its attachments:
      share: enr.share ?? null,               // Εγγεγραμμένο συμφέρον (1/1, 33/118)
      registration: enr.registration ?? null, // Αριθμός Εγγραφής
      address: enr.address ?? null,
    };
  });
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const data = await scrapeEauctionPlots();
  console.log(JSON.stringify(data, null, 1));
  const withArea = data.filter(d => d.plotSqm).length;
  console.error(`Scraped ${data.length} eAuction plot/land auctions (${withArea} with a plot area from the harvest cache).`);
}
