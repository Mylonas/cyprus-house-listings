/**
 * zones.mjs
 * Canonicalises the free-text `zone` field that sources publish.
 *
 * The field is typed by advertisers, so the same zone arrives a dozen ways:
 * `Η2`, `H2`, `h2`, `Η2 100%`, `H2 & H4`, `Η02`. Greek Η and Latin H are
 * different characters that render identically and both are in daily use, as
 * are `G` for Γ and a Latin `a` for the α suffix. Left alone that yields 444
 * distinct values across ~3,000 plots — the same trap the district field fell
 * into before lib/districts.mjs.
 *
 * A zone code is a family prefix, a density number and an optional variant
 * letter. Two systems issue them: Local Plans (Κα, Πα, Εβ, Βα, Γα, Δα) for the
 * towns, and the Policy Statement for the Countryside (Η, Π, Γ, Ζ, Τ, Ε, Β, Αα)
 * for everywhere else. See public/faq.html for what they mean.
 */

const LATIN_TO_GREEK = {
  A: 'Α', B: 'Β', E: 'Ε', H: 'Η', I: 'Ι', K: 'Κ', M: 'Μ', N: 'Ν',
  O: 'Ο', P: 'Ρ', T: 'Τ', X: 'Χ', Y: 'Υ', Z: 'Ζ', G: 'Γ', D: 'Δ',
};

// Some sources publish in Russian, and Cyrillic has its own set of characters
// that render as Greek ones — `Г3` arrives with U+0413, not U+0393.
const CYRILLIC_TO_GREEK = {
  А: 'Α', В: 'Β', Г: 'Γ', Е: 'Ε', З: 'Ζ', К: 'Κ', М: 'Μ',
  Н: 'Η', О: 'Ο', Р: 'Ρ', Т: 'Τ', У: 'Υ', Х: 'Χ', Д: 'Δ', П: 'Π',
};

/** Upper-case and fold Latin and Cyrillic lookalikes onto Greek. */
export function normalise(s) {
  return String(s ?? '').toUpperCase()
    .replace(/[A-Z]/g, c => LATIN_TO_GREEK[c] ?? c)
    .replace(/[Ѐ-я]/g, c => CYRILLIC_TO_GREEK[c] ?? c);
}

// Canonical spelling of each family prefix, longest first so `ΚΑ6` matches Κα
// rather than leaving a stray `Α6`, and `ΒΣΤ` beats `Β`.
const PREFIXES = [
  ['ΒΣΤ', 'Βστ'], ['ΛΖ', 'ΛΖ'], ['ΚΑ', 'Κα'], ['ΚΓ', 'ΚΓ'], ['ΤΓ', 'ΤΓ'], ['ΠΑ', 'Πα'], ['ΠΚ', 'Πκ'],
  ['ΕΑ', 'Εα'], ['ΕΒ', 'Εβ'], ['ΒΑ', 'Βα'], ['ΒΒ', 'Ββ'], ['ΒΓ', 'Βγ'], ['ΒΔ', 'Βδ'],
  ['ΒΕ', 'Βε'], ['ΓΑ', 'Γα'], ['ΓΒ', 'Γβ'], ['ΓΓ', 'Γγ'], ['ΔΑ', 'Δα'], ['ΑΑ', 'Αα'],
  ['Η', 'Η'], ['Π', 'Π'], ['Γ', 'Γ'], ['Ζ', 'Ζ'], ['Τ', 'Τ'], ['Ε', 'Ε'], ['Β', 'Β'], ['Δ', 'Δ'],
];
const CODE = new RegExp(`(?<![Α-Ω])(${PREFIXES.map(p => p[0]).join('|')})\\s?0*(\\d{1,2})\\s?([ΑΒΓΔΕ])?`, 'g');
const CANON = new Map(PREFIXES);
const VARIANT = { Α: 'α', Β: 'β', Γ: 'γ', Δ: 'δ', Ε: 'ε' };

/**
 * Family prefix → the group the filter offers.
 *
 * Grouped by what the land is for, not by which system issued the code: a
 * buyer looking for somewhere to build wants Η and Κα in one bucket even
 * though one is a Policy Statement code and the other a Local Plan one.
 */
export const GROUPS = {
  Η: 'Residential', Κα: 'Residential', Πα: 'Residential', ΚΓ: 'Residential',
  Π: 'Holiday residence', Πκ: 'Holiday residence',
  Γ: 'Agricultural / countryside', Γα: 'Agricultural / countryside',
  Ζ: 'Protection', Δα: 'Protection',
  Τ: 'Tourist',
  Εα: 'Commercial', Εβ: 'Commercial',
  Βα: 'Industrial', Ββ: 'Industrial', Βγ: 'Industrial', Β: 'Industrial',
  Βδ: 'Craft industry', Βε: 'Craft industry', Βστ: 'Craft industry', Ε: 'Craft industry',
  Γβ: 'Livestock', Γγ: 'Livestock', Δ: 'Livestock',
  Αα: 'Public uses', ΛΖ: 'Quarry', ΤΓ: 'Tourist',
};

/** Order the groups appear in the filter — commonest and most wanted first. */
export const GROUP_ORDER = [
  'Residential', 'Agricultural / countryside', 'Protection', 'Tourist', 'Commercial',
  'Holiday residence', 'Industrial', 'Craft industry', 'Livestock', 'Public uses', 'Quarry',
];

/** Family prefix of a canonical code (`Κα6` → `Κα`). */
export function familyOf(code) {
  const m = code.match(/^([Α-Ωα-ω]+?)(?=\d)/);
  return m ? m[1] : code;
}

/** Group of a canonical code (`Κα6` → `Residential`). */
export function groupOf(code) {
  return GROUPS[familyOf(code)] ?? null;
}

/**
 * Some advertisers name the use instead of coding it — `Residential`,
 * `Οικιστική`, `αγροτικη`, `Com`. That is not enough to pin a code, but it does
 * pin a group, which is what most people filter on. Matched on a stem so the
 * Greek inflections (-ή/-η/-ό/-ο/-ικό) all land.
 */
// Matched against the plain upper-cased string, NOT the Greek-folded one —
// folding would turn RESIDENTIAL into ΡΕΣΙΔΕΝΤΙΑΛ.
const WORD_STEMS = [
  [/ΟΙΚΙΣΤΙΚ|ΚΑΤΟΙΚΙΑ|RESIDENTIAL/, 'Residential'],
  [/ΑΓΡΟΤΙΚ|ΓΕΩΡΓΙΚ|ΧΩΡΑΦΙ|AGRICULTURAL|RURAL/, 'Agricultural / countryside'],
  [/ΕΜΠΟΡΙΚ|COMMERCIAL/, 'Commercial'],
  [/ΤΟΥΡΙΣΤΙΚ|TOURIST/, 'Tourist'],
  [/ΠΑΡΑΘΕΡΙΣΤΙΚ|HOLIDAY/, 'Holiday residence'],
  [/ΚΤΗΝΟΤΡΟΦΙΚ|LIVESTOCK/, 'Livestock'],
  [/ΒΙΟΤΕΧΝΙΚ/, 'Craft industry'],
  [/ΒΙΟΜΗΧΑΝΙΚ|INDUSTRIAL/, 'Industrial'],
  [/ΛΑΤΟΜΙΚ|QUARRY/, 'Quarry'],
  [/ΠΡΟΣΤΑΣΙΑ|PROTECTION/, 'Protection'],
];

// Abbreviations only safe as the whole value: `Res`, `Agr`, `Com`, `ΓΗ`.
const WORD_EXACT = {
  RES: 'Residential', AGR: 'Agricultural / countryside', AGRO: 'Agricultural / countryside',
  ΓΗ: 'Agricultural / countryside', COM: 'Commercial', TOUR: 'Tourist',
};

// A family prefix with no density number — `Εβ`, `EB`, `Ζ`, `Εβ*`. It does not
// pin a code but it does name the use, which is what the group filter needs.
const BARE_PREFIX = new RegExp(`^(${PREFIXES.map(p => p[0]).join('|')})[^Α-Ω0-9]*$`);

/**
 * A building coefficient or coverage figure, as a percentage.
 *
 * Bazaraki's `attrs__density` and `attrs__coverage` are free text and arrive in
 * every notation the trade uses for the same quantity: `60`, `60%`, `0.5`,
 * `0,50:1`, `1,40:1`, `90% (Μέγιστο Εμβαδό: 468,9 τ.μ.)`. They are the same
 * measure the planning tables express as a ratio — 0,90:1 is 90% — so
 * everything is normalised to a percent.
 *
 * The disambiguation that matters: a bare number below 5 is a ratio (`0.1` is
 * Γ3's 0,10:1, i.e. 10%), and 5 or above is already a percentage. No Cyprus
 * zone has a coefficient between 5% and 500% expressed as a bare ratio, so the
 * split is unambiguous in practice.
 *
 * @param {string} raw   the advertiser's text
 * @param {number} max   reject anything above this (coverage cannot exceed 100)
 */
export function buildingPercent(raw, max = 400) {
  const s = String(raw ?? '').trim();
  if (!s) return null;
  const m = s.match(/(\d+(?:[.,]\d+)?)/);
  if (!m) return null;
  const n = parseFloat(m[1].replace(',', '.'));
  if (!Number.isFinite(n) || n <= 0) return null;

  const isPercent = s.includes('%');
  const isRatio = /:\s*1/.test(s);
  const pct = isPercent ? n : (isRatio || n < 5) ? n * 100 : n;

  if (pct <= 0 || pct > max) return null;
  return Math.round(pct * 10) / 10;
}

/** Groups implied by words in a raw zone string, for entries carrying no code. */
export function wordGroups(raw) {
  const s = String(raw ?? '').toUpperCase().trim();
  const found = new Set();
  for (const [re, group] of WORD_STEMS) if (re.test(s)) found.add(group);
  if (WORD_EXACT[s]) found.add(WORD_EXACT[s]);

  const bare = normalise(raw).trim().match(BARE_PREFIX);
  if (bare) {
    const group = GROUPS[CANON.get(bare[1])];
    if (group) found.add(group);
  }
  return found;
}

/**
 * Every distinct zone code in a raw string, canonically spelled.
 *
 * Returns a set because split-zone plots are common and are written many ways:
 * `Η6 (67%) / Ζ3 (33%)`, `Γ3(54%), Ζ3(46%)`, `H2 & H4`. Each part is a real
 * zone over part of the parcel, so all of them are returned and the plot
 * matches a filter on any one.
 */
export function zoneCodes(raw) {
  const found = new Set();
  for (const m of normalise(raw).matchAll(CODE)) {
    const prefix = CANON.get(m[1]);
    const n = parseInt(m[2], 10);
    if (!prefix || !n || n > 15) continue;   // guards plot numbers like `2230`
    found.add(prefix + n + (m[3] ? VARIANT[m[3]] : ''));
  }
  return found;
}
