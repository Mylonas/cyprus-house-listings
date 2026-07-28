/**
 * eauction-list.mjs
 * The one place that knows eauction-cy.com's ad-list contract.
 *
 * `POST /Home/HomeListAuctions` is the site's own search XHR and, unlike every
 * HTML page on the domain, it is **not** behind the Imperva challenge — which is
 * why the house scraper, the plot scraper and the detail harvester can all get
 * their ad list with a plain fetch, from CI included. Everything past the list
 * (detail pages, attachments, photos) is challenged; that is the harvester's
 * problem, not this module's.
 *
 * Three consumers share this: scrape-eauction.mjs (houses),
 * scrape-eauction-plots.mjs (plots/land) and harvest-eauction.mjs (details).
 */

export const BASE = 'https://www.eauction-cy.com';

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

/** Every property subtype the portal sells (id -> its own dropdown's label). */
export const SUBTYPES = {
  5: 'Residence', 6: 'Other Commercial Property', 7: 'Store', 8: 'Office',
  9: 'Parking', 10: 'Warehouse', 11: 'Industrial Building', 12: 'Plot',
  13: 'Plot with building', 14: 'Land', 15: 'Land with building',
};

/**
 * Auctions you can still act on. 8 (Suspended), 9 (Conducted) and 10
 * (Cancelled) are the dead archive — thousands of lots, no longer advertised —
 * and are deliberately excluded. In practice nearly everything live sits in 3.
 */
export const BIDDABLE_STATUSES = {
  3: 'Posted',
  5: 'Finalized List of Eligible Bidders',
  6: 'Ready to be Conducted',
  7: 'Open',
};

// Site district (all-caps, some Greek-transliterated) -> the canonical name used
// across the other sources and the filter UI.
const DISTRICT_CANON = {
  LIMASSOL: 'Limassol', NICOSIA: 'Nicosia', PAFOS: 'Paphos',
  FAMAGUSTA: 'Famagusta', LARNACA: 'Larnaca',
};

export function titleCase(s) {
  return (s || '')
    .toLowerCase()
    .replace(/\b([a-zα-ω])/g, c => c.toUpperCase())
    .replace(/\s+/g, ' ')
    .trim();
}

export function canonDistrict(raw) {
  if (!raw) return 'Other';
  return DISTRICT_CANON[raw] || titleCase(raw);
}

/** dd/mm/yyyy -> epoch ms, for the pages' "recently posted" sort. */
export function parseDate(dmy) {
  const m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(dmy || '');
  if (!m) return null;
  const t = Date.UTC(Number(m[3]), Number(m[2]) - 1, Number(m[1]));
  return Number.isFinite(t) ? t : null;
}

function body(pageNumber, statusId, subTypeId) {
  return JSON.stringify({
    auctionDateFrom: '', auctionDateTo: '',
    auctionCreationDateFrom: '', auctionCreationDateTo: '',
    offerValueFrom: '', offerValueTo: '',
    hastenerName: '', auctionCode: '',
    AuctionStatusId: statusId,
    sortAscending: 'true', sortingFieldId: '1',
    pageNumber: String(pageNumber),
    AuctionSubTypeId: String(subTypeId),
    extendedFilter1: '', extendedFilter2: '',
    notApprovedForeignBidderId: '', selectedCountryNumericCode: '0',
    lang: 'en-US',
  });
}

/**
 * One result card -> its raw fields. A card with no Unique Code is not a card.
 * Parsing is regex over the returned HTML blocks: if this ever starts returning
 * nothing, suspect the `AList-*` class names changed, not that we're blocked.
 */
export function parseCard(block) {
  const m = re => (block.match(re) || [])[1] || null;
  const code = m(/Unique Code<\/span>[\s\S]*?AList-BoxTextBlue500">\s*([A-Z0-9-]+)/);
  if (!code) return null;

  const priceRaw = m(/AList-BoxTextPrice">\s*([\d.,]+)\s*€/);
  const district = m(/District:\s*([A-Z]+)/);
  const community = m(/Municipality \/ Parish \/ Community:\s*([^<]+)/);
  const communityClean = titleCase((community || '').replace(/^D\.\s*/, ''));
  const districtName = canonDistrict(district);

  return {
    code,
    link: m(/AList-BoxFooterMore"\s+href="([^"]+)"/),
    status: m(/AList-BoxheaderLeft[\s\S]*?AList-BoxTextBlueBold">\s*([^<]+?)\s*</),
    price: priceRaw ? Number(priceRaw.replace(/\./g, '')) : null,
    auctionDate: m(/DateIcon">\s*(\d{2}\/\d{2}\/\d{4})/),
    posted: m(/Date of Posting<\/span>[\s\S]*?AList-BoxTextBlue500">\s*(\d{2}\/\d{2}\/\d{4})/),
    objectType: m(/Object to be auctioned:\s*([^<]+)/)?.trim() || null,
    lender: m(/Mortgage Lender:\s*([^<]+)/)?.trim() || null,
    district: districtName,
    community: communityClean,
    location: communityClean ? `${communityClean}, ${districtName}` : districtName,
  };
}

/**
 * Every currently advertised ad for the given subtypes, deduplicated by code.
 *
 * @param {object} [opts]
 * @param {number[]} [opts.subTypeIds] default: all eleven
 * @param {number[]} [opts.statusIds]  default: the biddable four
 * @param {number}   [opts.maxPages]   safety cap on pages per subtype+status
 * @param {number}   [opts.delayMs]    politeness delay between pages
 */
export async function listAds({
  subTypeIds = Object.keys(SUBTYPES).map(Number),
  statusIds = Object.keys(BIDDABLE_STATUSES).map(Number),
  maxPages = 40,
  delayMs = 400,
} = {}) {
  const ads = new Map();

  for (const subTypeId of subTypeIds) {
    for (const statusId of statusIds) {
      for (let p = 1; p <= maxPages; p++) {
        let res;
        try {
          res = await fetch(`${BASE}/Home/HomeListAuctions`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json; charset=UTF-8',
              'User-Agent': UA,
              'X-Requested-With': 'XMLHttpRequest',
              Referer: `${BASE}/en/Home/HlektronikoiPleistiriasmoi?type=${subTypeId}`,
            },
            body: body(p, statusId, subTypeId),
          });
        } catch {
          break;
        }
        if (!res.ok) break;

        const blocks = (await res.text()).split(/AList-BoxContainer/).slice(1);
        if (blocks.length === 0) break;

        let added = 0;
        for (const block of blocks) {
          const card = parseCard(block);
          // A code can appear under more than one status filter; keep the first.
          if (!card || ads.has(card.code)) continue;
          ads.set(card.code, { ...card, subTypeId, subType: SUBTYPES[subTypeId] || String(subTypeId) });
          added++;
        }

        // Fewer than a full page of cards means we've reached the last one.
        if (blocks.length < 20 || added === 0) break;
        await new Promise(r => setTimeout(r, delayMs));
      }
    }
  }

  return [...ads.values()];
}
