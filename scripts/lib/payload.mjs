/**
 * payload.mjs
 * Shared helpers for turning a listings array into the JSON blob the static
 * pages embed.
 *
 * Both pages ship as one self-contained file, so every byte of the payload is a
 * byte the visitor downloads and the browser has to parse before the first card
 * appears. Two things keep it small:
 *
 *  - `pick` keeps only the fields the template actually reads. The scrapers
 *    store far more per listing (enrichment fields, geo zoom hints, registration
 *    numbers) and that data stays in src/data/*.json where it belongs.
 *  - null/empty values are dropped rather than serialised. `"buildYear":null,`
 *    is 18 bytes; across 15k listings the nulls alone were ~1 MB.
 */

/** Keep only `fields`, dropping null/undefined/'' so absent values cost nothing. */
export function slim(listings, fields) {
  return listings.map((l) => {
    const out = {};
    for (const f of fields) {
      const v = l[f];
      if (v !== null && v !== undefined && v !== '') out[f] = v;
    }
    return out;
  });
}

/**
 * Serialise for embedding in `<script type="application/json">`.
 *
 * Escaping `<` is what makes that safe: a listing title containing `</script>`
 * would otherwise close the block early. JSON.parse turns < back into `<`,
 * so the data is unchanged.
 */
export function embed(data) {
  return JSON.stringify(data).replace(/</g, '\\u003c');
}

/**
 * Substitute `__DATA__` in a template.
 *
 * String.replace expands `$&`, `$'` and friends in the replacement, and listing
 * URLs contain `$` often enough for that to silently corrupt links — a function
 * replacement is inserted verbatim.
 */
export function inject(template, json) {
  return template.replace('__DATA__', () => json);
}
