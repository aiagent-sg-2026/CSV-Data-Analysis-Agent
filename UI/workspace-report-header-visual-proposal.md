# Session Artifacts header proposal

**Illustrative proposal, not a real screenshot.** The paired visual shows a synthetic 390 px mobile viewport and a compact 1280 px desktop viewport. All file names, data, and counts are illustrative.

## Responsive implementation spec

- **Breakpoints:** At `840px` and below, use the stacked mobile header. At `841px` and above, keep one compact horizontal header. The desktop row has a left group (title and counts) and a right group (Open Report, Export PDF, Show Debug, Close).
- **Mobile rows:** Row 1 has the `ARTIFACTS` eyebrow and Close icon button. Row 2 has the `Session Artifacts` heading. Row 3 contains both count chips side by side. Below them, place Open Report and Export PDF in two equal columns, then Show Debug (24) at full width.
- **Title and Close:** Keep the title on one line at 320 px and 390 px; reserve 44 × 44 CSS px for Close at the upper-right of the header. Give its icon button the accessible name “Close Session Artifacts”.
- **Counts:** Keep `6 files` and `6 agent write paths` as horizontal, non-interactive chips with `white-space: nowrap`. At 320 px, the content width after 16 px side padding is 288 px, enough for both chips and their gap.
- **Actions and hit targets:** Preserve all four actions and their existing labels/handlers. Make each action button and Close at least 44 px high; Close must also be at least 44 px wide. On mobile, use a 2-column grid with an 8 px gap and let Show Debug span both columns. Keep labels on one line at 320 px.
- **Wrapping/overflow:** Allow the header to grow vertically on mobile. Do not shrink or wrap the title, count labels, or action labels at 320 px and 390 px. At those widths, the title has at least 236 px after reserving Close and its gap; the count chips share at most 288 px. Verify the page has no horizontal overflow.
- **Keyboard/accessibility:** Use a semantic heading and real buttons with descriptive names. Keep tab order predictable and aligned with the visual action order; expose a visible focus ring with sufficient contrast. Keep text labels present (do not rely on color or icons alone), and ensure the close icon has an accessible name. Preserve Escape-to-close only if the existing panel already supports it.

## Acceptance checks for implementation

- At 320 px and 390 px, the title, both count chips, and every action are visible without horizontal scrolling or clipped text.
- At 1280 px, title/counts and all actions remain in one compact header row.
- Every action remains keyboard reachable; focus is visible, labels are announced, and each button hit target is at least 44 × 44 CSS px.
