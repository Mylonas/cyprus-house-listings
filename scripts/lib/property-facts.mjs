/**
 * property-facts.mjs
 * Pulls property characteristics out of eAuction Cyprus document text — the
 * legal notice (form FR.08), the "additional information" / "ΠΡΟΣΘΕΤΕΣ
 * ΠΛΗΡΟΦΟΡΙΕΣ" sheet, and the detail page's free-text block. Documents come in
 * Greek and English, sometimes both, so every label has both spellings.
 *
 * Two quirks drive the design:
 *
 *  1. PDF text extraction shreds spacing — "13,50" arrives as "1 3 , 5 0",
 *     "50%" as "5 0 %", "REGISTRATION" as "REG ISTRATION". So labelled fields
 *     are matched against a *compacted* view of the text (all whitespace
 *     removed), which makes the shredding irrelevant.
 *  2. Build year is rarely stated. What the valuer writes is an age — "the
 *     property is about 38 years old" / "ηλικίας περίπου 38 ετών" — so we
 *     derive the year from the age relative to the document's own date.
 */

const NOW_YEAR = new Date().getUTCFullYear();

/** Cyprus/Greek number formatting: "." groups thousands, "," is the decimal. */
function num(s) {
  if (!s) return null;
  let t = String(s).replace(/\s/g, '');
  if (t.includes('.') && t.includes(',')) t = t.replace(/\./g, '').replace(',', '.');
  else if (/,\d{1,2}$/.test(t)) t = t.replace(/\./g, '').replace(',', '.');
  else t = t.replace(/[.,](?=\d{3}\b)/g, '').replace(',', '.');
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}

/** Whitespace-free view — immune to PDF letter/digit shredding. */
function compact(text) {
  return (text || '').replace(/ /g, ' ').replace(/\s+/g, '');
}

/** Whitespace-normalised view — for prose patterns, where word gaps matter. */
function flat(text) {
  return (text || '').replace(/ /g, ' ').replace(/\s+/g, ' ');
}

const UNIT = '(?:\\(?(?:sq\\.?m\\.?|τ\\.?μ\\.?|m2|m²|m\\.?|μ\\.?)\\)?)?';

/**
 * Find every "<label> <number>" hit in the compacted text. Only punctuation and
 * an optional unit may sit between label and number, so a field whose value is
 * blank can't accidentally swallow the next field's number.
 */
function labelledNumbers(cText, labels, { unit = true, maxGap = 4 } = {}) {
  const out = [];
  for (const label of labels) {
    const re = new RegExp(`${label}${unit ? UNIT : ''}[^0-9A-Za-zΆ-ώ]{0,${maxGap}}(\\d[\\d.,]*)`, 'gi');
    for (const m of cText.matchAll(re)) {
      const v = num(m[1]);
      if (v != null) out.push(v);
    }
  }
  return out;
}

function pick(values, min, max) {
  const ok = values.filter(v => v >= min && v <= max);
  return ok.length ? Math.max(...ok) : null;
}

// Spelled-out counts that show up in valuer prose, EN + GR (all inflections).
const WORD_COUNTS = {
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  ενός: 1, ενα: 1, ένα: 1, μιας: 1, μία: 1, δύο: 2, δυο: 2, τριών: 3, τρία: 3, τρια: 3,
  τεσσάρων: 4, τέσσερα: 4, πέντε: 5, πεντε: 5, έξι: 6, εξι: 6, επτά: 7, εφτά: 7,
  οκτώ: 8, οχτώ: 8, εννέα: 9, εννιά: 9, δέκα: 10,
};

function countBefore(fText, nounPattern) {
  const re = new RegExp(`(\\d{1,2}|[A-Za-zΆ-ώ]+)\\s+(?:${nounPattern})`, 'gi');
  const hits = [];
  for (const m of fText.matchAll(re)) {
    const tok = m[1].toLowerCase();
    const v = /^\d+$/.test(tok) ? Number(tok) : WORD_COUNTS[tok];
    if (v >= 1 && v <= 12) hits.push(v);
  }
  if (hits.length) return Math.max(...hits);
  // "…and a bathroom with a toilet" — the room is described but never counted.
  return new RegExp(`(?:${nounPattern})`, 'i').test(fText) ? 1 : null;
}

/**
 * @param {string} text     document or page text (Greek, English, or both)
 * @param {object} [opts]
 * @param {number} [opts.referenceYear] year the document was written — an age
 *        of "38 years" means a different build year in a 2019 notice than a
 *        2026 one. Defaults to the current year.
 * @returns {object} only the fields actually found; every value is a number
 *        except planningZone.
 */
export function extractFacts(text, { referenceYear = NOW_YEAR } = {}) {
  if (!text || text.length < 20) return {};
  const c = compact(text);
  const f = flat(text);
  const facts = {};

  // --- areas ---------------------------------------------------------------
  const plot = pick(labelledNumbers(c, [
    'Landarea', 'Landsize', 'Plotarea', 'Areaofland',
    'Εμβαδ[όο]νγης', 'Έκτασηγης', 'Εμβαδ[όο]ντεμαχ[ίι]ου', 'Εμβαδ[όο]νοικοπ[έε]δου',
  ]), 20, 2_000_000);
  if (plot) facts.plotSqm = Math.round(plot);

  const covered = pick(labelledNumbers(c, [
    'Buildingarea', 'Coveredarea', 'Builtarea', 'Areaofbuilding',
    'Εμβαδ[όο]νκτ[ηι]ρ[ίι]ου', 'Εμβαδ[όο]νοικοδομ[ήη]ς', 'Καλυμμ[έε]νοεμβαδ[όο]ν',
    'Εμβαδ[όο]νκατοικ[ίι]ας', 'Δομημ[έε]νοεμβαδ[όο]ν',
    // "enclosed space" — the covered area as the valuer and the land registry
    // both write it.
    'enclosedspace(?:area)?(?:of)?', 'Κλειστ[όο][ςύ]?χ[ώω]ρο[ςυ]', 'εμβαδ[όο]ν?κλειστ[ώω]νχ[ώω]ρων',
  ]), 10, 20_000);
  if (covered) facts.houseSqm = Math.round(covered);

  const verandas = pick(labelledNumbers(c, ['Καλυμμ[έε]νεςβερ[άα]ντες', 'coveredverandas?']), 1, 2000);
  if (verandas) facts.verandaSqm = Math.round(verandas);

  // --- planning ------------------------------------------------------------
  const floors = pick(labelledNumbers(c, ['No\\.?[Oo]f[Ff]loors', 'Numberoffloors', 'Αρ\\.?Ορ[όο]φων', 'Αριθμ[όο]ςΟρ[όο]φων']), 1, 60);
  if (floors) facts.floors = Math.round(floors);

  const density = pick(labelledNumbers(c, ['Max\\.?Density', 'Μ[έε]γιστηΔ[όο]μηση']), 1, 1000);
  if (density) facts.maxDensityPct = density;

  const coverage = pick(labelledNumbers(c, ['Max\\.?Coverage', 'Μ[έε]γιστηΚ[άα]λυψη']), 1, 100);
  if (coverage) facts.maxCoveragePct = coverage;

  const height = pick(labelledNumbers(c, ['Max\\.?Height', 'Μ[έε]γιστο[ΎΥ]ψος']), 2, 100);
  if (height) facts.maxHeightM = height;

  // The label appears twice in these forms — once as the table's section title,
  // once against the value — so take the first hit that looks like a zone code
  // ("Κα4", "Η2") rather than the neighbouring "District" heading.
  for (const m of c.matchAll(/(?:Townplanningzone|Πολεοδομικ[ήη][ZΖ]?[ώω]νη)[:\-]?([A-Za-zΆ-ώ]{1,4}\d{0,2})/gi)) {
    const v = m[1];
    if (/^(?:District|Επαρχ|Municip|Δ[ήη]μος)/i.test(v)) continue;
    if (!/\d/.test(v) && v.length > 3) continue;
    facts.planningZone = v;
    break;
  }

  // --- build year ----------------------------------------------------------
  // Stated outright ...
  const yearPatterns = [
    /(?:built|constructed|erected|completed)\s*(?:in|around|about|circa)?\s*(?:the\s*year\s*)?((?:19|20)\d{2})/i,
    /(?:year\s*of\s*(?:construction|completion)|construction\s*year)\D{0,12}((?:19|20)\d{2})/i,
    /[έε]τος\s*(?:κατασκευ[ήη]ς|αποπερ[άα]τωσης|[άα]δειας\s*οικοδομ[ήη]ς)\D{0,6}((?:19|20)\d{2})/i,
    /κατασκευ[άα]σ[τθ]ηκε\s*(?:το\s*[έε]τος\s*|το\s*|περ[ίι]που\s*το\s*)?((?:19|20)\d{2})/i,
    /ανεγ[έε]ρ[θτ]ηκε\s*(?:το\s*)?((?:19|20)\d{2})/i,
  ];
  for (const re of yearPatterns) {
    const m = f.match(re);
    const y = m ? Number(m[1]) : null;
    if (y && y >= 1900 && y <= NOW_YEAR + 2) { facts.buildYear = y; facts.buildYearSource = 'stated'; break; }
  }
  // ... or, far more often, given as an age.
  if (!facts.buildYear) {
    const ageRe = [
      /(?:about|approximately|approx\.?|around|circa)?\s*(\d{1,3})\s*years?\s*old/i,
      /age(?:d)?\s*(?:of)?\s*(?:about|approximately|approx\.?)?\s*(\d{1,3})\s*years?/i,
      /ηλικ[ίι]ας\s*(?:περ[ίι]που\s*)?(\d{1,3})\s*(?:ετ[ώω]ν|χρ[όο]νων|χρον[ώω]ν)/i,
      /(\d{1,3})\s*(?:ετ[ώω]ν|χρ[όο]νων)\s*(?:περ[ίι]που\s*)?(?:ηλικ[ίι]ας)?/i,
    ];
    for (const re of ageRe) {
      const m = f.match(re);
      const age = m ? Number(m[1]) : null;
      if (age && age >= 1 && age <= 120) {
        facts.buildYear = referenceYear - age;
        facts.buildYearSource = 'age';
        break;
      }
    }
  }

  // --- rooms ---------------------------------------------------------------
  const beds = countBefore(f, 'bedrooms?|υπνοδωματ[ίι]ω?ν?|υπνοδωμ[άα]τι[αοου]ν?|κρεβατοκ[άα]μαρ[εαοω]ν?ς?');
  if (beds) facts.beds = beds;
  const baths = countBefore(f, 'bathrooms?|shower\\s*rooms?|μπ[άα]νι[αοου]ν?|λουτρ[άαοώ]ν?');
  if (baths) facts.baths = baths;

  return facts;
}

/**
 * Merge fact sets by source trust: later sources only fill gaps left by earlier
 * ones. Call as mergeFacts(mostTrusted, ..., leastTrusted).
 */
export function mergeFacts(...sets) {
  const out = {};
  for (const s of sets) {
    if (!s) continue;
    for (const [k, v] of Object.entries(s)) {
      if (v == null || v === '') continue;
      if (out[k] == null) out[k] = v;
    }
  }
  return out;
}
