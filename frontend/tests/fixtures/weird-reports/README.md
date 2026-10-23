# Weird-format report fixtures (synthetic)

All data here is generated, not real. `generate-weird-reports.py` (seeded, deterministic) writes the CSVs and `truth.json`;
the committed files use `SCALE=0.12` (a few hundred rows). Run `SCALE=1 python3 -I generate-weird-reports.py <dir>` for the
few-thousand-row versions used in browser tests.

| File | Layout it imitates | What a correct intake must do |
|---|---|---|
| `w1_erp_outstanding.csv` | ERP "outstanding orders" report: title block, 2-row header with group labels, spacer columns, customer printed once per group, subtotals, page breaks that repeat the title and header, grand total, end marker | Keep only order lines (`truth.f1.rows`); sum of "Balance Amount" over those lines equals `truth.f1.grand_total` |
| `w2_hierarchy_monthly.csv` | Indented Region > Country > Customer rows with monthly columns and a Total column | Do not double count parent rows; leaf total equals `truth.f2.grand_total` |
| `w3_three_sections.csv` | Three tables with different headers stacked in one file | Do not mix sections; each section keeps its own columns |
| `w4_european_semicolon.csv` | BOM, `;` delimiter, decimal commas, dotted thousands, mixed dates, CJK text, quoted embedded newlines, trailing delimiter | Detect `;`, 7 columns, `truth.f4.rows` records, total equals `truth.f4.total` |
| `w5_aging_meta_footnotes.csv` | 38 key-value metadata lines before the header, repeated "Continued..." header blocks, `*` footnote marks, totals and footnotes at the end | Find the real header, ignore metadata, repeated headers and footnotes |
| `w6_grouped_header_carryforward.csv` | Two-row header where `FY2025` / `FY2026` span several columns, category printed once per group, `$` and `-` values | Keep `Category`, `Product` names, keep the FY layer, fill the category down |
| `w7_fixed_width_text.csv` | Space-aligned text report saved as `.csv`, page breaks with form feeds | Detect that it is not delimited and say so, or split by the column positions |
