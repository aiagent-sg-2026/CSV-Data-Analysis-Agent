---
name: investigate-report-structure
description: Inspect complete report structure, ragged or shifted rows, nested summaries and possible grain before proposing repair.
manifest: {"schemaVersion":1,"version":"1.0.0","profiles":["browser-javascript"],"requires":[],"supportingFiles":[{"path":"scripts/describe-shape.js","kind":"javascript","sha256":"b4e09f826cfcd068cbfa8998860fe52628573823a75c9fbe3100aa796abd1cae"}]}
---

# Investigate report structure

1. Inspect original source and complete current table through controlled workspace/source tools. Record population, columns, missingness, repeated headers, row widths and candidate summary boundaries. Samples help locate issues; they cannot prove full population coverage.
2. Read scripts/describe-shape.js with read_skill only when structural counts help. Bind the complete current table as data through code_run. It returns observations and does not repair rows or establish business meaning.
3. Distinguish evidence from hypotheses. A label that resembles a subtotal, duplicate or shifted cell is a candidate, not permission to drop it. Preserve legitimate zero, negative and sparse facts.
4. Before repair use candidate_infer_meaning to compile source references, grain, units, allowed conversions and scoped reconciliation. Inferred assumptions remain visible in exact review. Unsupported meaning blocks without inventing source semantics.
5. Retain a concise diagnosis and proposed invariant checks. Use the repair skill for execution; fresh query or computation admission is still required for answers.
