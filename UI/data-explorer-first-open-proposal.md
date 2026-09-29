# Data Explorer first-open proposal

**Status: DRAFT for review.** The SVG is illustrative; its row values are mock values, not live query results. This design is not approved.

## What the screenshots show

- On mobile, the header and collapsed engine-status row are followed by the query builder. Its template chips, column chooser, sort controls, and limit push the result below the first viewport.
- On desktop, the sidebar reports `Recorded 0`, `No query selected`, and `Columns 0`; the main result section starts below the query builder. The screenshots show an empty first-open state, not a query or engine failure.
- The current React modal places `DatabaseWorkspaceQueryComposer` before the result table. With no selected query activity, the table has no rows. The query layer already defaults to 25 rows and caps workspace queries at 250.

## Proposed experience

Put the prepared dataset summary and a bounded local row preview first. Open the full template builder only when the user taps **Refine query**; keep **Query history** one tap away. On desktop, give the preview the primary column and keep history/details in the side column. Reuse the current white/slate cards, compact uppercase labels, navy action button, and 44 px controls.

On a fresh dataset with no current result for its load version, run the existing `preview_rows` template locally with its 25-row default. Show a loading status, then the returned rows and an explicit count such as “25 of 90 rows.” Keep the existing execution limit and read-only contract. The automatic preview is transient UI state: do not append it to `queryHistory`, inflate the recorded-query count, or replace an existing valid active result. When the user runs a template or selects history, display that result as usual and preserve the history entry.

The preview does not call an AI provider. Provider failures therefore do not block it or turn its status into an error; keep any provider error in its existing analysis surface. Failed local preview attempts should use a separate error state and retry action, not appear as completed history entries.

## Unavailable and failure states

- While the local query session is binding, show `Preparing local preview…` with `role="status"` and avoid an empty-result message.
- If the query engine is unavailable, say so with `role="alert"`; keep the prepared filename and 90-row count visible. When `csvData.data` is available, show a clearly labelled, unfiltered raw preview capped at 25 rows, and explain that query controls are paused. Offer **Retry local session** and an expandable engine reason. Never label raw rows as a successful query or silently switch engines.
- If raw rows are not available, preserve any previous result as stale with its source version and show a specific unavailable message plus retry. Do not render a blank table that looks like zero matching rows.
- Announce successful row counts with `role="status"`; associate errors with the affected action. Keep text labels alongside status colors, keyboard access to the table and disclosures, visible focus, and at least 44 px touch targets.

## Review criteria

1. On first open for a prepared 90-row dataset with a ready local engine and no current result, users can see preview rows without first running a query manually.
2. The automatic preview is bounded, read-only, local-only, and does not add to query history; existing results and history remain selectable.
3. Provider failure does not block the local preview. Local engine failure is distinguishable from an empty dataset and offers an honest fallback or recovery action.

## Implemented variant

The app now reads the bounded preview directly from the same preferred workspace dataset binding used by the query engine. It does not execute `preview_rows` automatically, so the result remains available when DuckDB or the AI provider is unavailable and does not create a query trace. The existing query builder still requires an explicit Run query action. The first four permitted columns are shown; the total column count and row limit are stated separately. Historical and current query results retain their existing selection behavior.

The result precedes the query builder. Mobile shows the bounded row table in the first viewport, with a compact summary instead of five metadata cards. [Before mobile](data-explorer-first-open-before-mobile.png) / [after mobile](data-explorer-first-open-after-mobile.png); [before desktop](data-explorer-first-open-before-desktop.png) / [after desktop](data-explorer-first-open-after-desktop.png). The SVG and PNG remain illustrative DRAFT anchors, not screenshots of the app.
