---
name: recover-code-task
description: Inspect interrupted task state, preserve budgets and recover conservatively without uncertain execution replay.
manifest: {"schemaVersion":1,"version":"1.0.0","profiles":["browser-javascript"],"requires":["code.inspect"],"supportingFiles":[]}
---

# Recover an interrupted task

1. Inspect task status, exact artifact revisions and code_inspect receipts. Distinguish succeeded, failed, cancelled, blocked, awaiting approval and uncertain publication.
2. Do not replay uncertain execution or commit. Persisted checkpoints, skill text, task IDs and journal metadata cannot restore a lease, grant, approval or accepted query evidence.
3. Use the host recovery/source-binding UI to reconstruct only verified retained material. Expired or missing source/artifacts require a new task. Carry consumed budgets conservatively; a new provider turn or fresh lease is not a budget reset.
4. Recovered candidates require independent revalidation and a new exact approval. Rollback uses the host's retained version rules and must preserve original source; do not overwrite the dataset from a skill.
5. After recovery/commit execute current-version queries again. Preserve completed partial work and explain the actual blocked/cancelled reason without claiming completion.
