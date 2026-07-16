#!/usr/bin/env node
/**
 * scrape-apits.mjs
 * Scrapes Cyprus listings from aplaceinthesun.com (international reseller
 * portal). The canonical path grammar /property/cyprus/page/N is plain
 * server-rendered GET — no browser needed. Cards carry schema.org microdata.
 *
 * Cards show an agent-currency price plus the EUR figure in brackets
 * ("£644,206 [€740,000]") — the bracketed EUR value is what we keep.
 *
 * Env:
 *   APITS_MAX_PAGES - result pages to walk, 28 listings/page (default 10)
 */

const MAX_PAGES = Number(process.env.APITS_MAX_PAGES ?? 10);
const BASE = 'https://www.aplaceinthesun.com';
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

export async function scrapeAPITS() {
  const all = [];
  const seen = new Set();
  let totalPages = MAX_PAGES;

  for (let p = 1; p <= Math.min(MAX_PAGES, totalPages); p++) {
    const res = await fetch(`${BASE}/property/cyprus/page/${p}`, {
      headers: { 'User-Agent': UA },
    });
    if (!res.ok) break;
    const doc = await res.text();

    const tp = doc.match(/data-total-num-pages="(\d+)"/);
    if (tp) totalPages = parseInt(tp[1], 10);

    // Each card region begins at its addressLocality meta ("Cyprus, Paphos,
    // Kato Paphos"), followed by the details block with link, name and price.
    const cards = doc.split(/addressLocality'? content="/).slice(1);
    let added = 0;
    for (const card of cards) {
      const locality = card.slice(0, card.indexOf('"'));
      const linkMatch = card.match(/href="(\/property\/details\/(ap\d+)\/[^"]+)"/);
      if (!linkMatch || seen.has(linkMatch[2])) continue;
      seen.add(linkMatch[2]);
      added++;

      const nameMatch = card.match(/itemprop="name" content="([^"]+)"/);
      const title = nameMatch ? nameMatch[1] : 'Property for sale';
      // Bracketed EUR first ("£644,206 [€740,000]"), bare € as fallback
      const eurMatch = card.match(/\[€([\d,]+)\]/) || card.match(/€([\d,]+)/);
      if (!eurMatch) continue;
      const price = parseInt(eurMatch[1].replace(/,/g, ''), 10);

      const parts = locality
        .split(',').map(s => s.trim()).filter(s => s && s !== 'Cyprus');
      const bedMatch = title.match(/(\d+)\s*Bed/i);
      const imgMatch = card.match(/data-src="(https:\/\/www\.aplaceinthesun\.com\/property\/media\/images\/[^"]+)"/);

      all.push({
        source: 'A Place in the Sun',
        title,
        price,
        priceDisplay: `€${price.toLocaleString('en-US')}`,
        location: parts.join(', ') || 'Cyprus',
        district: parts[0] === 'Pafos' ? 'Paphos' : parts[0] || null,
        image: imgMatch ? imgMatch[1] : null,
        link: `${BASE}${linkMatch[1]}`,
        houseSqm: null, // not shown on result cards
        plotSqm: null,
        beds: bedMatch ? parseInt(bedMatch[1], 10) : null,
        baths: null,
        posted: null,
        buildYear: null,
        ref: linkMatch[2],
      });
    }

    if (added === 0) break;
    await new Promise(r => setTimeout(r, 600));
  }

  return all;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const data = await scrapeAPITS();
  console.log(JSON.stringify(data, null, 1));
  console.error(`Scraped ${data.length} A Place in the Sun listings.`);
}
