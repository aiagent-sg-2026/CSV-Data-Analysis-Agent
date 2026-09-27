# Pi Browser Spike Context

## 2026-09-27 request and direction

- The user decided to keep the React application and assigned Vanilla removal to another AI agent. This spike is isolated from that cleanup and changes no React application or `original/` files.
- The user requested a browser-first Pi harness test, an `.env.example` for their own key, and `gpt-5.4-mini` with medium reasoning as defaults. On follow-up, they supplied the local key and asked to continue the live test.
- The product requirement is no Node.js application server. This spike uses Node/Vite only to install and bundle browser JavaScript; the built page was served by Python static HTTP during verification.

## Completed steps

1. Created an isolated worktree and nested `spikes/pi-browser/` application.
2. Installed official `@earendil-works/pi-agent-core` and `@earendil-works/pi-ai` version 0.87.1. The Pi model catalog resolves `openai/gpt-5.4-mini` with reasoning support; the Agent state requests `medium`.
3. Added a browser-safe `summarize_rows` tool. A deterministic mock provider makes Pi call it, passes the result back through the real agent loop, and produces a second-turn answer. Live mode uses the Pi OpenAI provider when a user key is supplied locally.
4. Added `.env.example`, ignored local `.env*` files except `.env.example`, localhost-only live mode, and a build guard that refuses to bundle a configured key. The user's `.env` was moved to `.env.local` without reading or printing its key; an additional `.env copy` remains ignored and untouched.
5. Verified `npm ci`, focused test, Vite build, dependency audit, build-key refusal, and the built page running from static HTTP in a real browser. Browser mock timeline showed two model turns, one tool result, and `sum=250`; browser console had no errors.
6. Verified a live browser request on local Vite: Pi used the OpenAI provider with the page showing `gpt-5.4-mini` and `medium`, called `summarize_rows` on the first turn, consumed its result on the second turn, and returned `Total sales: 250`. The page showed `live mode completed.`

## Remaining verification and constraints

- This is a harness feasibility spike. It does not connect Pi to the React application's CSV state, history, or existing tool registry.
- Browser-direct API use exposes a user-supplied key to that browser. Never deploy a client bundle with a key; a product-owned hidden key would require a proxy.

## 2026-09-27 CSV follow-up

- The user chose option B: load a real CSV in the browser spike and test a more complex task. The current React source package lives under `frontend/` in the main checkout and is being changed by another agent; this spike remains on its isolated branch.
- Added Papa Parse file intake with a header row, malformed-row rejection, a 10 MB file limit, and browser-held rows. Pi now has `inspect_dataset` and `aggregate_rows` tools. Inspection returns only schema and counts; aggregation returns at most 30 groups. The CSV file and raw rows are not sent to OpenAI.
- Used a 3,767-row public subset of `demo-data/singapore-hdb-resale-prices.csv` (2023–2024, ANG MO KIO and BEDOK, 3 ROOM and 4 ROOM). The full 83 MB / 982,589-row demo file is intentionally outside the in-memory spike limit.
- Browser mock mode completed three model turns with inspection and aggregation. Live Pi used one inspection and four aggregate calls to compare ANG MO KIO resale prices by year and flat type. Its counts and averages matched an independent Python CSV calculation: 2023 3 ROOM 539 / 400821.96; 2023 4 ROOM 344 / 648895.54; 2024 3 ROOM 571 / 427025.01; 2024 4 ROOM 308 / 652776.02.
- Four focused tests pass, including quoted CSV fields, malformed and duplicate headers, file limit, grouped filters, and the Pi mock loop. The production build passed with the local key file temporarily withheld and restored afterward; an exact-key scan found the key absent from the bundle. The dependency audit reported no vulnerabilities.
- A local development module was accidentally printed in a task tool result during verification and included the configured API key. The key was not committed or added to documentation. The user was told to revoke and replace it after this test.

## 2026-09-27 full-file streaming follow-up

- The user chose option C: extend the browser spike to test the complete large CSV. The work remained on the isolated `codex/pi-browser-spike` branch; no React source or root deployment files were edited.
- Replaced whole-file `File.text()` and persistent `rows[]` with Papa Parse local-file scans in 2 MB chunks. Initial intake retains the File reference, schema, row count, and at most 200 sample rows. Each `aggregate_rows` call rescans the File. The spike file limit is now 128 MB. This keeps the full 83 MB HDB demo file usable without retaining nearly one million row objects.
- The mock provider now chooses a numeric column named in the question when available. This avoided using a numeric `block` identifier as the benchmark metric. The aggregation uses compensated summation to avoid cumulative floating-point drift on large totals.
- The complete `demo-data/singapore-hdb-resale-prices.csv` loaded in a keyless browser build: 83,320,843 bytes and 982,589 data rows. The real Pi mock loop performed dataset inspection and a full-file `resale_price` aggregate. Browser output was 982,589 numeric values, sum `333251601035.21`, average `339156.66`; an independent Python CSV/Decimal scan matched all three values.
- A separate 2,097,174-byte CSV with a quoted newline and comma crossing the 2 MB chunk boundary loaded as two rows; the Pi mock tool reported `amount` sum 30. Five focused tests pass. The production build passed with the local key withheld; an exact-key scan found it absent from the bundle. The final browser test used Python static HTTP and no key or OpenAI request.
- Repeated scans trade lower resident data memory for repeated file I/O. The spike still has a 128 MB file limit and is not integrated with the React application's CSV intake or DuckDB engine. A previous in-app browser tab on port 5173 retained old code; the full-file test used fresh ports and the final static build.
