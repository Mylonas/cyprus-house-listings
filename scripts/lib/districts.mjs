/**
 * districts.mjs
 * Resolves a listing's district to one of Cyprus' five, or null.
 *
 * Sources disagree about what "district" means: some publish the real district,
 * some publish the town, some publish the neighbourhood, and a few publish the
 * listing title because their location field was empty and the scraper fell back
 * to it. Left alone that produced districts like "Studio", "Property" and
 * "Sea caves luxury villas", which silently vanish from the district filter on
 * the page and from the `npm run analyze` breakdown.
 *
 * Rather than patch each scraper, resolution happens once, centrally, in
 * scrape-all.mjs. The order below is deliberate: an explicit district beats a
 * town lookup, and location beats title because titles mention roads and
 * landmarks in other districts ("10 min from Limassol").
 *
 *   1. `district` if it is already a district (or a known spelling of one)
 *   2. a district named in `location`
 *   3. a district named in `title`
 *   4. a district named in `link` (home.cy encodes it in the slug)
 *   5. a known town in any of those fields -> its parent district
 *   6. null — better an honest gap than a wrong district
 */

export const DISTRICTS = ['Nicosia', 'Limassol', 'Larnaca', 'Paphos', 'Famagusta'];

/** Alternative spellings and transliterations, lowercased. */
const CANON = {
  pafos: 'Paphos',
  paphos: 'Paphos',
  lefkosia: 'Nicosia',
  nicosia: 'Nicosia',
  ammochostos: 'Famagusta',
  famagusta: 'Famagusta',
  fagamusta: 'Famagusta', // seen in the wild, a source's own typo
  lemesos: 'Limassol',
  limassol: 'Limassol',
  larnaka: 'Larnaca',
  larnaca: 'Larnaca',
};

/**
 * Town/village/suburb -> parent district, lowercased.
 * Only entries confirmed against listings in this dataset, plus the obvious
 * neighbours. Ambiguous names are deliberately absent: leaving a listing
 * unresolved is cheaper to fix later than silently filing it wrong.
 */
const TOWNS = {
  // Paphos
  geroskipou: 'Paphos', tremithousa: 'Paphos', 'coral bay': 'Paphos', koloni: 'Paphos',
  tsada: 'Paphos', kouklia: 'Paphos', chlorakas: 'Paphos', tala: 'Paphos',
  'ayia marina chrysochous': 'Paphos', 'neo chorio': 'Paphos', polemi: 'Paphos',
  mesogi: 'Paphos', peyia: 'Paphos', pegeia: 'Paphos', kissonerga: 'Paphos',
  emba: 'Paphos', empa: 'Paphos', konia: 'Paphos', 'sea caves': 'Paphos',
  'kato paphos': 'Paphos', pomos: 'Paphos', latchi: 'Paphos', polis: 'Paphos',
  kathikas: 'Paphos', thrinia: 'Paphos', koili: 'Paphos', 'agia marinouda': 'Paphos',

  // Limassol
  moniatis: 'Limassol', moni: 'Limassol', pyrgos: 'Limassol', prodromos: 'Limassol',
  'agios athanasios': 'Limassol', pareklissia: 'Limassol', pareklisia: 'Limassol',
  parekklisia: 'Limassol', 'agios tychonas': 'Limassol', trimiklini: 'Limassol',
  polemidia: 'Limassol', 'kato polemidia': 'Limassol', 'kato polemidion': 'Limassol',
  germasogeia: 'Limassol', germasoyia: 'Limassol', mouttagiaka: 'Limassol',
  pissouri: 'Limassol', episkopi: 'Limassol', ypsonas: 'Limassol', mesa: 'Limassol',
  'mesa geitonia': 'Limassol', palodia: 'Limassol', platres: 'Limassol',
  souni: 'Limassol', 'pera pedi': 'Limassol', dierona: 'Limassol', apsiou: 'Limassol',

  // Nicosia
  latsia: 'Nicosia', lakatameia: 'Nicosia', lakatamia: 'Nicosia', ekali: 'Nicosia',
  dali: 'Nicosia', strovolos: 'Nicosia', aglantzia: 'Nicosia', aglandjia: 'Nicosia',
  engomi: 'Nicosia', geri: 'Nicosia', tseri: 'Nicosia', anthoupoli: 'Nicosia',
  anthoupolis: 'Nicosia', pallouriotissa: 'Nicosia',
  kokkinotrimithia: 'Nicosia', deftera: 'Nicosia', psimolofou: 'Nicosia',

  // Larnaca
  pervolia: 'Larnaca', meneou: 'Larnaca', aradippou: 'Larnaca', anglisides: 'Larnaca',
  kiti: 'Larnaca', oroklini: 'Larnaca', dromolaxia: 'Larnaca', zygi: 'Larnaca',
  livadia: 'Larnaca', xylofagou: 'Larnaca', alethriko: 'Larnaca', tersefanou: 'Larnaca',
  mazotos: 'Larnaca', 'apostolos loucas': 'Larnaca', kellia: 'Larnaca',
  'kato lefkara': 'Larnaca', lefkara: 'Larnaca',

  // Famagusta
  vrysoulles: 'Famagusta', protaras: 'Famagusta', 'agia napa': 'Famagusta',
  'ayia napa': 'Famagusta', paralimni: 'Famagusta', frenaros: 'Famagusta',
  deryneia: 'Famagusta', sotira: 'Famagusta', avgorou: 'Famagusta',
  liopetri: 'Famagusta', achna: 'Famagusta', 'kapparis': 'Famagusta',
  'pernera': 'Famagusta', 'agia thekla': 'Famagusta', 'ayia thekla': 'Famagusta',
};

const DISTRICT_RE = new RegExp(`\\b(${Object.keys(CANON).join('|')})\\b`, 'i');

/** A district named anywhere in a free-text field. */
function districtIn(text) {
  if (!text) return null;
  const m = DISTRICT_RE.exec(String(text));
  return m ? CANON[m[1].toLowerCase()] : null;
}

/** A known town named anywhere in a free-text field. */
function townIn(text) {
  if (!text) return null;
  const t = String(text).toLowerCase();
  // Longest names first so "kato polemidia" wins over "polemidia".
  for (const town of Object.keys(TOWNS).sort((a, b) => b.length - a.length)) {
    if (new RegExp(`\\b${town.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`).test(t)) {
      return TOWNS[town];
    }
  }
  return null;
}

/**
 * @param {{district?: string|null, location?: string|null, title?: string|null, link?: string|null}} listing
 * @returns {string|null} one of DISTRICTS, or null when nothing reliable is available
 */
export function resolveDistrict({ district, location, title, link } = {}) {
  const exact = district && CANON[String(district).trim().toLowerCase()];
  if (exact) return exact;

  // `district` is not a district — it may still be a town, or junk from a
  // scraper falling back to the title. Either way it is a text field now.
  for (const field of [location, title, link]) {
    const hit = districtIn(field);
    if (hit) return hit;
  }
  for (const field of [district, location, title, link]) {
    const hit = townIn(field);
    if (hit) return hit;
  }
  return null;
}
