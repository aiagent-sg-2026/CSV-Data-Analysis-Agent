import type { StoreApi } from '../../types';
import type { ClarificationRequest, ToolExecutionResult } from '../../../../types';
import { assertRunActive, awaitOwned, canCommitRun, ownsRun, ownsSessionScope, registerSessionResource, rootStore } from '../../../session/sessionOwnership';
import { sha256Bytes } from '../../../data/sourceDigest';
import { createTaskWorkspace, type TaskWorkspace } from '../../taskWorkspace';
import { createCodeExecutionAdapter } from '../../execution/codeExecutionAdapter';
import { createCandidateStaging, type CandidateStagingPort } from '../../../data/candidateStaging';
import { validateCodeRunRequest, type CodeExecutionReceipt } from '../../execution/codeExecutionContract';
import { createAgentTask, serializeTaskAnswerScope, reviseAgentTaskScope, transitionAgentTask, type AgentTaskContract, type TaskOutputRequirement } from './piTaskContract';
import { chargeTaskBudget, resumeTaskBudget, DEFAULT_TASK_LIMITS, type TaskBudget } from './piTaskBudget';
import type { ResolvedAnswerScope } from './queryEvidence';
import { createTaskInspection, type TaskInspectionProjection } from './piTaskInspection';
import { registerTaskExports } from './piTaskExports';
import {captureSkillSnapshot,assertPinnedSkillCurrent,skillAvailability,type SkillSnapshot,type PinnedSkill} from '../../skills/skillSnapshot';
import {normalizeRuntimeAccessControlSettings} from '../../../runtimeAccessControl';
import { captureMcpTask } from '../../connectors/mcpConnectorRegistry';
import { projectTypedTaskPlan, type TypedTaskPlan, type TaskRepairCommit } from './piTaskPlan';
import { admitComputationEvidence, type ComputationEvidenceReceipt } from '../../execution/computationEvidence';

export interface PiTaskContinuation { taskId: string; revision: number; scopeDigest: string }
type Adapter = ReturnType<typeof createCodeExecutionAdapter>;
type Guest = Parameters<typeof createCodeExecutionAdapter>[3];
type RecordState = { task: AgentTaskContract; workspace: TaskWorkspace; skills:SkillSnapshot; mcp:import('../../connectors/httpMcpContract').McpTaskPort; skillPrograms:Map<string,{pin:PinnedSkill;reference:import('../../execution/codeExecutionContract').CodeArtifactRef}>; coding: boolean; failureKey: string; repetitions: number; repairCommit?: TaskRepairCommit; retire?: () => void; inspection?: TaskInspectionProjection };
const tasks = new WeakMap<StoreApi['getState'], RecordState>();
const digest = (value: unknown) => sha256Bytes(new TextEncoder().encode(JSON.stringify(value)));
const codingTool = (name: string) => name.startsWith('code.') || name.startsWith('candidate.') || ['workspace.write', 'workspace.append', 'workspace.replace'].includes(name);

/** Session-retained task state is host-owned. A saved continuation is only a locator, never executable authority. */
export const preparePiTask = async (store: StoreApi, message: string, continuation?: PiTaskContinuation, guest?: Guest, recoveryBudget?: TaskBudget): Promise<PiCodingTask> => {
    if (store.piTask) return store.piTask;
    const lease = store.executionContext?.lease;
    if (!lease) throw new Error('scope_revoked');
    assertRunActive(store, lease);
    const root = rootStore(store), key = root.getState;
    let record: RecordState;
    const prior = tasks.get(key);
    if (continuation) {
        if (!prior || !ownsSessionScope(store, lease.scope) || prior.task.taskId !== continuation.taskId
            || prior.task.revision !== continuation.revision || prior.task.scope.digest !== continuation.scopeDigest
            || !['awaiting_clarification', 'awaiting_approval'].includes(prior.task.status)) throw new Error('task_continuation_unavailable');
        record = prior;
        record.task = transitionAgentTask(store, record.task, lease,
            record.task.status === 'awaiting_approval' ? 'committing' : 'inspecting');

    } else {
        prior?.retire?.(); prior?.workspace.dispose();
        const intentDigest = await awaitOwned(digest(message), store, lease);
        const answer: ResolvedAnswerScope = { requiresEvidence: false, queries: [], unresolved: [], complete: false };
        const state = store.getState();
        const skills=await awaitOwned(captureSkillSnapshot(state.workspaceFiles),store,lease);
        let task = createAgentTask(store, lease, { goal: message.slice(0, 4000), kind: lease.kind === 'initial_analysis' ? 'artifact' : 'conversation',
            requiredOutputs: lease.kind === 'initial_analysis' ? [{id:'staged-output',kind:'artifact',required:true}] : [{ id: 'reply', kind: 'answer', required: true }], protectedInvariants: [{id:'skill-snapshot',digest:skills.digest}], capabilityGrants: [],
            inputBindings: (state.datasetBundle?.tables ?? []).slice(0, 20).map(table => ({ tableId: table.tableId,
                datasetVersion: table.datasetVersion, relationshipSetId: state.datasetBundle!.relationshipSetId })),
            scope: { digest: await awaitOwned(sha256Bytes(new TextEncoder().encode(serializeTaskAnswerScope(answer))), store, lease), intentDigest, answer } });
        task = transitionAgentTask(store, task, lease, 'inspecting');
        if(recoveryBudget){
            const budget=resumeTaskBudget(recoveryBudget);
            if(Object.entries(budget.limits).some(([key,value])=>value>DEFAULT_TASK_LIMITS[key as keyof typeof DEFAULT_TASK_LIMITS]))throw new Error('task_budget_invalid');
            // Recovery carries consumed counters only. Fresh task/workspace/grants remain host-issued.
            task={...task,budget};
        }
        // A namespace survives user suspension. Every async publication also checks the current run separately.
        const mcp = await awaitOwned(captureMcpTask(store, task.taskId, () => tasks.get(key) === record), store, lease);
        const workspace = createTaskWorkspace(root, task.taskId, { allowedPrefixes: ['/workspace/'], allowedPaths: ['/dataset/cleaned.csv'] });
        task = { ...task, protectedInvariants: [...task.protectedInvariants, { id: 'mcp-snapshot', digest: mcp.digest }] };
        record = { task, workspace, skills,mcp,skillPrograms:new Map(), coding: false, failureKey: '', repetitions: 0 };
        tasks.set(key, record);
        const captured = record;
        registerSessionResource(lease.scope, () => { captured.retire?.(); captured.workspace.dispose(); if (tasks.get(key) === captured) tasks.delete(key); });
    }
    if (record.task.status !== 'committing') record.task = { ...record.task, capabilityGrants: [] };
    let adapter: Adapter | undefined, closed = false, blockedReason = '', executionAccepted = false, lastTick = performance.now();
    const receipts: Readonly<CodeExecutionReceipt>[] = [];
    const computations: ComputationEvidenceReceipt[] = [];
    let candidatePort: CandidateStagingPort | undefined, candidateRequested = false, candidateAccepted = false;
    let deferApprovalPublication=false;
    let validationRequested=false,validatedCandidateId='',lastValidationCandidateId='',activeValidationCall='';
    const chargedCalls = new Set<string>();
    const inspection = createTaskInspection(store, lease, record.workspace, record.task.taskId, record.inspection);
    const captureExport = registerTaskExports(store, lease, record.workspace, record.task.taskId);
    const current = () => { assertRunActive(store, lease); if (closed || tasks.get(key) !== record) throw new Error('scope_revoked'); };
    const publish = () => { if (!(deferApprovalPublication && record.task.status === 'awaiting_approval') && canCommitRun(store, lease) && tasks.get(key) === record) {
        store.setState({ activeAgentTask: record.task }); inspection.publish();
    } };
    const charge = (delta: Parameters<typeof chargeTaskBudget>[1]) => {
        current();
        const now = performance.now(), elapsed = Math.max(0, Math.floor(now - lastTick)); lastTick = now;
        const charged = chargeTaskBudget(record.task.budget, { ...delta, activeMs: elapsed });
        if (charged.accepted === false) { blockedReason ||= `${charged.reason}${charged.dimension ? `:${charged.dimension}` : ''}`; throw new Error(blockedReason); }
        record.task = { ...record.task, budget: charged.budget }; publish();
    };
    const move = (status: AgentTaskContract['status']) => {
        if (record.task.status !== status) record.task = transitionAgentTask(store, record.task, lease, status);
        publish();
    };
    const activateCoding = (name: string) => {
        if (!codingTool(name)) return;
        record.coding = true;
        if (!record.task.scope.answer.requiresEvidence) record.task = { ...record.task, kind: 'artifact', requiredOutputs: [
            ...record.task.requiredOutputs.filter(output => output.id !== 'staged-output'
                && (lease.kind === 'initial_analysis' || output.kind === 'card')), { id: 'staged-output', kind: 'artifact', required: true }] };
        if (['inspecting', 'validating', 'verifying'].includes(record.task.status)) move('programming');
    };
    const ensureAdapter = () => {
        current();
        adapter ??= createCodeExecutionAdapter(store, record.workspace, () => record.task, guest);
        store.codeExecution = adapter;
        return adapter;
    };
    const assertSupportAvailable=(pin:PinnedSkill,path:string)=>{
        current();assertPinnedSkillCurrent(store,pin);
        const availability=skillAvailability(store,{...pin,manifest:{...pin.manifest,requires:[...pin.manifest.requires,'workspace.write','code.run']}});
        if(!availability.available)throw new Error(availability.reasons.join(','));
        const denied=normalizeRuntimeAccessControlSettings(store.getState().settings.runtimeAccessControl).workspaceRules.deniedPathPrefixes;
        if(denied.some(prefix=>prefix==='/'||path===prefix||path.startsWith(prefix.endsWith('/')?prefix:prefix+'/')))throw new Error('capability_unavailable:workspace.write');
    };
    const task: PiCodingTask = {
        get skills(){return record.skills;},
        async loadSkillProgram(pin,file){
            current();
            if(!record.skills.entries.includes(pin)||!pin.manifest.supportingFiles.includes(file)||file.kind!=='javascript')throw new Error('skill_support_not_pinned');
            const path=`/workspace/skill-support/${record.skills.digest}/${pin.skill.name}/${file.sha256}.js`;
            assertSupportAvailable(pin,path);
            const previous=record.skillPrograms.get(path);
            if(previous)return previous.reference;
            const artifact=await record.workspace.write(path,pin.supportingSources[file.path],0,()=>assertSupportAvailable(pin,path));
            assertSupportAvailable(pin,path);
            const reference=Object.freeze({path:artifact.path,revision:artifact.revision,sha256:artifact.sha256});
            if(reference.sha256!==file.sha256)throw new Error('skill_support_hash_mismatch');
            record.skillPrograms.set(path,{pin,reference});return reference;
        },
        get snapshot() { return record.task; }, get coding() { return record.coding; }, get blockedReason() { return blockedReason; },
        get plan() {
            current();
            const bundle = store.getState().datasetBundle;
            const repairCommit = record.repairCommit?.commitId === bundle?.acceptedCommit?.commitId
                && record.repairCommit?.datasetVersion === bundle?.datasetVersion ? record.repairCommit : undefined;
            const execution = executionAccepted ? receipts.at(-1) : undefined;
            const successfulJobId = execution?.taskRevision === record.task.revision && execution.program && execution.output
                && [execution.program,execution.output].every(ref=>{
                    const actual=record.workspace.read(ref.path); return actual.revision===ref.revision&&actual.sha256===ref.sha256;
                }) ? execution.jobId : undefined;
            let candidateId: string | undefined, candidateValidated = false;
            try {
                const candidate = candidatePort?.list().at(-1);
                if (candidate?.execution.jobId === successfulJobId) {
                    candidateId=candidate.candidateId;
                    candidateValidated=candidatePort?.validationReceipt(candidateId)?.decision==='validated';
                }
            } catch { /* Invalidated candidates cannot advance the plan. */ }
            return projectTypedTaskPlan(record.task,{meaningConfigured:Boolean(candidatePort?.validationRequirements().configured),
                candidateId,candidateValidated,successfulJobId,repairCommit,
                computationAccepted:Boolean(computations.length&&admitComputationEvidence(store,lease,computations).receipt)});
        },
        recoverySnapshot() { current(); return { task:structuredClone(record.task),failureKey:record.failureKey,repetitions:record.repetitions }; },
        attach(target) {
            current(); target.piTask = task; target.codeExecution = ensureAdapter(); target.mcpTools = record.mcp;
            if (!candidatePort) {
                candidatePort = createCandidateStaging(store, record.workspace, () => record.task, adapter!);
                const previousRetire = record.retire, port = candidatePort, execution = adapter!;
                record.retire = () => { previousRetire?.(); port.dispose(); execution.dispose(); };
            }
            target.candidateStaging = candidatePort;
        },
        committed() {
            const bundle=store.getState().datasetBundle;
            if (!bundle?.acceptedCommit) throw new Error('task_repair_commit_required');
            record.repairCommit={commitId:bundle.acceptedCommit.commitId,datasetVersion:bundle.datasetVersion};
            move('verifying'); task.refreshInputs();
        },
        requireOutputs(outputs) {
            current();
            if (record.task.status !== 'inspecting' && record.task.status !== 'committing' && record.task.status !== 'verifying') throw new Error('task_output_contract_locked');
            record.task = { ...record.task, requiredOutputs: structuredClone([...outputs,
                ...record.task.requiredOutputs.filter(output=>output.id==='repaired-dataset'&&!outputs.some(next=>next.id===output.id))]) }; publish();
        },
        rejectApproval() { current(); record.task = transitionAgentTask(store, record.task, lease, 'blocked'); publish(); },
        refreshInputs() {
            current();
            const state = store.getState();
            const next = (state.datasetBundle?.tables ?? []).slice(0, 20).map(table => ({tableId:table.tableId,
                datasetVersion:table.datasetVersion,relationshipSetId:state.datasetBundle!.relationshipSetId}));
            if (JSON.stringify(next) === JSON.stringify(record.task.inputBindings)) return;
            record.task.capabilityGrants.forEach(grant => adapter?.revoke(grant.id));
            record.task = {...record.task,revision:record.task.revision+1,inputBindings:next,capabilityGrants:[]};
            receipts.length = 0; executionAccepted = false; publish();
        },
        async resolveScope(answer) {
            current();
            const scopeDigest = await awaitOwned(sha256Bytes(new TextEncoder().encode(serializeTaskAnswerScope(answer))), store, lease);
            const revised = reviseAgentTaskScope(store, record.task, lease, { digest: scopeDigest, intentDigest: record.task.scope.intentDigest, answer });
            if (revised.invalidated.length) record.task.capabilityGrants.forEach(grant => adapter?.revoke(grant.id));
            record.task = { ...revised.task, kind: answer.requiresEvidence ? 'analysis' : record.coding ? 'artifact' : 'conversation',
                ...(answer.requiresEvidence ? {requiredOutputs:[{id:'reply',kind:'answer' as const,required:true}]} : {}),
                capabilityGrants: revised.invalidated.length ? [] : revised.task.capabilityGrants };
            if (answer.dataPreparation === 'canonical_fact_table') record.task={...record.task,requiredOutputs:[
                ...record.task.requiredOutputs.filter(output=>output.id!=='repaired-dataset'),{id:'repaired-dataset',kind:'dataset',required:true}]};
            // Supported computations require owned code execution; inspection must share that task's existing budget.
            if (answer.computation || answer.dataPreparation) record.coding = true;
            if (revised.invalidated.length) { receipts.length = 0; executionAccepted = false; }
            publish();
        },
        providerTurn(ordinaryLimit) {
            if (!record.coding && ordinaryLimit && record.task.budget.used.providerTurns >= ordinaryLimit) {
                blockedReason = 'task_budget_exhausted:providerTurns'; throw new Error(blockedReason);
            }
            charge({ providerTurns: 1 });
        },
        skillRead(toolCallId) {
            if (toolCallId) chargedCalls.add(toolCallId);
            if (!record.coding && record.task.budget.used.skillReads >= 2) throw new Error('The limit of 2 skill reads per ordinary request was reached.');
            charge({ skillReads: 1 });
        },
        async beforeTool(name, args, toolCallId) {
            if (toolCallId) chargedCalls.add(toolCallId);
            if (blockedReason) throw new Error(blockedReason);
            current();
            const request=args as {path?:unknown;output?:{path?:unknown}}|undefined;
            const target=name==='code.run'?request?.output?.path:request?.path;
            if((name==='code.run'||['workspace.write','workspace.append','workspace.replace'].includes(name))
                &&typeof target==='string'&&(target==='/workspace/skill-support'||target.startsWith('/workspace/skill-support/')))
                throw new Error('skill_support_readonly');
            if(name.startsWith('workspace.')&&args&&typeof args==='object'&&typeof (args as {path?:unknown}).path==='string'
                &&/^\/?skills(?:\/|$)/.test((args as {path:string}).path))throw new Error('skill_requires_pinned_loading');
            if(name.startsWith('workspace.')&&args&&typeof args==='object'){
                const {path,comparePath}=args as {path?:unknown;comparePath?:unknown};
                const recursive=['workspace.search','workspace.grep','workspace.list','workspace.tree'].includes(name);
                for(const [programPath,support] of record.skillPrograms){
                    if([path,comparePath].some(value=>value===programPath||(recursive&&(value===undefined||value==='/'
                        ||(typeof value==='string'&&programPath.startsWith(value.endsWith('/')?value:value+'/'))))))
                        assertPinnedSkillCurrent(store,support.pin);
                }
            }
            if(name==='code.run'&&validateCodeRunRequest(args)){
                for(const reference of [args.program,...args.inputs]){
                    const support=record.skillPrograms.get(reference.path);
                    if(!support)continue;
                    assertPinnedSkillCurrent(store,support.pin);
                    const availability=skillAvailability(store,support.pin);
                    if(!availability.available)throw new Error(availability.reasons.join(','));
                    if(reference.revision!==support.reference.revision||reference.sha256!==support.reference.sha256)throw new Error('skill_support_artifact_changed');
                }
            }
            if (name === 'code.run') executionAccepted = false;
            if (name === 'candidate.stage' || name === 'candidate.infer_meaning') { candidateRequested = true; candidateAccepted = false; }
            if (name === 'candidate.validate') {validationRequested=true;validatedCandidateId='';lastValidationCandidateId='';activeValidationCall=toolCallId??crypto.randomUUID();}
            activateCoding(name);
            charge({ toolCalls: 1, ...(name === 'code.run' ? { transformationAttempts: 1 } : {}) });
            if (name === 'computation.validate') task.assertComputationReady();
            if (name === 'code.run') {
                // A rejected repair interpretation must remain correctable before any guest job locks meaning.
                if ((candidateRequested || record.task.scope.answer.dataPreparation && !task.plan.repairCommit)
                    && !candidatePort?.validationRequirements().configured) throw new Error(
                    'candidate_meaning_required_before_execution: Correct the rejected meaning proposal before code_run. Table rows exclude CSV headers; source rows are physical records. Use the matching input kind, row range and column coordinates.');
                if (!validateCodeRunRequest(args)) return;
                const port = ensureAdapter();
                const request = args;
                // Grant paths are constrained by task workspace and central governance; model lineage is never accepted.
                const grant = await port.issueGrant({ readPaths: [...new Set([request.program.path, ...request.inputs.map(input => input.path)])],
                    writePaths: [request.output.path], sources: (request.sources ?? []).map(source => ({ sourceId: source.sourceId, sha256: source.sha256 })),
                    tableIds: (request.tables ?? []).map(table => table.tableId),
                    expiresAt: Date.now() + Math.max(1, record.task.budget.limits.activeMs - record.task.budget.used.activeMs) });
                current();
                for(const reference of [request.program,...request.inputs]){
                    const support=record.skillPrograms.get(reference.path);
                    if(support)assertSupportAvailable(support.pin,reference.path);
                }
                record.task = { ...record.task, capabilityGrants: [grant] }; move('executing');
            }
        },
        afterTool(name, result, context) {
            current();
            inspection.observe(record.task, name, result, context.toolCallId!, candidatePort);
            record.inspection = inspection.snapshot;
            if (name === 'computation.validate' && result.status === 'success') {
                const receipt=result.artifacts?.computationEvidence as ComputationEvidenceReceipt|undefined;
                if(receipt&&admitComputationEvidence(store,lease,[receipt]).receipt===receipt)computations.push(receipt);
            }
            if (name === 'candidate.stage' && result.status === 'success') {
                const id = (result.artifacts?.candidate as {candidateId?: string} | undefined)?.candidateId;
                candidateAccepted = Boolean(id && candidatePort?.read(id).execution.jobId === receipts.at(-1)?.jobId);
            }
            if (name === 'candidate.abandon' && result.status === 'success') candidateAccepted = false;
            if(name==='candidate.validate'){
                const receipt=result.artifacts?.candidateValidation as import('../../../data/candidateStaging').CandidateValidationReceipt|undefined;
                if(receipt&&candidatePort?.validationReceipt(receipt.candidateId)===receipt&&receipt.runId===lease.runId&&receipt.toolCallId===context.toolCallId&&receipt.toolCallId===activeValidationCall){
                    lastValidationCandidateId=receipt.candidateId;
                    if(result.status==='success'&&receipt.decision==='validated')validatedCandidateId=receipt.candidateId;
                }
            }
            const candidate = result.artifacts?.codeExecution as Readonly<CodeExecutionReceipt> | undefined;
            if (name === 'code.run' && candidate && !Array.isArray(candidate)) {
                let actual: Readonly<CodeExecutionReceipt> | undefined;
                try { actual = adapter?.inspect(candidate.jobId, context) as Readonly<CodeExecutionReceipt> | undefined; }
                catch { blockedReason = 'unverified_execution_receipt'; return; }
                if (!actual || actual !== candidate || actual.runId !== lease.runId || actual.toolCallId !== context.toolCallId) {
                    blockedReason = 'unverified_execution_receipt'; return;
                }
                receipts.push(actual);
                captureExport(actual);
                // Persist references only; guest output text/logs can contain source rows and remain transient.
                store.setState(prev => ({ workspaceFiles: { ...(prev.workspaceFiles ?? {}),
                    [`/workspace/task-artifacts/${record.workspace.namespaceId}.json`]: JSON.stringify({taskId: record.task.taskId,
                        namespaceId: record.workspace.namespaceId, artifacts: record.workspace.list().map(({content: _content, ...reference}) => reference),
                        execution: {jobId: actual.jobId, taskRevision: actual.taskRevision, runId: actual.runId, toolCallId: actual.toolCallId,
                            status: actual.status, reasonCode: actual.reasonCode, program: actual.program, output: actual.output},
                        note: 'Execution references only. Outputs remain transient; independent validation and exact commit approval are required.'}, null, 2),
                } }));
                if (record.task.status === 'executing') move('validating');
                if (actual.status === 'succeeded') { executionAccepted = true; record.failureKey = ''; record.repetitions = 0; move('verifying'); return; }
                const failure = JSON.stringify([actual.program?.sha256, actual.inputDigest, actual.reasonCode, actual.error]);
                record.repetitions = record.failureKey === failure ? record.repetitions + 1 : 1; record.failureKey = failure;
                if (record.repetitions >= 2) blockedReason = 'coding_no_progress';
                if (record.task.status === 'validating') move('programming');
            } else if (name === 'code.run') {
                if (record.task.status === 'executing') move('programming');
            }
            charge({});
        },
        async toolFailure(name, args, error, toolCallId) {
            current();
            inspection.observe(record.task, name, {status:'error',toolName:'assistant_message',message:error,shouldStop:false}, toolCallId ?? crypto.randomUUID());
            record.inspection = inspection.snapshot;
            activateCoding(name.replace('_', '.'));
            if (name === 'code_run') executionAccepted = false;
            if (name === 'candidate_stage') { candidateRequested = true; candidateAccepted = false; }
            if(name==='candidate_validate'){validationRequested=true;validatedCandidateId='';lastValidationCandidateId='';activeValidationCall=toolCallId??crypto.randomUUID();}
            if (toolCallId && !chargedCalls.has(toolCallId)) {
                chargedCalls.add(toolCallId);
                charge(name === 'read_skill' ? {skillReads: 1} : {toolCalls: 1, ...(name === 'code_run' ? {transformationAttempts: 1} : {})});
            }
            const failure = await awaitOwned(digest([name, args, error]), store, lease);
            record.repetitions = record.failureKey === failure ? record.repetitions + 1 : 1; record.failureKey = failure;
            if (record.repetitions >= 2) blockedReason = 'tool_no_progress';
            charge({});
        },
        validationState(){
            current();let receipt:Readonly<import('../../../data/candidateStaging').CandidateValidationReceipt>|undefined;
            try{if(lastValidationCandidateId)receipt=candidatePort?.validationReceipt(lastValidationCandidateId);}catch{receipt=undefined;}
            return {requested:validationRequested,receipt};
        },
        assertComputationReady() {
            current();
            if(record.task.scope.answer.dataPreparation==='canonical_fact_table'&&!task.plan.repairCommit)
                throw new Error('task_repair_commit_required: Complete independent candidate validation and exact human approval for this task before computing on its fresh committed binding.');
        },
        outputReceipt() {
            current();
            const receipt = receipts.at(-1);
            if (!executionAccepted || !receipt || receipt.status !== 'succeeded' || !receipt.output || !receipt.program || blockedReason) return undefined;
            if (candidateRequested && (!candidateAccepted || !candidatePort?.list().some(c => c.execution.jobId === receipt.jobId))) return undefined;
            if(validationRequested&&(!validatedCandidateId||candidatePort?.validationReceipt(validatedCandidateId)?.decision!=='validated'
                ||candidatePort.read(validatedCandidateId).execution.jobId!==receipt.jobId))return undefined;
            const refs = [receipt.program, ...(receipt.inputs ?? []), receipt.output];
            if (refs.some(ref => { const artifact = record.workspace.read(ref.path); return artifact.revision !== ref.revision || artifact.sha256 !== ref.sha256; })) return undefined;
            const state = store.getState();
            if (receipt.sources?.some(source => source.sourceId !== state.datasetBundle?.source.inspection?.sourceId
                || source.sha256 !== state.datasetBundle?.source.inspection?.sha256)) return undefined;
            if (receipt.inputBindings.some(binding => !state.datasetBundle?.tables.some(table => table.tableId === binding.tableId
                && table.datasetVersion === binding.datasetVersion) || state.datasetBundle?.relationshipSetId !== binding.relationshipSetId)) return undefined;
            return receipt;
        },
        suspend(pending) {
            deferApprovalPublication=Boolean(pending.resumeContext?.piCandidateApproval);
            charge({});
            if (record.task.status === 'executing') move('validating');
            if (pending.interactionKind === 'approval') {
                if (record.task.status === 'inspecting') move('executing');
                if (record.task.status === 'programming') move('executing');
                if (record.task.status === 'executing') move('validating');
                if (record.task.status === 'verifying') move('programming');
                if (record.task.status === 'programming') { move('executing'); move('validating'); }
                move('awaiting_approval');
            } else {
                if (record.task.status === 'validating') move('programming');
                move('awaiting_clarification');
            }
            const ref = { taskId: record.task.taskId, revision: record.task.revision, scopeDigest: record.task.scope.digest };
            return { ...pending, resumeContext: { ...pending.resumeContext, piTaskContinuation: ref } };
        },
        close(status) {
            if (closed) return record.task.status;
            if(status==='completed'&&record.task.scope.answer.dataPreparation==='canonical_fact_table'&&!task.plan.repairCommit) {
                blockedReason='task_repair_commit_required';status='blocked';
            }
            if (ownsRun(store, lease) && tasks.get(key) === record) {
                if (!['awaiting_clarification', 'awaiting_approval'].includes(record.task.status) || lease.signal.aborted) {
                    if (!lease.signal.aborted) { try { charge({}); } catch { if (status === 'completed') status = 'blocked'; } }
                    record.task = { ...record.task, status, capabilityGrants: [], budget:resumeTaskBudget(record.task.budget) };
                    root.setState({ activeAgentTask: record.task });
                }
            }
            clearTimeout(deadline); unregisterDeadline();
            if (record.task.status === 'awaiting_approval' && canCommitRun(store, lease) && tasks.get(key) === record) {
                candidatePort?.suspend(); adapter?.suspend();
            } else {
                candidatePort?.dispose(); adapter?.dispose();
                if(ownsRun(store,lease)&&tasks.get(key)===record){record.retire?.();record.retire=undefined;}
            }
            closed = true;
            return record.task.status;
        },
    };
    const deadline = setTimeout(() => {
        if (!canCommitRun(store, lease) || closed) return;
        blockedReason = 'task_budget_exhausted:activeMs';
        record.task = { ...record.task, budget: { ...record.task.budget,
            used: { ...record.task.budget.used, activeMs: record.task.budget.limits.activeMs } } };
        lease.controller.abort(new Error(blockedReason));
    }, Math.max(1, record.task.budget.limits.activeMs - record.task.budget.used.activeMs));
    const unregisterDeadline = registerSessionResource(lease.scope, () => clearTimeout(deadline));
    store.piTask = task;
    task.attach(store); publish();
    return task;
};

export interface PiCodingTask {
    readonly plan: TypedTaskPlan;
    assertComputationReady(): void;
    readonly skills:SkillSnapshot;
    loadSkillProgram(pin:PinnedSkill,file:import('../../skills/skillManifest').SkillSupportFile):Promise<import('../../execution/codeExecutionContract').CodeArtifactRef>;
    readonly snapshot: AgentTaskContract;
    readonly coding: boolean;
    readonly blockedReason: string;
    recoverySnapshot(): { task:AgentTaskContract;failureKey:string;repetitions:number };
    attach(store: StoreApi): void;
    committed(): void;
    requireOutputs(outputs: TaskOutputRequirement[]): void;
    rejectApproval(): void;
    refreshInputs(): void;
    resolveScope(scope: ResolvedAnswerScope): Promise<void>;
    providerTurn(ordinaryLimit?: number): void;
    skillRead(toolCallId?: string): void;
    beforeTool(name: string, args: unknown, toolCallId?: string): Promise<void>;
    afterTool(name: string, result: ToolExecutionResult, context: NonNullable<StoreApi['executionContext']>): void;
    toolFailure(name: string, args: unknown, error: string, toolCallId?: string): Promise<void>;
    outputReceipt(): Readonly<CodeExecutionReceipt> | undefined;
    validationState(): {requested:boolean;receipt?:Readonly<import('../../../data/candidateStaging').CandidateValidationReceipt>};
    suspend(request: ClarificationRequest): ClarificationRequest;
    close(status: 'completed' | 'blocked' | 'failed' | 'cancelled'): AgentTaskContract['status'];
}
