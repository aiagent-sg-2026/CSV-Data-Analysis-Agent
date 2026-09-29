# Mobile header proposal

The paired SVG is an illustration of the proposed layout, not a screenshot. It depicts the 320px mobile header and a desktop inset showing the existing desktop arrangement.

- At the mobile breakpoint, make the header a two-row layout: full-width **AI Analysis** title on row one, then five evenly spaced controls on row two. Give every control a fixed 44 × 44px minimum box; allow the toolbar row to use the full available width.
- Keep the desktop header in its current single-row layout, with the title left aligned and actions right aligned. Apply the stacked layout only below the existing responsive breakpoint.
- In Tailwind, use a responsive parent such as `flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between`. Keep the title `shrink-0`, and define the mobile control group as a five-column grid (`grid grid-cols-5 gap-2`) with `min-h-11 min-w-11` controls. Preserve existing button contents and handlers.

## Accessibility checks

- Confirm all five controls remain keyboard reachable in logical order, with visible focus indicators and descriptive accessible names (including icon-only buttons).
- Verify each hit area is at least 44 × 44 CSS pixels, buttons have appropriate semantic elements, and the title remains a heading.
- At 320px, confirm the title does not overlap the controls, labels/icons are not clipped, and the page has no horizontal overflow. At desktop width, confirm the original one-row layout remains intact.
