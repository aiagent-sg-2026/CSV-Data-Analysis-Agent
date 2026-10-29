import { dU as restoreAgentTask, dV as codeDigest, dW as DEFAULT_TASK_LIMITS, dX as verifyAcceptedSpillMarker, dY as getStorageDatabase, dZ as commitIntentKey, bk as restoreAcceptedDataset, d_ as commitHeadKey, d$ as datasetCommitBindings, e0 as chargeTaskBudget, e1 as resumeTaskBudget, e2 as SOURCE_STREAM_LIMITS, e3 as pauseTaskBudget, aZ as persistCurrentAppSessionSnapshot, e4 as seedRecoveredSourceStreamBudget, e5 as bindRecoverySource, b0 as rootStore, e6 as bindSpillCandidateValidationContract, e7 as preparePiExecutor, e8 as createCandidateCommitService, aX as assertRunActive, e9 as DATASET_COMMITS_STORE, ea as readExactCommit, eb as reconstructDatasetCommit, ec as readRetainedRows, ed as installVerifiedDatasetCommit, ee as verifyReplayManifest, bh as canCommitRun, ef as commitApprovalKey, R as queueSessionWrite, eg as commitDatasetTransaction, T as buildPersistedReportRecord, eh as resolveAllowedTools, ei as buildToolAvailabilityContext, ej as buildBuiltinToolRegistry } from "./csv_data_analysis_app-agent-DrJ_9197.js";
const reviews$1 = /* @__PURE__ */ new WeakMap();
const own$1 = (store) => {
  var _a;
  const lease = (_a = store.executionContext) == null ? void 0 : _a.lease;
  if (!lease) throw new Error("scope_revoked");
  assertRunActive(store, lease);
  return lease;
};
const recoverSpillCandidate = async (store, checkpoint, options, dependencies) => {
  var _a, _b, _c;
  const lease = own$1(store), { digest, ...body } = checkpoint, proposal = checkpoint.proposal, task = restoreAgentTask(checkpoint.task);
  if (await codeDigest(body) !== digest || checkpoint.version !== 1 || checkpoint.repetitions >= 2 || task.status !== "awaiting_approval" || task.capabilityGrants.length || task.taskId !== proposal.audit.taskId || task.revision !== proposal.audit.taskRevision || task.scope.digest !== proposal.validation.scopeDigest || JSON.stringify(task.inputBindings) !== JSON.stringify(proposal.inputBindings) || Object.entries(task.budget.limits).some(([k, v]) => v > DEFAULT_TASK_LIMITS[k])) throw new Error("recovery_checkpoint_invalid");
  const manifest = await verifyAcceptedSpillMarker(proposal, true);
  own$1(store);
  const { digest: _manifestDigest, ...manifestBody } = manifest;
  if (await codeDigest(manifestBody) !== manifest.digest) throw new Error("accepted_manifest_invalid");
  own$1(store);
  const db = await (dependencies.database ?? getStorageDatabase)();
  own$1(store);
  const durable = await db.get("dataset_commits", commitIntentKey(proposal.sessionId, proposal.idempotencyKey));
  own$1(store);
  if (durable) {
    if (durable.kind !== "commit" || durable.activationFailed || durable.payloadDigest !== proposal.payloadDigest) throw new Error("approval_consumed");
    const marker = await restoreAcceptedDataset(store, options, dependencies);
    return { status: "already_committed", marker };
  }
  const head = await db.get("dataset_commits", commitHeadKey(proposal.sessionId));
  own$1(store);
  if (head && (head.kind !== "head" || head.commitId !== proposal.parentCommitId) || JSON.stringify(datasetCommitBindings(store.getState().datasetBundle)) !== JSON.stringify(proposal.inputBindings) || JSON.stringify((_a = store.getState().datasetBundle) == null ? void 0 : _a.source.inspection) !== JSON.stringify(manifest.source)) throw new Error("input_version_changed");
  if (!options.file) throw new Error("recovery_source_unavailable");
  const sourceSignature = JSON.stringify(store.getState().datasetBundle), current = () => {
    own$1(store);
    if (JSON.stringify(store.getState().datasetBundle) !== sourceSignature) throw new Error("input_version_changed");
  };
  const charge = chargeTaskBudget(resumeTaskBudget(task.budget), { transformationAttempts: 1, toolCalls: 2, activeMs: 5e3 });
  if (!charge.accepted) throw new Error("recovery_task_budget_exhausted");
  const previousBudget = checkpoint.spillSourceBudget ?? manifest.sourceBudget;
  if (previousBudget.readBytes + manifest.source.byteSize * 4 > SOURCE_STREAM_LIMITS.cumulativeReadBytes || previousBudget.attempts >= SOURCE_STREAM_LIMITS.attempts || previousBudget.activeMs >= SOURCE_STREAM_LIMITS.activeMs || previousBudget.steps >= SOURCE_STREAM_LIMITS.steps) throw new Error("source_stream_budget_exhausted");
  const chargedBody = {
    ...body,
    repetitions: checkpoint.repetitions + 1,
    task: { ...task, budget: pauseTaskBudget(charge.budget) },
    spillSourceBudget: {
      attempts: previousBudget.attempts + 1,
      readBytes: previousBudget.readBytes + manifest.source.byteSize * 4,
      activeMs: SOURCE_STREAM_LIMITS.activeMs,
      steps: SOURCE_STREAM_LIMITS.steps
    }
  };
  const charged = { ...chargedBody, digest: await codeDigest(chargedBody) };
  current();
  store.setState({ candidateRecovery: charged });
  if (!await (((_b = dependencies.persist) == null ? void 0 : _b.call(dependencies, store)) ?? persistCurrentAppSessionSnapshot(store.getState(), { store, scope: lease.scope }))) throw new Error("recovery_checkpoint_unavailable");
  current();
  seedRecoveredSourceStreamBudget(store, manifest.source, { ...previousBudget, readBytes: previousBudget.readBytes + manifest.source.byteSize });
  await bindRecoverySource(store, options.file, manifest.source);
  current();
  rootStore(store).candidateValidationContract = await bindSpillCandidateValidationContract(store, task.goal, manifest.meaning);
  current();
  const prep = await preparePiExecutor(store, { entryPoint: "follow_up", goal: task.goal, guest: options.guest, recoveryBudget: { ...charged.task.budget, used: { ...charged.task.budget.used, transformationAttempts: task.budget.used.transformationAttempts, toolCalls: task.budget.used.toolCalls + 1 } }, spillFactory: dependencies.spillFactory });
  try {
    const program = await store.codeExecution.workspace.write("/workspace/recovered-spill.js", proposal.program.content, 0);
    const request = {
      program: { path: program.path, revision: program.revision, sha256: program.sha256 },
      inputs: [],
      mode: "source_records",
      sourceRecords: { sourceId: manifest.source.sourceId, sha256: manifest.source.sha256, width: manifest.meaning.columns.length, initialState: structuredClone(proposal.spillRunRequest.sourceRecords.initialState) },
      output: { path: "/workspace/recovered-spill.json", expectedRevision: 0, format: "json" }
    };
    const context = { lease, toolCallId: "spill-recovery-code", stepId: "spill-recovery-code" };
    await prep.task.beforeTool("code.run", request, context.toolCallId);
    const execution = await store.codeExecution.run(request, context);
    current();
    prep.task.afterTool("code.run", { status: "success", toolName: "code.run", message: execution.reasonCode, shouldStop: false, artifacts: { codeExecution: execution } }, context);
    if (execution.status !== "succeeded") throw new Error(execution.reasonCode);
    const c = await store.candidateStaging.stage(execution.jobId, { lease, toolCallId: "spill-recovery-stage", stepId: "spill-recovery-stage" });
    const v = await store.candidateStaging.validate(c.candidateId, { lease, toolCallId: "spill-recovery-validate", stepId: "spill-recovery-validate" });
    current();
    if (v.decision !== "validated") throw new Error("recovery_validation_failed");
    prep.task.afterTool("candidate.validate", { status: "success", toolName: "candidate.validate", message: "Independently revalidated recovered spill.", shouldStop: false, artifacts: { candidate: { candidateId: c.candidateId } } }, { lease, toolCallId: "spill-recovery-validate", stepId: "spill-recovery-validate" });
    const service = createCandidateCommitService(store, { database: dependencies.database, acceptedStorage: dependencies.acceptedStorage, prepareSpillBinding: dependencies.prepareSpillBinding });
    const exact = await service.review(c.candidateId, { idempotencyKey: `recovered-${crypto.randomUUID()}`, primaryTable: manifest.meaning.table });
    const next = await service.recoveryCheckpoint(exact);
    store.setState({ candidateRecovery: next });
    if (!await (((_c = dependencies.persist) == null ? void 0 : _c.call(dependencies, store)) ?? persistCurrentAppSessionSnapshot(store.getState(), { store, scope: lease.scope }))) throw new Error("recovery_checkpoint_unavailable");
    const capsule = service.suspend(exact), pending = prep.task.suspend({ question: "Fresh recovered spill exact review", interactionKind: "approval", options: [] });
    store.setState({ activeAgentTask: prep.task.snapshot });
    const review = Object.freeze({ reviewId: exact.reviewId, digest: exact.reviewDigest, expiresAt: exact.expiresAt, checkpointId: next.checkpointId, tables: exact.tables, exact });
    reviews$1.set(review, {
      service,
      exact,
      capsule,
      owner: rootStore(store).getState,
      scope: lease.scope,
      runId: lease.runId,
      checkpointDigest: next.digest,
      goal: task.goal,
      continuation: pending.resumeContext.piTaskContinuation
    });
    return { status: "review", review };
  } finally {
    prep.task.close("blocked");
  }
};
const isLiveRecoveredSpill = (review) => reviews$1.has(review);
const commitRecoveredSpill = async (store, review) => {
  var _a;
  const lease = own$1(store), entry = reviews$1.get(review);
  if (!entry || entry.owner !== rootStore(store).getState || entry.scope !== lease.scope || entry.runId === lease.runId || ((_a = store.getState().candidateRecovery) == null ? void 0 : _a.digest) !== entry.checkpointDigest || Date.now() >= review.expiresAt) throw new Error("approval_invalid");
  reviews$1.delete(review);
  const prep = await preparePiExecutor(store, { entryPoint: "follow_up", goal: entry.goal, continuation: entry.continuation });
  try {
    await prep.task.beforeTool("candidate.commit", {}, `recovered-${entry.exact.reviewId}`);
    entry.service.resume(entry.capsule, store);
    const outcome = await entry.service.commit(entry.service.approve(entry.exact));
    own$1(store);
    if (outcome.status !== "committed" || outcome.acknowledgement !== "installed") throw new Error(outcome.reason ?? "committed_dataset_not_bound");
    prep.task.committed();
    return outcome.marker;
  } finally {
    prep.task.close("completed");
  }
};
const own = (store) => {
  var _a;
  const lease = (_a = store.executionContext) == null ? void 0 : _a.lease;
  if (!lease) throw new Error("scope_revoked");
  assertRunActive(store, lease);
  return lease;
};
const policy = (store) => {
  var _a, _b;
  const s = store.getState(), allowed = resolveAllowedTools(
    buildBuiltinToolRegistry(((_a = s.columnProfiles) == null ? void 0 : _a.map((c) => c.name)) ?? []),
    buildToolAvailabilityContext(s, { hasCsvData: Boolean(s.datasetBundle) })
  );
  if (!((_b = allowed.decisions["data.mutate"]) == null ? void 0 : _b.allowed)) throw new Error("capability_unavailable");
  return JSON.stringify(s.settings.runtimeAccessControl);
};
const checkpointDigest = (checkpoint) => codeDigest(checkpoint);
const verifyCheckpoint = async (checkpoint) => {
  var _a;
  const { digest, ...body } = checkpoint;
  if (body.version !== 1 || await checkpointDigest(body) !== digest || !/^candidate-recovery-[a-f0-9-]{36}$/.test(body.checkpointId) || !Number.isSafeInteger(body.repetitions) || body.repetitions < 0 || body.repetitions > 2 || typeof body.failureKey !== "string" || body.failureKey !== "" && !/^[a-f0-9]{64}$/.test(body.failureKey)) throw new Error("recovery_checkpoint_invalid");
  const task = restoreAgentTask(body.task);
  if (task.status !== "awaiting_approval" || task.capabilityGrants.length || task.taskId !== body.proposal.audit.taskId || task.sessionId !== body.proposal.sessionId || task.revision !== body.proposal.audit.taskRevision || task.scope.digest !== body.proposal.validation.scopeDigest || task.goal !== ((_a = body.proposal.replayManifest) == null ? void 0 : _a.validationBinding.goal) || JSON.stringify(task.inputBindings) !== JSON.stringify(body.proposal.inputBindings) || Object.entries(task.budget.limits).some(([key, value]) => value > DEFAULT_TASK_LIMITS[key])) throw new Error("recovery_checkpoint_invalid");
  await verifyReplayManifest(body.proposal);
  return task;
};
const reviews = /* @__PURE__ */ new WeakMap();
const recoverCandidateReview = async (store, options = {}, dependencies = {}) => {
  var _a, _b;
  const lease = own(store);
  let checkpoint = store.getState().candidateRecovery;
  if (!checkpoint) throw new Error("recovery_checkpoint_unavailable");
  const db = await (dependencies.database ?? getStorageDatabase)();
  own(store);
  const saved = await db.get("reports", lease.scope.sessionId);
  own(store);
  const canonical = saved == null ? void 0 : saved.appState.candidateRecovery;
  if ((canonical == null ? void 0 : canonical.checkpointId) === checkpoint.checkpointId && canonical.digest !== checkpoint.digest) {
    if (canonical.proposal.program.sha256 !== checkpoint.proposal.program.sha256 || canonical.proposal.validation.outputDigest !== checkpoint.proposal.validation.outputDigest) throw new Error("recovery_checkpoint_invalid");
    const dimensions = Object.keys(checkpoint.task.budget.used);
    const savedHigher = dimensions.some((k) => canonical.task.budget.used[k] > checkpoint.task.budget.used[k]);
    const liveHigher = dimensions.some((k) => canonical.task.budget.used[k] < checkpoint.task.budget.used[k]);
    if (savedHigher && liveHigher) throw new Error("recovery_checkpoint_conflict");
    if (savedHigher || !liveHigher && canonical.repetitions >= checkpoint.repetitions) {
      checkpoint = canonical;
      store.setState({ candidateRecovery: canonical });
    }
  }
  if (checkpoint.proposal.acceptedStreamedDual) throw new Error("recovery_streamed_dual_requires_fresh_meaning_and_execution");
  if (checkpoint.proposal.acceptedSpill) return recoverSpillCandidate(store, checkpoint, options, dependencies);
  const task = await verifyCheckpoint(checkpoint);
  own(store);
  const capturedPolicy = policy(store);
  const durable = await db.get(DATASET_COMMITS_STORE, checkpoint.proposal.recordId);
  own(store);
  if (durable) {
    if (durable.kind !== "commit" || durable.program.sha256 !== checkpoint.proposal.program.sha256 || durable.validation.outputDigest !== checkpoint.proposal.validation.outputDigest) throw new Error("idempotency_conflict");
    const head2 = await db.get(DATASET_COMMITS_STORE, commitHeadKey(durable.sessionId));
    own(store);
    if ((head2 == null ? void 0 : head2.kind) !== "head") throw new Error("commit_marker_invalid");
    const current = await readExactCommit(db, { sessionId: head2.sessionId, commitId: head2.commitId, revision: head2.revision });
    own(store);
    const result2 = await reconstructDatasetCommit(store, current, { ...options, readParent: (ref) => readExactCommit(db, ref), readMaterial: (m) => readRetainedRows(db, m, dependencies.directory) });
    own(store);
    store.setState({ datasetBundle: structuredClone(current.bundle), candidateRecovery: null, datasetCommitBindingStatus: "awaiting_source" });
    await installVerifiedDatasetCommit(store, db, current, result2, dependencies);
    return { status: "already_committed", marker: current };
  }
  const head = await db.get(DATASET_COMMITS_STORE, commitHeadKey(checkpoint.proposal.sessionId));
  own(store);
  if (head && (head.kind !== "head" || head.commitId !== checkpoint.proposal.parentCommitId)) throw new Error("input_version_changed");
  if (JSON.stringify(datasetCommitBindings(store.getState().datasetBundle)) !== JSON.stringify(checkpoint.proposal.inputBindings)) throw new Error("input_version_changed");
  if (checkpoint.repetitions >= 2) throw new Error("recovery_no_progress");
  let activeCharge = 5e3, cursor = checkpoint.proposal, depth = 0;
  while (cursor) {
    if (++depth > 17) throw new Error("recovery_chain_capacity");
    const manifest = await verifyReplayManifest(cursor);
    own(store);
    activeCharge += Number(cursor.environment.limits.timeoutMs) + 5e3;
    cursor = manifest.parent ? await readExactCommit(db, manifest.parent) : void 0;
    own(store);
  }
  const charged = chargeTaskBudget(resumeTaskBudget(task.budget), { transformationAttempts: 1, toolCalls: 2, activeMs: activeCharge });
  if (!charged.accepted) throw new Error("recovery_task_budget_exhausted");
  const { digest: _digest, ...body } = checkpoint;
  const chargedBody = { ...body, task: { ...task, budget: pauseTaskBudget(charged.budget) } };
  const next = { ...chargedBody, digest: await checkpointDigest(chargedBody) };
  own(store);
  store.setState({ candidateRecovery: next });
  if (!await (((_a = dependencies.persist) == null ? void 0 : _a.call(dependencies, store)) ?? persistCurrentAppSessionSnapshot(store.getState(), { store, scope: lease.scope }))) throw new Error("recovery_checkpoint_unavailable");
  own(store);
  let result;
  try {
    result = await reconstructDatasetCommit(store, checkpoint.proposal, {
      ...options,
      deadline: Date.now() + activeCharge,
      readParent: (ref) => readExactCommit(db, ref),
      readMaterial: (m) => readRetainedRows(db, m, dependencies.directory)
    });
    own(store);
  } catch (error) {
    if (canCommitRun(store, lease)) {
      const reason = error instanceof Error && /^[a-z_]+$/.test(error.message) ? error.message : "recovery_execution_failed";
      const key = await codeDigest([checkpoint.proposal.program.sha256, reason]);
      own(store);
      const { digest: _chargedDigest, ...failed } = next;
      const failedBody = { ...failed, failureKey: key, repetitions: checkpoint.failureKey === key ? checkpoint.repetitions + 1 : 1 };
      store.setState({ candidateRecovery: { ...failedBody, digest: await checkpointDigest(failedBody) } });
      own(store);
      await (((_b = dependencies.persist) == null ? void 0 : _b.call(dependencies, store)) ?? persistCurrentAppSessionSnapshot(store.getState(), { store, scope: lease.scope }));
    }
    throw error;
  }
  const reviewBody = {
    reviewId: `recovery-review-${crypto.randomUUID()}`,
    checkpointId: checkpoint.checkpointId,
    expiresAt: Date.now() + 3e5,
    tables: checkpoint.proposal.bundle.tables.map((t) => ({ name: t.name, rowCount: t.rowCount, columns: t.schema.map((c) => c.name) }))
  };
  const review = Object.freeze({ ...reviewBody, digest: await codeDigest({ ...reviewBody, checkpoint: next.digest, policy: capturedPolicy }) });
  own(store);
  reviews.set(review, { owner: rootStore(store).getState, scope: lease.scope, runId: lease.runId, checkpoint: next, result, policy: capturedPolicy });
  return { status: "review", review };
};
const commitRecoveredCandidate = async (store, review, dependencies = {}) => {
  var _a;
  if (isLiveRecoveredSpill(review)) return commitRecoveredSpill(store, review);
  const lease = own(store), prepared = reviews.get(review);
  if (!prepared || prepared.owner !== rootStore(store).getState || prepared.scope !== lease.scope || prepared.runId === lease.runId || Date.now() >= review.expiresAt || ((_a = store.getState().candidateRecovery) == null ? void 0 : _a.digest) !== prepared.checkpoint.digest || prepared.policy !== policy(store)) throw new Error("approval_invalid");
  const db = await (dependencies.database ?? getStorageDatabase)();
  own(store);
  const proposal = prepared.checkpoint.proposal, sessionId = lease.scope.sessionId;
  const key = commitIntentKey(sessionId, proposal.idempotencyKey), existing = await db.get(DATASET_COMMITS_STORE, key);
  own(store);
  if (existing) {
    if (existing.kind !== "commit" || existing.validation.outputDigest !== proposal.validation.outputDigest || existing.program.sha256 !== proposal.program.sha256) throw new Error("idempotency_conflict");
    await installVerifiedDatasetCommit(store, db, existing, prepared.result, dependencies);
    return existing;
  }
  const inputsUnchanged = () => {
    const bundle2 = store.getState().datasetBundle;
    if (!bundle2 || JSON.stringify(datasetCommitBindings(bundle2)) !== JSON.stringify(proposal.inputBindings)) throw new Error("input_version_changed");
  };
  inputsUnchanged();
  const head = await db.get(DATASET_COMMITS_STORE, commitHeadKey(sessionId));
  own(store);
  if (head && (head.kind !== "head" || head.commitId !== proposal.parentCommitId)) throw new Error("input_version_changed");
  const commitId = `commit-${crypto.randomUUID()}`, approvalId = `approval-${crypto.randomUUID()}`, now = (/* @__PURE__ */ new Date()).toISOString(), revision = (head == null ? void 0 : head.kind) === "head" ? head.revision + 1 : 1;
  const bundle = { ...structuredClone(proposal.bundle), acceptedCommit: { sessionId, commitId, revision }, updatedAt: now };
  const { digest: _oldManifestDigest, ...oldManifest } = proposal.replayManifest;
  const manifestBody = { ...oldManifest, validationBinding: { ...oldManifest.validationBinding, sessionId, sessionEpoch: lease.scope.epoch } };
  const manifest = { ...manifestBody, digest: await codeDigest(manifestBody) };
  own(store);
  const { receiptDigest: _oldReceiptDigest, ...oldValidation } = proposal.validation;
  const validationBody = {
    ...oldValidation,
    candidateId: `candidate-${crypto.randomUUID()}`,
    validationId: `validation-${crypto.randomUUID()}`,
    namespaceId: `recovery-${crypto.randomUUID()}`,
    taskRevision: prepared.checkpoint.task.revision + 1,
    sessionId,
    sessionEpoch: lease.scope.epoch,
    runId: lease.runId,
    turnId: lease.turnId,
    toolCallId: `host-recovery-${crypto.randomUUID()}`,
    stepId: `recovery-${crypto.randomUUID()}`,
    contractDigest: await codeDigest(manifest.validationBinding)
  };
  const validation = { ...validationBody, receiptDigest: await codeDigest(validationBody) };
  own(store);
  const committedBudget = chargeTaskBudget(resumeTaskBudget(prepared.checkpoint.task.budget), { toolCalls: 1 });
  if (!committedBudget.accepted) throw new Error("recovery_task_budget_exhausted");
  const marker = {
    ...structuredClone(proposal),
    sessionId,
    commitId,
    revision,
    taskBudget: committedBudget.budget,
    recordId: key,
    intentKey: key,
    approvalKey: commitApprovalKey(sessionId, approvalId),
    parentCommitId: (head == null ? void 0 : head.kind) === "head" ? head.commitId : null,
    bundle,
    replayManifest: manifest,
    validation,
    candidateId: validation.candidateId,
    payloadDigest: await codeDigest({ checkpoint: prepared.checkpoint.digest, review: review.digest, sessionId, commitId }),
    audit: {
      ...proposal.audit,
      sessionEpoch: lease.scope.epoch,
      taskRevision: validation.taskRevision,
      runId: lease.runId,
      turnId: lease.turnId,
      toolCallId: validation.toolCallId,
      stepId: validation.stepId,
      grantDigest: await codeDigest({ kind: "host-local-recovery", scope: lease.scope, runId: lease.runId, review: review.digest }),
      committedAt: now
    },
    previousCommit: manifest.inputBundle.acceptedCommit,
    approval: { approvalId, reviewDigest: review.digest, approvedAt: Date.now(), expiresAt: review.expiresAt, consumedAt: Date.now() }
  };
  own(store);
  let admitted = false;
  try {
    await queueSessionWrite(async () => {
      own(store);
      return commitDatasetTransaction(
        db,
        marker,
        buildPersistedReportRecord(store.getState(), { id: sessionId, filename: bundle.source.fileName }),
        () => {
          var _a2;
          own(store);
          inputsUnchanged();
          if (((_a2 = store.getState().candidateRecovery) == null ? void 0 : _a2.digest) !== prepared.checkpoint.digest || prepared.policy !== policy(store)) throw new Error("approval_invalid");
        },
        () => {
          admitted = true;
          store.setState({ datasetCommitBindingStatus: "commit_unknown", activeDataQuery: null, datasetSemanticSnapshot: null });
        }
      );
    });
  } catch (error) {
    if (!admitted) throw error;
    let durable;
    try {
      durable = await db.get(DATASET_COMMITS_STORE, key);
    } catch {
      throw new Error("commit_outcome_unknown");
    }
    if ((durable == null ? void 0 : durable.kind) !== "commit" || durable.payloadDigest !== marker.payloadDigest) throw new Error("recovery_not_committed");
  }
  own(store);
  await installVerifiedDatasetCommit(store, db, marker, prepared.result, dependencies);
  return marker;
};
export {
  commitRecoveredCandidate as c,
  recoverCandidateReview as r
};
