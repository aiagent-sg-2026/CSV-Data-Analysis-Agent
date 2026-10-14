---
name: reconcile-data-grain
description: Independently check grain, nested subtotal scope, global duplicates and reconciliation before publication.
manifest: {"schemaVersion":1,"version":"1.0.0","profiles":["browser-javascript"],"requires":["candidate.validate"],"supportingFiles":[]}
---

# Reconcile grain and scope

1. Use complete source references to define one fact row, metric unit and summary membership. Check nested or repeated summaries within their own scopes; do not compare unrelated totals.
2. Separate detail facts from summaries without treating names alone as proof. Distinguish exact duplicate evidence from legitimate repeated events; deduplication requires a defensible key and full population coverage.
3. Define independent invariants from source-derived meaning: row/cell mapping, unit preservation, permitted conversion, summary-to-detail membership and reconciliation tolerance. Do not derive the expected total from the same repair output.
4. Use candidate_validate on the exact staged receipt. Grain, scope, coverage or reconciliation failure must block publication. Read validation reasons and revise the task program instead of weakening checks.
5. Preserve both source assumptions and rejected checks in review. Exact approval and fresh current-version factual evidence remain separate host gates.
