# Synthetic Coding-Agent Evaluation Foundation

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
