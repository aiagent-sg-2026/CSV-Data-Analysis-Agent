# Raw Data Explorer toolbar proposal

The SVG is an illustration of the toolbar at desktop 1280×720 and mobile 390×844. It is not an actual screenshot. It covers only the controls above Group By Test.

- Keep all source tabs, view actions, status copy, search placeholder, and Ask AI action unchanged.
- Give every interactive control a 44px minimum height. Keep the three source tabs equal width on mobile; keep View Data and Group By Test as a full-width segmented control.
- On mobile, show the status sentence and edit-state badge on separate lines, then use a full-width search field with Ask AI on its own right-aligned 44px row. This preserves readable control widths and avoids a document-level horizontal scroll at 390px.
- On desktop, keep the source tabs, view selector, and status on one row; put search and Ask AI together on the next row.
- Let rows and search controls shrink with `min-width: 0`; use `width: 100%` within the padded toolbar and allow long status text to wrap. Do not use a fixed minimum toolbar width.
