import { dn as isCandidateMeaningProposal, aq as awaitOwned, dp as captureCodeTables, dq as readSourceRecords, dr as compileInferredCandidateMeaning, ds as bindCandidateValidationContract, aT as codeDigest, as as assertRunActive } from "./csv_data_analysis_app-agent-DMkbLCXM.js";
import "./csv_data_analysis_vendor-ai-sdk-_uigGMKR.js";
import "./csv_data_analysis_vendor-storage-Dda2oZrY.js";
import "./csv_data_analysis_vendor-data-CIO9Xlwr.js";
import "./csv_data_analysis_vendor-react-core-DlbdMisc.js";
import "./csv_data_analysis_vendor-ai-google-CG5mTmqq.js";
import "./csv_data_analysis_vendor-ai-openai-Daj-t9pP.js";
const inferCandidateMeaning = async (store, proposal) => {
  var _a;
  if (!isCandidateMeaningProposal(proposal)) throw new Error("meaning_proposal_invalid");
  const context = store.executionContext, task = store.piTask, port = store.candidateStaging;
  if (!context || !task || !port || !store.codeExecution) throw new Error("meaning_task_unavailable");
  const lease = context.lease, version = task.snapshot.revision, binding = structuredClone(task.snapshot.inputBindings);
  const p = structuredClone(proposal);
  const source = (_a = store.getState().datasetBundle) == null ? void 0 : _a.source.inspection;
  const check = () => {
    var _a2, _b;
    assertRunActive(store, lease);
    const now = store.getState().datasetBundle;
    if (task.snapshot.revision !== version || JSON.stringify(task.snapshot.inputBindings) !== JSON.stringify(binding) || binding.some((b) => !(now == null ? void 0 : now.tables.some((t) => t.tableId === b.tableId && t.datasetVersion === b.datasetVersion)) || now.relationshipSetId !== b.relationshipSetId) || ((_a2 = now == null ? void 0 : now.source.inspection) == null ? void 0 : _a2.sourceId) !== (source == null ? void 0 : source.sourceId) || ((_b = now == null ? void 0 : now.source.inspection) == null ? void 0 : _b.sha256) !== (source == null ? void 0 : source.sha256)) throw new Error("input_version_changed");
    const jobs = store.codeExecution.inspect(void 0, context);
    if (!Array.isArray(jobs) || jobs.length || port.validationRequirements().configured) throw new Error("meaning_contract_locked");
  };
  check();
  const inputs = { tables: {}, sources: {} };
  let captured;
  if (p.input.kind === "table") {
    captured = await awaitOwned(captureCodeTables(store, [{ name: p.input.name, tableId: p.input.tableId }], binding, 8 * 1024 * 1024, check), store, lease);
    inputs.tables[p.input.name] = captured.tables[p.input.name].rows;
  } else {
    if (!source || source.recordCount > 5e4 || source.byteSize > 8 * 1024 * 1024 || source.diagnostics.some((d) => d === "invalid_utf8" || d === "unclosed_quote")) throw new Error("meaning_complete_source_unavailable");
    const rows = [];
    for (let row = 0; row < source.recordCount; row++) {
      const record = readSourceRecords(store, source.sourceId, row, 1).records[0];
      if (!record || record.diagnostics.length) throw new Error("meaning_source_parse_unresolved");
      rows.push(record.cells.map((c) => c.value));
      if ((row + 1) % 5e3 === 0) {
        await awaitOwned(new Promise((resolve) => setTimeout(resolve, 0)), store, lease);
        check();
      }
    }
    inputs.sources[p.input.name] = rows;
  }
  check();
  captured == null ? void 0 : captured.check();
  const compiled = compileInferredCandidateMeaning(p, inputs);
  const host = await awaitOwned(bindCandidateValidationContract(store, task.snapshot.goal, compiled.contract), store, lease);
  check();
  captured == null ? void 0 : captured.check();
  if (captured == null ? void 0 : captured.coverage.some((c) => host.tableDigests[c.tableId] !== c.sha256)) throw new Error("input_version_changed");
  const proposalDigest = await awaitOwned(codeDigest(p), store, lease);
  check();
  return port.bindInferredMeaning({ ...host, inference: { kind: "ai_inferred", input: p.input, assumptions: compiled.assumptions, proposalDigest } }, context);
};
export {
  inferCandidateMeaning
};
