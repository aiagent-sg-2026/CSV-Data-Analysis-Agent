# Demo datasets

Every file here is raw Singapore government open data from [data.gov.sg](https://data.gov.sg), made available under the [Singapore Open Data Licence version 1.0](https://data.gov.sg/open-data-licence). None of it contains personal data. The values are not cleaned, so the analysis agent sees the same quirks a real user's export would have.

`catalog.json` is the list the app reads: one entry per demo with its file, four-language title, description and suggested question, theme, row, column and byte counts, load speed, and source. `frontend/tests/demoDataCatalog.test.ts` checks that every entry matches its file.

| Catalog id | File | Theme | Rows × columns | Shape | Source (publisher, data.gov.sg dataset) | Licence |
| --- | --- | --- | --- | --- | --- | --- |
| `sg-hdb-resale-sample` | `singapore-hdb-resale-prices-sample.csv` | housing | 4,988 × 11 | Transactions, every 197th row of the full file | Housing & Development Board, [Resale Flat Prices](https://data.gov.sg/collections/189/view) (5 era datasets) | Singapore Open Data Licence |
| `sg-hdb-resale-full` | `singapore-hdb-resale-prices.csv` | housing | 982,589 × 11 | Transactions, 1990 to latest month (slow) | Housing & Development Board, [Resale Flat Prices](https://data.gov.sg/collections/189/view) (5 era datasets) | Singapore Open Data Licence |
| `sg-graduate-employment` | `sg-graduate-employment.csv` | jobs | 1,550 × 12 | Long table with mean and median salaries, `na` / `N.A.`, footnote markers, some mojibake | Ministry of Education, [Graduate Employment Survey - NTU, NUS, SIT, SMU, SUSS & SUTD](https://data.gov.sg/datasets/d_3c55210de27fcccda2ed0c63fdd2b352/view) | Singapore Open Data Licence |
| `sg-coe-bidding` | `sg-coe-bidding.csv` | transport | 1,990 × 7 | Time series per bidding exercise and category; some counts quoted with thousands separators | Land Transport Authority, [COE Bidding Results / Prices](https://data.gov.sg/datasets/d_69b3380ad7e51aff3a7dcc84eba52b8a/view) | Singapore Open Data Licence |
| `sg-business-formation` | `sg-business-formation.csv` | business | 16 × 442 | Aggregated wide cross-tab: industries × months (newest first), Total row plus indented industries | Singapore Department of Statistics (source: ACRA), [Formation Of All Business Entities By Industry, Monthly](https://data.gov.sg/datasets/d_739ef616852dcc1ecdb4a1c8bd0dcc8b/view) | Singapore Open Data Licence |
| `sg-resident-unemployment` | `sg-resident-unemployment.csv` | jobs | 768 × 5 | Long cross-tab: year × sex × age × highest qualification | Ministry of Manpower, [Resident Unemployment Rate By Age, Highest Qualification Attained And Sex](https://data.gov.sg/datasets/d_79699e0bd51d2d8cee7fb3f6d29dc7c4/view) | Singapore Open Data Licence |
| `sg-visitor-arrivals` | `sg-visitor-arrivals.csv` | tourism | 62 × 225 | Wide table with a three-level indented hierarchy (total, regions, countries) × months | Singapore Department of Statistics (source: Singapore Tourism Board), [International Visitor Arrivals By Place Of Residence, Monthly](https://data.gov.sg/datasets/d_d1c33009b674dcf70b8e8c790b793f28/view) | Singapore Open Data Licence |
| `sg-hdb-median-rent` | `sg-hdb-median-rent.csv` | housing | 9,507 × 4 | Quarterly panel by town and flat type; rents mix numbers with `na` and `-`; latest 60 quarters only | Housing & Development Board, [Median Rent By Town And Flat Type](https://data.gov.sg/datasets/d_23000a00c52996c55106084ed0339566/view) | Singapore Open Data Licence |
| `sg-public-transport-ridership` | `sg-public-transport-ridership.csv` | transport | 11 × 37 | Wide indicator table: metrics with different units × years, gaps as `na` | Singapore Department of Statistics (source: Land Transport Authority), [Public Transport Operation And Ridership, Annual](https://data.gov.sg/datasets/d_ba615ec4cc5d9f5b7800ad82057f36f1/view) | Singapore Open Data Licence |

Row counts are data rows, excluding the header, as of the committed files. Refreshing from data.gov.sg can change them; the catalog and manifests are rebuilt at the same time.

## HDB resale prices

`singapore-hdb-resale-prices.csv` is a reproducible union of the five official HDB resale-price CSV datasets published by data.gov.sg, covering January 1990 through the latest available month.

Run `npm run demo:hdb:refresh` to download the current source files and rebuild the CSV and its integrity manifest.

The refresh script does not clean, normalize, deduplicate, filter, or sort source values. It appends the official era files in chronological era order. Older datasets do not publish `remaining_lease`; the union CSV leaves that field empty for those rows. See `singapore-hdb-resale-prices.manifest.json` for dataset IDs, coverage, row counts, source hashes, and the final output hash.

`singapore-hdb-resale-prices-sample.csv` is a small fast-start sample of the full file: every 197th data row (about 5,000 rows, first row included), copied byte for byte in source order. It is not cleaned, so it keeps every era's quirks. Run `npm run demo:hdb:sample` after refreshing the full file to rebuild it; the manifest's `sample` block records its method, row count and SHA-256.

## Singapore open-data demos

Run `npm run demo:sg:open-data` from the repository root (Node.js 22) to download the seven `sg-*` datasets again and rebuild their CSVs, their `<id>.manifest.json` files and `catalog.json`. The script is `scripts/make-sg-open-data-demos.mjs`; catalog titles, descriptions and suggested questions are edited there, not in `catalog.json`. It downloads and checks every dataset before it writes anything, retries when the public API rate-limits it, and reuses an `HTTPS_PROXY` setting if one is present.

- **Transformation policy.** Rows are the exact lines served by the data.gov.sg download API, copied byte for byte in source order. Nothing is cleaned, normalized, renamed, reshaped, deduplicated or sorted.
- **Sampling.** Only `sg-hdb-median-rent` is sampled. The full source has about 13,300 rows since 2005-Q2, above the 10,000-row demo target, so the file keeps every row whose quarter is one of the latest 60 distinct quarters in the source and drops older quarters. The other six files are byte-identical to the download. The script stops if any output exceeds 1.5 MB or 10,000 rows, rather than trimming silently.
- **Integrity.** Each manifest records the transformation policy, the sampling rule, a short shape note, the output fields, row and column counts, size and SHA-256, and for the source: the dataset id, title, publisher, data.gov.sg page, API URLs, `lastUpdatedAt`, coverage, source row count, size and SHA-256. Manifests store the source's `lastUpdatedAt` rather than a run timestamp, so two runs against the same source revision produce identical files.
- **Attribution.** Each manifest's `licence.attribution` field holds the attribution sentence required by the Singapore Open Data Licence for that dataset.
