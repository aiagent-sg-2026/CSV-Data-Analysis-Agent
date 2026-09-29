# AI Long-Term Memory search — compact result proposal

The paired 390 × 844 SVG is a draft illustration using representative synthetic content. It is not a real app screenshot or a runtime test.

- **Result title:** Show the memory's human-readable title first, such as **Sum Resale Price by Town**. Keep the source type or origin as secondary metadata so users can identify what they will jump to.
- **Preview length:** Limit each search result to a short, two-line excerpt (about 120 characters maximum), with a visible ellipsis when clipped. Keep the complete stored memory, source evidence, and exact provenance in the corresponding item in **All Stored Memories**; do not truncate that canonical content.
- **Match label:** Label embedding results **Vector similarity**. Label the lexical fallback **Keyword match · fallback**. Do not imply a vector score when the fallback found the result.
- **Touch target:** Keep Search, result selection, close, View scope IDs, Clear Report Memory, each delete action, and Exact provenance disclosures at least 44 × 44 px. Avoid making a compact result row shorter than 44 px.
- **Keyboard behavior:** Search submits with Enter; Tab and Shift+Tab move through controls in a predictable order; Enter or Space selects a focused result. Selection scrolls the corresponding stored memory into view and highlights it. Keep a visible focus ring, make provenance disclosures keyboard-operable, and let Escape close the memory dialog while returning focus to its opener.
- **Mobile layout:** Keep the existing white sheet and dimmed backdrop. Stack the search controls, compact Top Results, and full All Stored Memories list in one vertical scroll area. Keep the result-to-memory relationship visible through a selected state, then scroll and highlight the matching full item when a result is activated. Preserve the title, item count, storage usage, View scope IDs, Search, Clear Report Memory, per-item delete, Exact provenance, and full source evidence.
- **Desktop layout:** Retain the two-column relationship: search controls and compact results on the left; the full stored-memory list and provenance on the right. Keep both columns independently readable and preserve result selection's scroll-to-and-highlight behavior in the stored-memory column.

The proposal shortens repeated search text while leaving the canonical saved memory and its evidence available in the existing stored-memory view.
