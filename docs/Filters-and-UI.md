# Filters and UI

The page is a single self-contained HTML file (`public/index.html`, generated from `src/template/page.html`). All filtering/sorting is client-side over the inlined `LISTINGS` array.

## Filters

| Filter | Control | Behaviour |
|---|---|---|
| Search | text input | Case-insensitive match on title, location, and ref code |
| District | dropdown | Exact match on the five canonical districts (Famagusta, Larnaca, Limassol, Nicosia, Paphos) |
| Min / Max price (€) | number inputs | Listings **without a price stay visible** (price-unknown auction lots aren't hidden by a price filter) |
| Min house m² | number input | Listings without a covered area are **excluded** while active |
| **Min plot m²** *(v2.1.0)* | number input | Listings without a plot size are excluded while active |
| **Max plot m²** *(v2.1.0)* | number input | Same exclusion rule; combine with min for a range |
| **Built after** *(v2.1.0)* | year input | Listings without a build year are excluded while active. Only Zyprus and BuySellCyprus publish build year — see [Data-Sources](Data-Sources.md) for why this is currently empty |
| Min bedrooms | dropdown 1+–5+ | Listings without a bedroom count are excluded while active |
| Source | chips with counts | Toggle each of the 10 sources independently |
| Reset filters | button | Restores every control and the sort to defaults |

**Null-handling rule of thumb:** price filters keep unknowns (so auctions stay visible); attribute filters (m², plot, year, beds) drop unknowns, because "at least X" is a positive claim the listing must actually make.

## Plots page filters

`public/plots.html` (from `src/template/plots.html`) carries the same shell with its own set: search, district, plot type, **planning zone**, min/max price, min/max plot m², source chips.

| Filter | Control | Behaviour |
|---|---|---|
| Plot type | dropdown | Source's own label (Agricultural, Residential, Commercial, Tourist, Plot with building, …) |
| **Planning zone** | grouped dropdown | Pick a whole use ("Any residential") or one code (`Η2`, `Κα6`, `Γ3`). A `?` next to the label links to the [zones FAQ](../public/faq.html) |

### How the zone filter copes with the field

`zone` is advertiser-typed free text — 444 distinct spellings across ~3,000 plots. `scripts/lib/zones.mjs` canonicalises it at **build time** into `l.z`, a list of codes, so the browser never sees the homoglyph tables:

- **Latin and Cyrillic folded onto Greek.** `H2`, `Η2` and `Н2` are three different characters that render identically and all three appear in the data; `G` is used for `Γ`, and a Latin `a` for the `α` suffix.
- **Family prefixes are matched longest-first**, so `ΚΑ6` resolves to `Κα6` rather than leaving a stray `Α6`.
- **Split zones yield every part.** `Η6 (67%) / Ζ3 (33%)` resolves to both, and the plot matches a filter on either — the parcel really is in both.
- **Word-only entries resolve to a group, not a code.** `Residential`, `Οικιστική`, `αγροτικη`, `Res` can't pin a density number but do name a use, so they answer "Any residential" while staying out of the per-code options.
- **Junk stays out.** Bare percentages, plot numbers (`2230`, `ΦΥΛΛ/ΣΧ: 47/33`), town names and «δεν γνωρίζω» resolve to nothing; density numbers above 15 are rejected as parse artefacts.

2,844 of the 3,046 plots that state a zone (93%) resolve to something filterable, across 107 canonical codes. The rest are unfilterable by design rather than silently mis-bucketed.

## Sorting

| Option | Order |
|---|---|
| Price: low to high *(default)* | unknown prices last |
| Price: high to low | unknown prices last |
| House size: largest first | |
| Plot size: largest first | |
| Most recently posted | uses each source's posted date where available |

## Cards

Each card shows photo (or a "No photo published" placeholder — the norm for eAuction foreclosure lots), price (with "(reserve)" suffix for auction reserves), title, location + ref, bed/bath/house-m²/plot-m² chips, build year when known, auction date for auction lots, posted date, a colour-coded source tag, and a direct link to the source listing.

Source tag colours are defined in the template (`.source-*` classes); `shortSource()` maps "A Place in the Sun" → `APITS` for its CSS class.

## Stats bar

Top of page: total listings, source count, photo count, average asking price, districts covered — all computed from the loaded data at render time.
