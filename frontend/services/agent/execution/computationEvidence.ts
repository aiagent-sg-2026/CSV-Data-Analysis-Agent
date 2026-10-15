import type { QueryPlan } from '../../../types';
import type { StoreApi } from '../types';
import { assertRunActive, canCommitRun, type RunLease } from '../../session/sessionOwnership';
import { captureCodeTables, CODE_TABLE_LIMITS, codeDigest } from './codeTableInputs';
import { executeDataQuery } from './dataQueryExecutor';
import type { CodeExecutionReceipt } from './codeExecutionContract';
import { JAVASCRIPT_GUEST_PIN } from '../../sandbox/javascriptGuestProtocol';
import { orderedPredicateValue } from './queryPredicateValue';
import { referenceWeightedMedian,type WeightedMedianScope,type WeightedMedianResult } from './weightedMedian';
import { referenceWeightedMean,type WeightedMeanScope,type WeightedMeanResult } from './weightedMean';

export interface PearsonScope {
    method: 'pearson_correlation'; x: string; y: string; where?: QueryPlan['where'];
    missingPolicy: 'pairwise_complete'; seed: 'none'; tableId?: string;
}
export type RequestedComputationScope = PearsonScope | WeightedMedianScope | WeightedMeanScope;
export type ComputationResult = PearsonResult | WeightedMedianResult | WeightedMeanResult;
export interface PearsonResult { method: 'pearson_correlation'; methodVersion: 1; seed: 'none'; scopedRows: number; n: number; excluded: number; coefficient: number | null }
export const COMPUTATION_OUTPUT_CONTRACTS=Object.freeze({
    weighted_mean:Object.freeze({method:'literal weighted_mean',methodVersion:'literal 1',seed:'literal none',
        scopedRows:'Integer count after the exact business/time filter, before missing/zero-weight handling.',
        n:'Integer count of nonmissing positive-frequency pairs within scopedRows.',
        excluded:'Integer count of missing value/weight pairs WITHIN scopedRows. Out-of-scope rows do not count.',
        zeroWeightRows:'Integer count of nonmissing zero-frequency pairs within scopedRows.',
        numerator:'Canonical signed decimal INTEGER STRING: unreduced sum(value * weight), accumulated with BigInt. Source values must be typed safe integers. Zero is string 0.',
        denominator:'Canonical nonnegative decimal INTEGER STRING: unreduced sum of positive frequency weights, accumulated with BigInt. Never reduce this fraction.',
        mean:'Number(numerator) / Number(denominator), or null when denominator is string 0. Display derivative only.',
        unit:'Single contributing unit string, or null without a unit column.'} satisfies Record<keyof WeightedMeanResult,string>),
    lower_weighted_median:Object.freeze({method:'literal lower_weighted_median',methodVersion:'literal 1',seed:'literal none',
        scopedRows:'Integer count after the exact business/time filter, before missing/zero-weight handling. Never a row array.',
        n:'Integer count of nonmissing positive-frequency pairs within scopedRows.',
        excluded:'Integer count of missing value/weight pairs WITHIN scopedRows. Out-of-scope rows do not count.',
        zeroWeightRows:'Integer count of nonmissing zero-frequency pairs within scopedRows.',totalWeight:'Safe integer sum of positive frequency weights.',
        median:'Observed lower weighted median number, or null without positive weights.',unit:'Single contributing unit string, or null without a unit column.'} satisfies Record<keyof WeightedMedianResult,string>),
    pearson_correlation:Object.freeze({method:'literal pearson_correlation',methodVersion:'literal 1',seed:'literal none',
        scopedRows:'Integer count after the exact business/time filter. Never a row array.',n:'Integer count of complete numeric pairs within scopedRows.',
        excluded:'Integer count of missing pairs WITHIN scopedRows, excluding out-of-scope rows.',coefficient:'Finite number, or null for insufficient/constant pairs.'} satisfies Record<keyof PearsonResult,string>),
});

/** Diagnostic field names only: never disclose reference values as a replacement for agent computation. */
export const computationMismatchFields=(actual:Record<string,unknown>|null,expected:ComputationResult,tolerance:number):string[]=>{
    if(!actual||Array.isArray(actual)||typeof actual!=='object')return ['output_object_required'];
    const expectedKeys=Object.keys(expected),extra=Object.keys(actual).filter(key=>!expectedKeys.includes(key));
    return [...(extra.length?['unexpected_fields']:[]),...Object.entries(expected).filter(([key,value])=>{
        if(key==='coefficient')return value===null?actual[key]!==null:typeof actual[key]!=='number'||!Number.isFinite(actual[key])||Math.abs(actual[key]-value)>tolerance;
        return actual[key]!==value;
    }).map(([key])=>key)];
};
export interface ComputationEvidenceReceipt {
    evidenceId: string; taskId: string; taskRevision: number; answerScopeDigest: string;
    sessionId: string; sessionEpoch: number; runId: string; turnId?: string; toolCallId: string;
    method: RequestedComputationScope; methodVersion: 1; seed: 'none';
    execution: Readonly<CodeExecutionReceipt>; inputSha256: string; result: ComputationResult;
    reference: 'host-centered-pearson-v1' | 'host-lower-frequency-median-v1' | 'host-integer-frequency-mean-v1'; tolerance: number;
}
const issued = new WeakMap<ComputationEvidenceReceipt, () => void>();
const freeze = <T>(value: T): T => { if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); } return value; };
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/** Independent two-pass, scaled centered formula. Guest source/output are never an oracle.
 * Reference: https://www.itl.nist.gov/div898/software/dataplot/refman2/auxillar/correlat.htm */
export const referencePearson = (rows: Record<string, unknown>[], scope: PearsonScope): PearsonResult => {
    const missing = (v: unknown) => v === null || v === undefined || v === '';
    const pairs: number[][] = [];
    for (const row of rows) {
        const x = row[scope.x], y = row[scope.y];
        if (missing(x) || missing(y)) continue;
        if (typeof x !== 'number' || typeof y !== 'number' || !Number.isFinite(x) || !Number.isFinite(y)) throw new Error('typed_numeric_input_required');
        pairs.push([x, y]);
    }
    let coefficient: number | null = null;
    if (pairs.length >= 2) {
        const sx = pairs.reduce((v,p)=>Math.max(v,Math.abs(p[0])),0) || 1, sy = pairs.reduce((v,p)=>Math.max(v,Math.abs(p[1])),0) || 1;
        const mx = pairs.reduce((s, p) => s + p[0] / sx, 0) / pairs.length, my = pairs.reduce((s, p) => s + p[1] / sy, 0) / pairs.length;
        let xx = 0, yy = 0, xy = 0;
        for (const p of pairs) { const x = p[0] / sx - mx, y = p[1] / sy - my; xx += x*x; yy += y*y; xy += x*y; }
        if (xx > 0 && yy > 0) coefficient = Math.max(-1, Math.min(1, xy / Math.sqrt(xx) / Math.sqrt(yy)));
    }
    return {method:'pearson_correlation', methodVersion:1, seed:'none', scopedRows:rows.length, n:pairs.length, excluded:rows.length-pairs.length, coefficient};
};

const currentExecution = (store: StoreApi, receipt: ComputationEvidenceReceipt) => {
    const context = store.executionContext, task = store.piTask?.snapshot, code = store.codeExecution;
    if (!context || !task || !code) throw new Error('execution_authority_unavailable');
    assertRunActive(store, context.lease);
    if (receipt.taskId !== task.taskId || receipt.taskRevision !== task.revision || receipt.answerScopeDigest !== task.scope.digest
        || receipt.runId !== context.lease.runId || receipt.turnId !== context.lease.turnId
        || receipt.sessionId !== context.lease.scope.sessionId || receipt.sessionEpoch !== context.lease.scope.epoch
        || !same(receipt.method, task.scope.answer.computation)
        || code.inspect(receipt.execution.jobId, {...context, toolCallId:receipt.toolCallId}) !== receipt.execution) throw new Error('execution_task_scope_mismatch');
    for (const ref of [receipt.execution.program!, ...(receipt.execution.inputs ?? []), receipt.execution.output!]) {
        const actual = code.workspace.read(ref.path);
        if (actual.revision !== ref.revision || actual.sha256 !== ref.sha256) throw new Error('artifact_revision_changed');
    }
    const bundle = store.getState().datasetBundle;
    if (receipt.execution.inputBindings.some(b => !bundle?.tables.some(t => t.tableId === b.tableId && t.datasetVersion === b.datasetVersion)
        || bundle.relationshipSetId !== b.relationshipSetId)) throw new Error('input_version_changed');
};

export const validateComputationExecution = async (store: StoreApi, jobId: string): Promise<ComputationEvidenceReceipt> => {
    const context = store.executionContext, task = store.piTask?.snapshot, code = store.codeExecution, scope = task?.scope.answer.computation;
    if (!context?.toolCallId || !task || !code || !scope || task.scope.answer.unresolved.length) throw new Error('resolved_computation_scope_required');
    assertRunActive(store, context.lease);
    store.piTask?.assertComputationReady();
    const execution = code.inspect(jobId, context) as Readonly<CodeExecutionReceipt>;
    if (execution.status !== 'succeeded' || !execution.program || !execution.output || execution.outputContract?.format !== 'json'
        || !['whole_table','stateful_stream'].includes(execution.mode ?? '') || !execution.coverage?.length
        || execution.environment?.runtime !== JAVASCRIPT_GUEST_PIN || !execution.environmentDigest || !execution.inputDigest
        || !execution.requestDigest || execution.taskId !== task.taskId || execution.taskRevision !== task.revision
        || execution.runId !== context.lease.runId || execution.turnId !== context.lease.turnId
        || execution.sessionId !== context.lease.scope.sessionId || execution.sessionEpoch !== context.lease.scope.epoch) throw new Error('successful_complete_execution_required');
    const receipt: ComputationEvidenceReceipt = {evidenceId:`computation-${crypto.randomUUID()}`, taskId:task.taskId,
        taskRevision:task.revision, answerScopeDigest:task.scope.digest, sessionId:context.lease.scope.sessionId, sessionEpoch:context.lease.scope.epoch,
        runId:context.lease.runId, turnId:context.lease.turnId, toolCallId:context.toolCallId, method:structuredClone(scope), methodVersion:1, seed:'none',
        execution, inputSha256:'', result:null as unknown as PearsonResult,
        reference:scope.method==='pearson_correlation'?'host-centered-pearson-v1':scope.method==='weighted_mean'?'host-integer-frequency-mean-v1':'host-lower-frequency-median-v1',
        tolerance:scope.method==='pearson_correlation'?1e-10:0};
    const check = () => currentExecution(store, receipt);
    check();
    if (await codeDigest(execution.environment) !== execution.environmentDigest) throw new Error('environment_digest_mismatch');
    const coverage = execution.coverage.find(c => c.tableId === scope.tableId);
    if (!coverage || !coverage.complete || coverage.deliveredRows !== coverage.rowCount) throw new Error('complete_input_required');
    const captured = await captureCodeTables(store, [{name:'facts', tableId:coverage.tableId}], execution.inputBindings, 8*1024*1024, check);
    check(); captured.check();
    if (captured.coverage[0].sha256 !== coverage.sha256) throw new Error('input_digest_mismatch');
    const predicates=[...(scope.where?.predicates??[]),...(scope.where?.groups??[]).flatMap(g=>g.predicates)];
    const dateColumns=store.getState().columnProfiles.filter(p=>p.type==='date'||p.type==='time').map(p=>p.name);
    for(const column of dateColumns.filter(c=>predicates.some(p=>p.column===c))){
        if(captured.tables.facts.rows.some(row=>row[column]!==null&&row[column]!==undefined&&row[column]!==''
            &&(typeof row[column]!=='string'||!/^\d{4}-\d{2}-\d{2}(?:$|T)/.test(String(row[column]))||orderedPredicateValue(row[column])===null)))
            throw new Error('unresolved_date_convention');
    }
    const columns=scope.method==='pearson_correlation'?[scope.x,scope.y]:[scope.value,scope.weight,...(scope.unitColumn?[scope.unitColumn]:[])];
    const result = executeDataQuery(captured.tables.facts.rows, {select:columns, where:scope.where, limit:CODE_TABLE_LIMITS.rows},
        {maxRows:CODE_TABLE_LIMITS.rows, allowedColumns:captured.tables.facts.columns});
    if (result.truncated || result.returnedRows !== result.totalMatchedRows) throw new Error('complete_scope_required');
    receipt.inputSha256 = coverage.sha256;
    receipt.result = scope.method==='pearson_correlation'?referencePearson(result.rows, scope)
        :scope.method==='weighted_mean'?referenceWeightedMean(result.rows,scope):referenceWeightedMedian(result.rows,scope);
    const parsed = JSON.parse(code.workspace.read(execution.output.path).content);
    const actual = (execution.mode==='stateful_stream' && Array.isArray(parsed) && parsed.length===1 ? parsed[0] : parsed) as Record<string,unknown>;
    const expected = receipt.result;
    const mismatches=computationMismatchFields(actual,expected,receipt.tolerance);
    if(mismatches.length)throw new Error(`independent_reference_mismatch: Revise output fields [${mismatches.join(', ')}] to match the declared computation output contract. scopedRows is a count after the exact scope filter; excluded counts missing pairs within that scope. No reference values are supplied. Write a new program revision, execute again, then validate its new jobId.`);
    check(); captured.check(); freeze(receipt); issued.set(receipt, captured.check); return receipt;
};

export const admitComputationEvidence = (store: StoreApi, lease: RunLease, receipts: ComputationEvidenceReceipt[]) => {
    if (!canCommitRun(store, lease)) return {reason:'scope_revoked'};
    for (const receipt of [...receipts].reverse()) {
        if (!issued.has(receipt)) continue;
        try { currentExecution(store, receipt); issued.get(receipt)!(); return {receipt}; } catch { /* Earlier compatible executions may remain eligible. */ }
    }
    return {reason:'No independently validated current-task/current-version computation matches the requested method and scope.'};
};

export const formatComputationEvidence = (receipt: ComputationEvidenceReceipt): string => {
    const r = receipt.result;
    if(r.method==='weighted_mean'){
        const value=r.mean===null?r.scopedRows===0?'No rows match the requested scope.':'Weighted mean is undefined (no positive frequency weight).'
            :`Weighted mean (${receipt.method.method==='weighted_mean'?receipt.method.value:''}): ${r.mean} (approximate display).`;
        return `${value}\nExact numerator: ${r.numerator}; denominator: ${r.denominator} (unreduced).${r.unit?`\nUnit label: ${r.unit}; source column scale preserved.`:''}\nContributing pairs: ${r.n}; excluded missing pairs: ${r.excluded}; zero-weight rows: ${r.zeroWeightRows}; scoped rows: ${r.scopedRows}.\nEvidence: ${receipt.evidenceId}; execution ${receipt.execution.jobId}; method v1; seed none; ${receipt.execution.environmentDigest}.`;
    }
    if(r.method==='lower_weighted_median'){
        const value=r.median===null?r.scopedRows===0?'No rows match the requested scope.':'Weighted median is undefined (no positive frequency weight).'
            :`Lower weighted median (${receipt.method.method==='lower_weighted_median'?receipt.method.value:''}): ${r.median}.${r.unit?`\nUnit label: ${r.unit}; source column scale preserved.`:''}`;
        return `${value}\nTotal frequency weight: ${r.totalWeight}; contributing pairs: ${r.n}; excluded missing pairs: ${r.excluded}; zero-weight rows: ${r.zeroWeightRows}; scoped rows: ${r.scopedRows}.\nEvidence: ${receipt.evidenceId}; execution ${receipt.execution.jobId}; method v1; seed none; ${receipt.execution.environmentDigest}.`;
    }
    const value = r.coefficient === null ? r.scopedRows === 0 ? 'No rows match the requested scope.' : 'Correlation is undefined (fewer than two complete pairs or zero variance).'
        : `Pearson correlation (${receipt.method.method==='pearson_correlation'?receipt.method.x:''}, ${receipt.method.method==='pearson_correlation'?receipt.method.y:''}): ${r.coefficient.toFixed(6)}.`;
    return `${value}\nComplete pairs: ${r.n}; excluded missing pairs: ${r.excluded}; scoped rows: ${r.scopedRows}.\nEvidence: ${receipt.evidenceId}; execution ${receipt.execution.jobId}; method v1; seed none; ${receipt.execution.environmentDigest}.`;
};
