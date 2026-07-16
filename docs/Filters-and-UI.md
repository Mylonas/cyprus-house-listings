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
