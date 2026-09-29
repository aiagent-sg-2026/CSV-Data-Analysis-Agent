# History Storage at 320px — implementation spec

The paired SVG is an illustrative after-layout, not an app screenshot. Its labels, dates, counts, and sizes are synthetic.

## Concrete issues visible in the supplied captures

- The totals read as small captions beneath the segmented bar. The browser-origin estimate and its separate-measurement caveat are even smaller, so the three storage measurements are easy to conflate.
- Refresh, Clear all, and per-row delete are drawn as tiny text or icons. The screenshots do not reveal their actual hit boxes; give every action a minimum 44 × 44 px target, including close, sort, source, version, Resume analysis, and More. Keep text labels where an icon alone is unclear.
- In the cache view, Resume analysis is cut off at the sheet's bottom edge. The long inspector/report content needs a clearly bounded scroll region and enough bottom padding to bring the final report controls fully into view.

## Proposed layout

- At 320px, use a near-full-height sheet (`max-height: calc(100dvh - 16px)`). Keep the title/close, search, sort, source/Clear all, and compact storage summary visible.
- Put the two primary totals in labeled, high-contrast fields. Keep the segmented bar secondary, and show the browser-origin estimate with its separate-measurement caveat as readable text.
- Keep storage categories and saved reports together in one internal scroll area (`min-height: 0; overflow-y: auto`), with at least 12px bottom padding. The SVG depicts that area after scrolling to a saved report.
- Preserve current data and behavior: source selection, sorting, search, refresh, clear all, per-category deletion, version expansion, resume, and More remain available. All actionable controls have at least a 44 × 44 px hit area.
