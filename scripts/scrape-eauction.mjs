#!/usr/bin/env node
/**
 * scrape-eauction.mjs
 * Scrapes "Residence" (type=5) property auctions from eauction-cy.com,
 * the official Cyprus Banks Association foreclosure auction portal.
 *
 * Note: eauction-cy.com does not publish property photos or floor sizes on
 * the search results page — only price, dates, district/community and the
 * auction's unique code. Full details (incl. area) require opening each
 * auction's notice PDF, which this script does not download.
 *
 * Env:
 *   EAUCTION_MAX_PAGES - safety cap on pages to walk (default 10)
 */
import { chromium } from 'playwright';

const MAX_PAGES = Number(process.env.EAUCTION_MAX_PAGES ?? 10);
const BASE = 'https://www.eauction-cy.com';

export async function scrapeEauction() {
  const browser = await chromium.launch();
  const page = await browser.newPage();

  const all = [];
  let totalPages = 1;

  for (let p = 1; p <= Math.max(totalPages, 1) && p <= MAX_PAGES; p++) {
    const url = `${BASE}/en/Home/HlektronikoiPleistiriasmoi?sortAsc=true&sortId=1&page=${p}&type=5`;
    await page.goto(url, { waitUntil: 'networkidle' });

    if (p === 1) {
      const pageInfo = await page.evaluate(() => {
        const m = document.body.innerText.match(/Page \d+ of (\d+)/);
        return m ? Number(m[1]) : 1;
      });
      totalPages = pageInfo;
    }

    const items = await page.evaluate(() => {
      const text = document.body.innerText;
      const blocks = text.split(/Status:\s*/).slice(1);
      return blocks.map(block => {
        const status = (block.match(/^(\S+(?:\s\S+)?)/) || [])[1] || null;
        const price = (block.match(/([\d.,]+\s?€)/) || [])[1] || null;
        const auctionDate = (block.match(/Auction Date:\s*\n?(\d{2}\/\d{2}\/\d{4})/) || [])[1] || null;
        const postedDate = (block.match(/Date of Posting:\s*(\d{2}\/\d{2}\/\d{4})/) || [])[1] || null;
        const district = (block.match(/District:\s*([A-Z]+)/) || [])[1] || null;
        const community = (block.match(/Municipality \/ Parish \/ Community:\s*(.+)/) || [])[1] || null;
        const code = (block.match(/Unique Code:\s*([A-Z0-9-]+)/) || [])[1] || null;
        return { status, price, auctionDate, postedDate, district, community, code };
      }).filter(i => i.code);
    });

    all.push(...items);
  }

  await browser.close();

  return all.map(i => ({
    source: 'eAuction Cyprus',
    title: `Residential Property Auction – ${(i.community || '').split(',').pop().trim()}`,
    price: i.price ? Number(i.price.replace('€', '').replace(/\./g, '').trim()) : null,
    priceDisplay: i.price ? `${i.price} (reserve price)` : null,
    location: `${(i.community || '').trim()}, ${(i.district || '').replace(/^./, c => c.toUpperCase()).toLowerCase().replace(/^./, c=>c.toUpperCase())}`,
    district: i.district ? i.district[0] + i.district.slice(1).toLowerCase() : 'Other',
    image: null,
    link: `${BASE}/en/Home/HlektronikoiPleistiriasmoi?type=5`,
    houseSqm: null,
    plotSqm: null,
    beds: null,
    baths: null,
    posted: i.postedDate,
    buildYear: null,
    ref: i.code,
    auctionDate: i.auctionDate,
    status: i.status,
  }));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const data = await scrapeEauction();
  console.log(JSON.stringify(data, null, 1));
  console.error(`Scraped ${data.length} eAuction listings.`);
}
