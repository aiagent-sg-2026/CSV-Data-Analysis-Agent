---
name: repair-data-with-code
description: Write, execute and revise a task-specific repair program using observed structure and independently verified source meaning.
manifest: {"schemaVersion":1,"version":"1.0.0","profiles":["browser-javascript"],"requires":["candidate.infer_meaning","candidate.stage","candidate.validate"],"supportingFiles":[]}
---

# Repair data with code

1. Diagnose complete inputs and infer source-bound meaning with candidate_infer_meaning before executing a repair. Do not import a ready-made answer or use confidence as validation.
2. Write your own revisioned JavaScript program with workspace_write. Bind immutable source slices or complete tables through code_run. Whole-table or stateful-stream coverage must match the requested population; row_map cannot silently implement global deduplication or totals.
3. Inspect code_inspect errors and output. Repair only a demonstrated defect, then rerun with new revision/hash and preserved cumulative budget. Preserve original bytes, legitimate zero/negative values and unverified rows.
4. Stage the exact successful artifact with candidate_stage. Run candidate_validate independently for grain, row/cell/source mapping, scope and reconciliation. A passing runtime or stdout is insufficient.
5. Request candidate_request_approval for the exact validated candidate. Fresh-lease approval commits through the host; no skill can approve or mutate original data. After commit rerun queries/computations on the current version and admit evidence before reporting facts.
