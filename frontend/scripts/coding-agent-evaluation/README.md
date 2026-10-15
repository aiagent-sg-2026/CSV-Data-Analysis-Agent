# Synthetic Coding-Agent Evaluation Foundation

Public checkouts use `qualificationContract.mjs` as the pinned acceptance policy. Private historical plans and benchmark reports are not evaluator dependencies. Generate the synthetic suite with the fixture command below before running a new packet; historical operator report links in this guide refer to local, ignored evidence.

The fixture foundation constructs synthetic inputs from deterministic latent facts and checks the frozen fixture contract without importing a provider or application runtime. The separately invoked campaign command now exercises the checked-in production runtime with local mocks, as described below. Fixture generation alone does not evaluate a model.

Use actual Node >=22.13 and <23. Run from `frontend/`:

```sh
npm run coding-agent:fixtures -- --output /tmp/coding-agent-suite-v1
npm run coding-agent:preflight -- --suite /tmp/coding-agent-suite-v1 --report /tmp/coding-agent-preflight.json
npm run test:coding-agent:fixtures
```

The output directory must be absent. Generation refuses to merge into or replace an existing suite. Files use mode 0600 and atomic same-directory publication; manifest is written last. An interrupted partial generation is invalid and must be inspected before deleting/retrying in a fresh directory. Preflight is read-only except for its explicitly requested report. Report exit status and JSON gate share one decision: `fixture_ready` is exit 0, invalid input/tamper/report failure is exit 2. Both CLIs reject unsupported flags, including provider configuration, and incompatible Node runtimes.

## Frozen denominator and custody

`tests/fixtures/coding-agent-suite.lock.json` pins the manifest SHA-256. There are 40 solvable cases (five in each of eight families), 10 ambiguous cases and 10 adversarial cases. Seeds 17, 41 and 97 define 180 future runs per advertised model/profile. Twenty cases require repairs beyond the existing operation enum. One case uses an independently calculated weighted-median method. Three large variants contain defects spanning the 5,000-record boundary. Evaluator-only failure schedules describe future bounded runtime-error injections.

The generator creates latent fact IDs, units, signed integer minor amounts and grain before applying corruption. Oracle groups, exclusions/source-record identities and calculation expectations derive from those facts, not an application repair or generated solution. Multi-line CSV references use logical record numbers, not physical line offsets. Weighted-median tests additionally check the oracle against independent expanded-and-sorted observations.

Each case separates `agent/` raw inputs and task goal/output requirements from `evaluator/` canonical facts, exclusions, method and failure schedule. An eventual evaluator passes only the declared agent artifacts to the agent; never pass manifest notes, evaluator files, preflight diagnostics or solution scripts. Public synthetic cases can be inspected by maintainers: they are a reproducibility corpus, not secrecy-based proof of generalization. CA-173 must freeze custody, model/profile/pins, prompts, spend allowance and all results before a live holdout. No fixture-specific skill or expected clarification is supplied to the agent.

Preflight requires the approved hash, exact non-empty coverage/counts, unique identities, declared artifact paths/digests and agent-only task fields. It refuses symlinks, traversal, missing or extra artifacts, oversized files and unbounded directory walks. Updating the lock to make a modified suite pass requires a reviewed new fixture version; do not overwrite it to hide a failure.

`fixture_ready` means the corpus passed integrity checks. `providerCalls: 0`, `evaluatedRuns: 0`, `capabilityAcceptance: pending` and `liveRunAuthorized: false` remain explicit. Live scoring, automatic retry/error injection, model quality and executor isolation belong to later tickets; this toolkit does not claim those gates passed. Keep business/customer inputs out of this public directory. Operator reports and the generated suite may remain in the project's ignored local evidence directory.

## CA-173 zero-call candidate preparation

After generating the unchanged suite, freeze the current local candidate in a **new** file:

```sh
npm run coding-agent:qualification-preflight -- --suite /tmp/coding-agent-suite-v1 --freeze /tmp/qualification-candidate.json --report /tmp/qualification-preflight.json
npm run coding-agent:qualification-preflight -- --suite /tmp/coding-agent-suite-v1 --manifest /tmp/qualification-candidate.json --report /tmp/qualification-preflight-recheck.json
```

The candidate is Browser-first JavaScript plus local SQL with source-default Default gateway settings. It pins the working source, dependency lock, evaluator, all checksum-managed deployment bytes, builtin skill packages and exact 180-run schedule. `HEAD` alone does not identify this dirty working tree. Changed source/deployment/evaluator/fixture/configuration, missing/duplicated runs, altered seeds, pooled profiles, weaker thresholds, additional fields and invented authorization fail inspection. Re-freezing refuses an existing target; review drift before explicitly preparing a new packet. Files are atomically published with mode 0600. Exit 0 means `preflight_complete`; exit 2 means invalid input, drift or report failure. Both statuses keep `launchReady: false` and `liveRunAuthorized: false`.

Once valid CLI arguments select a safe report destination, input failure replaces a writable previous report with the invalid verdict. A report publication failure preserves its previous target, returns exit 2 and sets `reportPublicationFailed: true` on stdout; the old file cannot evidence that invocation. Unsupported arguments do not select a report destination or write anything.

This CLI reads only declared local files and local Git HEAD; it neither reads credential environment variables nor calls a gateway, provider, app runtime, MCP or database. `--launch`, `--provider`, `--api-key` and `--approve-spend` are unsupported. Proposed spend/provider-call/input-token/output-token ceilings remain null, and paid authorization remains absent. The 32-turn task budget does not cap planner, health, compaction, browser transport retries or other provider requests; 180 × 32 is not a campaign-wide request/spend guarantee.

Four prerequisites remain before any live run: observed/resolved model identity for the chosen provider, actual isolated runtime configuration capture, separately authorized campaign ceilings bound to reviewed pins, and a real production-runtime runner with global pre-request usage reservation/accounting. The source Default model is a logical alias; no handshake or model-quality result is fabricated. A new model/profile requires its own reviewed manifest and 180 runs, with no pooled scores. Existing CA-172 browser/machine evidence is historical profile evidence, not proof that a future live browser has been captured.

`loadFrozenAgentInput` verifies the frozen fixture and returns only its declared agent files. A future transport must use that projection, never the qualification packet: the packet deliberately contains evaluator file references, family/disposition counts and failure schedules for evaluator custody. Public synthetic reproducibility does not establish an unseen holdout. The method, ambiguity and failure tests check this separation; there is no live runner wired to it yet.

See [CA-173 preflight verification and remaining launch gates](../../docs/coding-agent/ca-173-preflight-2026-10-13.md). CA-173 remains Planned until its actual per-model/profile live results meet the unchanged acceptance contract.

## Production-runtime mock campaigns — 2026-10-14

This section supersedes the historical missing-runner statements above. The production-runtime runner and durable global request ledger are implemented. Live transport, model qualification and paid authorization remain unavailable. The command is **mock-only** and rejects live adapters and unsupported provider/key/launch flags.

Prepare the frozen suite and a fresh candidate packet first. Write an explicit local mock budget file, for example:

```json
{"calls":1000,"inputTokens":100000000,"outputTokens":100000000,"costMicrousd":1}
```

Then run from `frontend/`, using exactly this argument order:

```sh
npm run coding-agent:campaign -- --suite /tmp/coding-agent-suite-v1 --manifest /tmp/qualification-candidate.json --output /tmp/coding-agent-mock-new --budget /tmp/coding-agent-mock-budget.json --browser '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' --entry-point follow_up
```

`--entry-point initial_analysis` selects the shared initial runtime. The browser binary must already exist; the runner does not install it. Each scheduled slot gets a fresh private browser context and Store, real intake, Pi tool loop, task contracts and normal exact candidate approval handler. Synthetic approval acquires a fresh lease and does not bypass commit validation. Only declared agent files enter that runtime. Evaluator oracles are separately captured and hashed in Node. Deployment bytes are verified and captured once, so an overlapping root rebuild cannot change the executing app. Agent input buffers are also captured once and copied for each slot.

The default local reply asks for clarification and selects no repair. Consequently, a successful 180-slot command verifies orchestration and custody, not model intelligence. Exit 0 requires all scheduled slots to finish recording; `qualityPassed` remains false and `capabilityAcceptance` remains pending in mock mode. Seeds identify the frozen replicate slots; the deterministic mock does not exercise a provider's sampling seed. Source-default candidate settings are the future qualification proposal; the mock explicitly substitutes its stream and model identity and cannot qualify those live settings.

The adapter serves only checksum-managed local files. External browser requests are denied, with Default demo requests fulfilled locally under the same reservation boundary. Every simulated Pi stream or intercepted helper request must durably reserve a call, input/output allowance and integer micro-USD allowance before a reply is released. This includes requests independently of whether they are labelled planner, health or compaction. Unknown/failed/over-bound usage retains the complete reservation and stops further dispatch. The mock uses UTF-8 byte counts as conservative simulated token units and spends zero; these numbers are not tokenizer or billing measurements. Actual provider request retries, usage/pricing bounds and remote cancellation still need separate qualification.

`campaign.json` records binding, finite ceilings, reserved/settled/uncertain requests, event/state hashes and result hashes. Each `attempt-NNN.json` retains the actual outcome, task observations, available export and evaluator verdict. `summary.json` keeps the original denominators, critical failures and separate first-attempt/revision counts. Paused/stopped/uncertain/storage-failed campaigns return exit 2 with partial accounting; a request refused before reservation does not dispatch. SIGINT/SIGTERM cancels the local runtime and fences further requests. This is local cancellation, not proof of provider termination.

Recovery is available through the `runQualificationCampaign` module with `resume: true`, the same frozen manifest and the same output directory. Completed slots are skipped; paused/stopped/uncertain campaigns do not automatically resume dispatch. A running run or unacknowledged reservation is uncertain and never replayed. Hash drift or mismatched bindings refuse recovery. Exclusive `.owner` files are not automatically reclaimed after a crash: inspect process ownership and retain the journal before any manual removal. The CLI deliberately has no recovery/reset/paid-launch flag. Hash chains detect corruption relative to the captured record; they are not signatures against a privileged local operator rewriting every hash.

Scoring requires independently validated accepted fact tables and current admitted query/computation exports. It compares complete fact identity, amount, unit and grain to the evaluator oracle, and rejects truncated or unsupported factual outputs. Provider prose/stdout and old global queries cannot supply answers. The current host registry independently validates Pearson; the frozen lower weighted median and other unsupported formulas remain a release gap. Frozen fault schedules remain evaluator-owned metadata; this mock campaign does not execute those three holdout fault injections. A separate native probe verifies an actual failing/revised program without being pooled into holdout scores.

See [runner verification and evidence](../../docs/coding-agent/ca-173-runner-2026-10-14.md). CA-173 remains Planned, with no paid/provider/model-autonomy acceptance or public release.


## Lower weighted median and bounded live demo smoke — 2026-10-14

The host now independently admits lower weighted median with nonnegative integer frequencies, complete typed scope and optional unit-column consistency. This supersedes the earlier missing-method implementation statement, while the frozen campaign and its historical mock results retain their original meaning. The full campaign command remains mock-only.

The explicitly invoked `node frontend/scripts/coding-agent-evaluation/weighted-median-demo.mjs --live-demo --output /tmp/weighted-median-live.json` performs a separate real Default demo method smoke in a fresh private context. It exercises the normal Cloud AI consent UI under the operator's explicit synthetic-test authorization, then the production health/classifier/Pi/program/admission path. It neither supplies an oracle/program/answer to the model nor launches the 180-run holdout. Request/call/time guards, observable wire alias/usage and billing/model-identity limits are documented in the [method contract](../../docs/coding-agent/lower-weighted-median.md). A new reviewed packet pins this driver and current source; historical frozen packets are preserved and cannot qualify the changed build.


## Frozen S8-2 real demo procedure — 2026-10-14

Use Node 22 (>=22.13 <23) and explicitly invoke `node frontend/scripts/coding-agent-evaluation/s8-2-demo.mjs --live-demo --output /tmp/s8-2-live.json`. This operator-only command hash-checks frozen agent/evaluator files and local generated deployment bytes, starts native Chrome in a private context, allows real Default session/response POSTs, accepts the normal Cloud AI consent for the expressly authorized public synthetic test, and selects an available exact candidate review through the normal approval action. The model receives no oracle/canonical output/program/answer/host-issued scope.

The gate requires complete oracle-equivalent facts, source preservation, exactly one approval/commit, the same logical task under a fresh run/version, matching review/program/validation digests, consumed exact approval, current computation input bindings and a complete admitted answer. Missing evidence returns a nonzero process exit. Per invocation ceilings are 40 provider calls, 3 sessions, 600,000 request bytes and 300 seconds; production task budgets remain 40 tools/8 skills/32 provider turns/3 transformations/15 active minutes. These are diagnostic limits, not qualified billing bounds.

Recorded result: **0/7 diagnostic full flows; not accepted**. The final build also failed both measured invocations. All failures, partial approvals and known/unknown usage are preserved in the [AMM report](../../docs/coding-agent/ca-173-s8-2-2026-10-14.md). This does not enable the mock-only full campaign CLI or close CA-173.


## Combined typed preparation and computation — 2026-10-14

A requested canonical fact-table repair is retained as requestedDataPreparation=canonical_fact_table alongside the resolved calculation. The host plan distinguishes repair, independent candidate validation, exact approval and fresh statistical execution. Both repaired-dataset and factual-answer outputs are required. Plan metadata includes the strict candidate/cell-lineage contract and statistical count definitions; it does not grant approval or supply reference values. scopedRows is a count after the business/time filter, and excluded counts missing pairs within that scope. Reference rejection returns to program revision and requires a new execution/job without resetting counters.

The separately invoked s8-2-demo.mjs --live-demo --output <report.json> command uses public frozen agent files and real Default requests through an isolated generated React runtime. Use actual Node >=22.13 and <23. It approves only the available exact synthetic review through the existing action handler; invoking the live operator test requires explicit authorization for that synthetic demo workflow. It saves a structured report and dashboard screenshot, but screenshots do not replace current-version computation evidence. Full campaign execution remains separately qualified/authorized.

Final scoped S8-2 verification passes on build 1.0.0-05a1dd24d8a4 after a statistical revision, with the unchanged three-execution budget and all 11 facts preserved. Result 1199 is in amount_minor source scale; the unit label is SGD. See the [typed planning acceptance report](../../docs/coding-agent/ca-173-typed-planning-2026-10-14.md) for all failures, exact bindings and limits. Full CA-173 qualification remains Planned.

## Current qualification launch preparation — 2026-10-15

The [current launch packet](../../docs/coding-agent/ca-173-launch-preparation-2026-10-15.md) freezes the post-S8-2 source and evaluator without replacing historical packets. Use its new manifest for zero-call rechecks only. A successful preflight means the unchanged 60-case/three-seed packet is internally valid; it keeps `launchReady: false` and does not authorize a session handshake or model request.

Five launch blockers are explicit in the preflight: unresolved physical provider/model identity, absent isolated live configuration capture, absent finite campaign authorization, unqualified live request/usage bounds, and unimplemented holdout fault injection. The durable ledger and production-runtime mock adapter are implemented; the full campaign runner still rejects a live adapter. The three frozen S1-4/S6-4/S8-4 schedules are metadata only and must be connected to actual execution before claiming recovery coverage. A separate successful S8-2 smoke cannot replace these nine scheduled case/seed outcomes.

Before a live implementation is qualified, preserve the Default gateway's serialized omission of `max_output_tokens`. Request byte limits, a 32-turn task budget, alias `demo-auto`, model catalog prices and observed historical usage are insufficient evidence of enforceable live token/cost bounds. Reserve every physical attempt before dispatch, reconcile independent transport observations to the ledger, retain unknown usage conservatively, and pause without replay after uncertainty or exhaustion. Pin the actual isolated settings, prompts, eligible tool schemas, runtime and model identity; the mock's substituted `mock` model cannot supply this capture. Document how replicate seeds are supported rather than claiming the current mock forwards them to a provider.

The preparation originally recorded the S8-4 `weighted_mean` admission/scoring gap. The 2026-10-15 implementation below adds that path without changing the frozen case, denominator or family threshold. Its scoped smoke does not establish full holdout qualification; never supply an oracle-derived result to the model. Manual-upload UI and independent secondary review remain separate evidence needs. No public release or Full/Python capability is enabled by this packet.

## Live HTTP boundary and frozen fault execution — 2026-10-15

`liveHttpAdapter.mjs` implements the final serialized Default protocol boundary with a host-supplied **local mock** transport. `createBrowserEvaluationAdapter({httpAdapter, ...})` uses the real production composer/classifier/Pi/SDK path, with all session/helper/provider/retry requests intercepted at HTTP. The full campaign CLI remains mock-only; no remote transport, credentials, pricing or spend authorization is activated by constructing this adapter. This supersedes the missing implementation statements in the earlier preparation, while remote qualification gates remain open.

The adapter snapshots request/model/bounds/pricing and the transport function, rejects an unexpected origin/model or `max_output_tokens` before reservation, records the request-body SHA in the durable request kind, and dispatches only after the ledger has persisted the full finite reservation. Each physical retry consumes a separate request. Native Responses JSON/SSE usage is parsed strictly; missing, malformed, mismatched or over-bound usage stays charged and stops further dispatch. A late response after Abort cannot settle an uncertain attempt. An independent header/body-free observer reconciles every request hash/kind and usage against the ledger. It never substitutes ledger totals for transport observations. Session and explicitly configured nonbillable rejection rules in the local fixture are synthetic contracts, not production billing evidence.

The configured cost reservation must cover the worst case implied by both token ceilings and pinned prices; under-reserved configurations are rejected before dispatch. This is an arithmetic guard, not evidence of real upstream output bounds or billing enforcement.

`runner.mjs` now projects the unchanged evaluator-only S1-4/S6-4/S8-4 schedules into a session-owned fault port, separately from agent files. The first valid code execution encounters a real QuickJS exception before its program body; source/program bytes are unchanged, and the fault environment is bound into the host receipt digest. A new program revision can then execute under the original task budget. The port survives an approval's fresh lease within that session, retires on session replacement, and cannot be enabled by model arguments or saved settings. Audit receipts retain instrumentation; model run/inspect feedback omits the instrumented environment and exposes only a generic runtime error. No oracle values or schedule metadata belong in model input.

The scorer requires the correct schedule hash, actual failed worker execution, a different program SHA that subsequently succeeds in the same task/session, and all nine frozen recovery outcomes before accepting live quality. Existing fact/evidence/ambiguity/novel-method thresholds remain unchanged. Correct recovery alone does not establish correct repaired facts or an admitted analytical answer.

For explicit local HTTP diagnostics, use actual Node 22 and an absent report/ledger destination, from `frontend/`:

```sh
node scripts/coding-agent-evaluation/live-adapter-mock.mjs --output /tmp/ca-173-http-mock-new.json
```

The command uses native Chrome, the checksum-captured generated React build and nine fresh contexts. It reads only frozen agent inputs to script an identity meaning proposal, then a complete-table row-count probe, a runtime failure and a revised probe. It deliberately ends with clarification, with no repair commit or accepted answer. Every task retains 40 tools / 8 skills / 32 provider turns / 3 transformations / 15 active minutes and uses two transformation attempts. The explicit mock campaign allowance remains 1,000 requests / 100,000,000 input units / 100,000,000 output units / 1 micro-USD ceiling, settling zero cost. These are simulated usage/budget fixtures, not tokenizer or billing measurements. The frozen model qualification still requires all 180 runs; this nine-slot diagnostic is never pooled into live scores.

The report records all attempts, model-visible metadata exclusion, wire keys, per-request hashes, independent usage observations and the durable ledger. It refuses an existing report and destinations inside the corpus. Inspect a failed campaign before preparing a new destination; uncertain attempts are not replayed. See [implementation, final checks and retained failures](../../docs/coding-agent/ca-173-live-adapter-2026-10-15.md). S8-4 weighted-mean admission/scoring, actual model/configuration/billing/bounds, finite paid authorization and complete live qualification remain open.


## Exact weighted mean and bounded S8-4 smoke — 2026-10-15

`weighted_mean` accepts typed safe integer value cells and nonnegative safe integer frequency/quantity weights. The result contract is `{method:"weighted_mean",methodVersion:1,seed:"none",scopedRows,n,excluded,zeroWeightRows,numerator,denominator,mean,unit}`. `numerator` and `denominator` are canonical decimal integer strings containing the **unreduced** BigInt sums, including beyond safe-number totals. `mean` is `Number(numerator) / Number(denominator)`, or null for zero denominator, and never replaces the sums. Negative/zero values remain facts; missing pairs are excluded and zero-weight pairs counted separately. Contributing units must be uniform when a unit column is declared. Source scale is preserved. Fractional/unsafe values and fractional/negative/unsafe weights are unsupported, not silently rounded or dropped.

An explicitly empty computation predicate/group array canonicalizes to full input; malformed filters remain rejected. The host-compiled meaning input alias is projected into the repair program contract and must stay identical across code_run inputs and lineage. `transformationReserve` projects the still-needed repair/computation executions and the remaining allowance for diagnostic probes; it grants no extra attempts.

The host re-reads the complete bound current table, applies the typed scope, independently computes the reference and rejects any output-field mismatch. Exported receipt coverage retains both exact strings. S8-4 scoring requires the current selected `host-integer-frequency-mean-v1` receipt, the matching entire-input scope/columns, exact oracle sums, correct unit and display quotient within the unchanged oracle tolerance. A reduced fraction, numeric sums, rounded text or matching provider prose is insufficient. The original frozen fault gate still requires a failed worker and different subsequent program under the same task/session.

For a separately authorized live Default demo smoke, with actual Node 22 and a fresh destination, from `frontend/`:

```sh
node scripts/coding-agent-evaluation/s8-2-demo.mjs --live-demo --output /tmp/ca-173-s8-4-new.json --case S8-4
```

Omitting `--case` preserves S8-2 behavior. S8-4 installs the unchanged evaluator fault schedule only through the host test port, uses normal consent/composer/exact approval actions, and scores the exported structured artifact outside the model context. Request guards remain 40 provider / 3 session / 600,000 bytes per request / 300,000 ms per invocation; task limits remain 40 tools / 8 skills / 32 turns / 3 transformations / 900,000 active ms. The final wire rejects `max_output_tokens` and schedule metadata. This explicit smoke does not use the campaign ledger, establish remote billing/token ceilings, authorize the full campaign or prove model reliability. Preserve every development invocation and usage record separately; never pool it into the frozen holdout.


## Bounded entire-input scope repair — 2026-10-15

`task_scope_repair` is an intrinsic Pi task-metadata tool. It is offered only for the single classifier contradiction where a supported computation has no typed predicates but a nonempty free-text filter description. Its exact schema is `{population:"entire_input",goalQuote:string}`; unknown fields, business predicates and answer values are rejected. The quote must occur verbatim in the original goal and match a conservative unrestricted full-population phrase. Negation, exclusion, immediate restrictions, known entity references, unresolved references and time constraints remain blocked. Unsupported phrasing requires clarification rather than guessed intent. This validates a bounded declaration of explicit population; it is not a general natural-language proof engine.

The task owns the two-proposal counter across scope revisions and fresh leases. Proposals use the existing tool/provider budgets and supply no computation receipt or dataset mutation. Current bindings are checked around the asynchronous scope digest before publishing. The shared validator rechecks the unchanged method/columns/policies and required dataset output; successful metadata advances revision and updates the host plan. Programs and candidate tools cannot run while computation scope is unresolved. Dependency-producing scope repair must finish in a separate assistant turn before program authoring/execution. Exact approval retains the repaired artifact/scope on its normal fresh lease.

The operator driver supports a local protocol fixture and a deployment pin. From `frontend/`, using actual Node 22, new report destinations and the SHA-256 of the current root `SHA256SUMS.txt`:

```sh
node scripts/coding-agent-evaluation/s8-2-demo.mjs --local-scope-mock --output /tmp/scope-local-new.json --expect-site-manifest <sha256>
node scripts/coding-agent-evaluation/s8-2-demo.mjs --live-demo --case S8-4 --output /tmp/scope-live-new.json --expect-site-manifest <sha256>
```

`--local-scope-mock` defaults to S8-4 and fulfills HTTP locally with native Responses JSON/SSE fixtures. It reads only frozen agent files, deliberately emits the contradictory classifier description and scripts scope repair, full candidate construction, a bounded revision after the worker failure, exact approval and a separate BigInt mean computation. It never reads the oracle or a canonical answer, hardcodes no fact rows or analytical sums, and makes zero actual provider calls. Synthetic protocol usage is labeled separately from live usage. The ordinary external evaluator scores the sealed export using all unchanged gates.

`--expect-site-manifest` rejects a mismatched build before browser/network launch; always wait for local publication to exit before capturing this pin. Existing `--live-demo --output ...` and `--case S8-2|S8-4` behavior is retained. Request and task budgets, wire omission of `max_output_tokens`, fault metadata custody, exact approval and full qualification thresholds are unchanged. A local pass proves protocol/runtime integration, and a single real scoped pass proves that recorded invocation only; neither is full model/profile qualification.
## Live launch prerequisites and current-context capture — 2026-10-15

This section supersedes older statements that isolated settings cannot be captured. `runtimeCapture.mjs` reads only the fresh evaluation context, checks its expected provider/models/reasoning, fallback, permission policy, runtime settings, absent credentials/user or disabled skills, empty workspace/data/conversation and idle execution. The browser adapter requires the frozen candidate and performs this check before each run. It rejects drift before entering the production model path. The capture belongs to that context; a later live process must perform its own check.

`liveHttpAdapter.mjs` retains request-body, prompt-input and tool-schema SHA-256 projections without persisting raw headers/prompts or granting evidence authority. HTTP 200 and 201 session responses are supported; missing/over-bound provider usage and uncertain attempts keep the original fail-closed accounting. These changes do not enable a remote transport.

From `frontend/`, under actual Node >=22.13 and <23, use a fresh report destination and a current immutable qualification manifest:

```sh
node scripts/coding-agent-launch-readiness.mjs --offline --suite docs/coding-agent/evidence/fixtures-v1 --manifest <current-packet.json> --output <new-offline.json> --browser '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
node scripts/coding-agent-launch-readiness.mjs --demo-probe --suite docs/coding-agent/evidence/fixtures-v1 --manifest <current-packet.json> --output <new-demo.json> --browser '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
```

The second command requires explicit demo diagnostic authorization. It sends only a short public synthetic request, at most one session plus one provider request, with no automatic retry, 4,096 request bytes, 2 MiB observed response bytes and a 45-second fetch deadline. These are client diagnostic controls, not billable token/cost bounds. `max_output_tokens` remains absent. It persists a running/uncertain record before each dispatch, omits credentials and response content, and refuses an existing output or a destination in the corpus. Do not replay an incomplete probe automatically.

`launchReadiness.mjs` binds the report to the current qualification/deployment hashes, derives the process status from the same gate fields and keeps `launchReady`/`liveRunAuthorized` false. Exit 2 means valid preparation with concrete remaining blockers; exit 1 means invalid input, drift, execution or publication. The existing zero-call candidate remains immutable and intentionally reports no live capture/authorization; its offline preflight must not be edited to claim new runtime observations. The separate readiness report owns those observations.

Current scoped observations expose `demo-auto` and native token usage, with session HTTP 201. They disclose no authoritative physical provider/model, routing/pricing revision, maximum billable input/output, rejection/retry billing or cancellation billing. The report lists these required provider/operator fields as null. No pricing estimate or global ceiling is invented. Positive finite campaign call/input/output/micro-USD allowances must be reviewed against that contract and exact pins before enabling full dispatch.

Nine local native fault diagnostics validate per-run capture, real guest failure/revision plumbing, hashes and ledger reconciliation. They deliberately end with clarification and qualify no model autonomy or accepted analytical answer. The unchanged 180 live runs, nine live fault recoveries, 108/120 solvable, 12/15 per family, 29/30 ambiguity, zero critical failures and all deterministic/evidence/novel-method requirements remain outstanding acceptance. See the local CA-173 prerequisites report for exact commands, intermediate failures and current pins.
