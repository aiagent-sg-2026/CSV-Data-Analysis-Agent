# AI Long-Term Memory — mobile layout proposal

The paired SVG is a 390 × 844 draft illustration based on the supplied mobile and desktop captures. All names, counts, sizes, and identifiers shown are synthetic; it is not an app screenshot or a runtime test.

## Proposed changes

- Keep the panel title, `4 items`, and `Using ~12.50 KB` visible. Replace the wrapped raw scope IDs with a compact `Active scope · Report · Dataset · Version` summary and a 44 px `View IDs` disclosure.
- Keep `Test Similarity Search`, its ready status, query field, and Search action together. Give the field and action at least 44 px height.
- Keep `All Stored Memories (4)` and `Clear Report Memory` visible above one bounded, vertically scrolling list. Each card gets a short summary, an explicit 44 × 44 px delete target, and a 44 px `Exact provenance` disclosure.
- The scope disclosure should reveal the complete report, dataset, and version identifiers. Each card disclosure should reveal all provenance currently stored for that memory, including the original source, report session, dataset, and version where present. Render values in full, selectable, and with long-token wrapping; do not truncate or replace stored values. Use semantic `<details>/<summary>` or an equivalent keyboard-operable disclosure with a visible focus state and an accessible name.
- Keep close, `View IDs`, delete, clear, and search targets at least 44 × 44 px. Preserve the current white sheet, light neutral cards, blue primary action, and dimmed page backdrop.

The collapsed mobile view saves height by showing one concise source summary per item. Opening provenance adds content and may require scrolling; that tradeoff keeps exact technical lineage available on demand. The SVG is a visual proposal only; no application code was changed or runtime behavior tested.
