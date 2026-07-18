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
 * Per-listing detail (plot area, photos) only lives on the challenge-protected
 * detail pages, so it can't be fetched here. Instead we merge a committed
 * enrichment cache, `src/data/eauction-details.json` (keyed by auction code),
 * harvested out-of-band through a real browser. Listings without a cache entry
 * still appear with their core fields (price, location, date, link).
 *
 * Env:
 *   EAUCTION_MAX_PAGES - safety cap on pages walked per status (default 10)
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

const MAX_PAGES = Number(process.env.EAUCTION_MAX_PAGES ?? 15);
const BASE = 'https://www.eauction-cy.com';
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

// Biddable / not-yet-concluded auction statuses (id -> label from the site's
// status dropdown). Conducted/Cancelled/Suspended are intentionally excluded.
const BIDDABLE_STATUSES = {
  3: 'Posted',
  6: 'Ready to be Conducted',
  7: 'Open',
  5: 'Finalized List of Eligible Bidders',
};

// Site district (all-caps, some Greek-transliterated) -> canonical name used
// across the other sources / the filter UI.
const DISTRICT_CANON = {
  LIMASSOL: 'Limassol', NICOSIA: 'Nicosia', PAFOS: 'Paphos',
  FAMAGUSTA: 'Famagusta', LARNACA: 'Larnaca',
};

function titleCase(s) {
  return (s || '')
    .toLowerCase()
    .replace(/\b([a-zα-ω])/g, c => c.toUpperCase())
    .replace(/\s+/g, ' ')
    .trim();
}

function loadEnrichment() {
  try {
    const __dirname = path.dirname(fileURLToPath(import.meta.url));
    const p = path.resolve(__dirname, '../src/data/eauction-details.json');
    return JSON.parse(readFileSync(p, 'utf-8'));
  } catch {
    return {};
  }
}

function buildBody(pageNumber, statusId) {
  return JSON.stringify({
    auctionDateFrom: '', auctionDateTo: '',
    auctionCreationDateFrom: '', auctionCreationDateTo: '',
    offerValueFrom: '', offerValueTo: '',
    hastenerName: '', auctionCode: '',
    AuctionStatusId: statusId,
    sortAscending: 'true', sortingFieldId: '1',
    pageNumber: String(pageNumber),
    AuctionSubTypeId: '5',
    extendedFilter1: '', extendedFilter2: '',
    notApprovedForeignBidderId: '', selectedCountryNumericCode: '0',
    lang: 'en-US',
  });
}

function parseContainer(block) {
  const m = re => (block.match(re) || [])[1] || null;

  const status = m(/AList-BoxheaderLeft[\s\S]*?AList-BoxTextBlueBold">\s*([^<]+?)\s*</);
  const priceRaw = m(/AList-BoxTextPrice">\s*([\d.,]+)\s*€/);
  const auctionDate = m(/DateIcon">\s*(\d{2}\/\d{2}\/\d{4})/);
  const district = m(/District:\s*([A-Z]+)/);
  const community = m(/Municipality \/ Parish \/ Community:\s*([^<]+)/);
  const posted = m(/Date of Posting<\/span>[\s\S]*?AList-BoxTextBlue500">\s*(\d{2}\/\d{2}\/\d{4})/);
  const code = m(/Unique Code<\/span>[\s\S]*?AList-BoxTextBlue500">\s*([A-Z0-9-]+)/);
  const link = m(/AList-BoxFooterMore"\s+href="([^"]+)"/);

  if (!code) return null;

  const price = priceRaw ? Number(priceRaw.replace(/\./g, '')) : null;
  const communityClean = titleCase((community || '').replace(/^D\.\s*/, ''));
  const canonDistrict = district ? (DISTRICT_CANON[district] || titleCase(district)) : 'Other';
  const lastSeg = communityClean.split(',').pop().trim() || canonDistrict;

  return {
    code, status, price, auctionDate, posted, link,
    district: canonDistrict,
    location: communityClean ? `${communityClean}, ${canonDistrict}` : canonDistrict,
    title: `Residence auction — ${lastSeg}`,
  };
}

export async function scrapeEauction() {
  const enrichment = loadEnrichment();
  const byCode = new Map();

  for (const statusId of Object.keys(BIDDABLE_STATUSES)) {
    for (let p = 1; p <= MAX_PAGES; p++) {
      let res;
      try {
        res = await fetch(`${BASE}/Home/HomeListAuctions`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json; charset=UTF-8',
            'User-Agent': UA,
            'X-Requested-With': 'XMLHttpRequest',
            Referer: `${BASE}/en/Home/HlektronikoiPleistiriasmoi?type=5`,
          },
          body: buildBody(p, Number(statusId)),
        });
      } catch {
        break;
      }
      if (!res.ok) break;
      const html = await res.text();

      const blocks = html.split(/AList-BoxContainer/).slice(1);
      if (blocks.length === 0) break;

      let added = 0;
      for (const block of blocks) {
        const item = parseContainer(block);
        if (!item) continue;
        // A code can legitimately appear once; keep the first (biddable) hit.
        if (byCode.has(item.code)) continue;
        byCode.set(item.code, item);
        added++;
      }

      // Fewer than a full page of cards means we've reached the last page.
      if (blocks.length < 20 || added === 0) break;
      await new Promise(r => setTimeout(r, 400));
    }
  }

  return [...byCode.values()].map(i => {
    const enr = enrichment[i.code] || {};
    return {
      source: 'eAuction Cyprus',
      title: i.title,
      price: i.price,
      priceDisplay: i.price ? `€${i.price.toLocaleString('en-US')} (reserve price)` : null,
      location: i.location,
      district: i.district,
      image: enr.image ?? null,
      link: i.link || `${BASE}/en/Home/HlektronikoiPleistiriasmoi?type=5`,
      houseSqm: enr.houseSqm ?? null,
      plotSqm: enr.plotSqm ?? null,
      beds: null,
      baths: null,
      posted: i.posted,
      buildYear: null,
      ref: i.code,
      auctionDate: i.auctionDate,
      status: i.status,
    };
  });
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const data = await scrapeEauction();
  console.log(JSON.stringify(data, null, 1));
  console.error(`Scraped ${data.length} eAuction listings.`);
}
