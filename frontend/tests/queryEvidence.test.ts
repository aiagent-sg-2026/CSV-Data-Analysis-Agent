import { describe, expect, it } from 'vitest';
import type { StoreApi } from '../services/agent/types';
import type { ActiveDataQuery, QueryPlan } from '../types';
import { beginRun, scopeRunStore, beginSessionTransition, canCommitRun } from '../services/session/sessionOwnership';
import { captureQueryIdentity, createQueryReceipt, resolveAnswerScope, admitQueryEvidence, formatValidatedQueryReply, formatValidatedCalculation } from '../services/agent/runtime/pi/queryEvidence';

const october: QueryPlan = { groupBy: ['Town'], aggregates: [{ function: 'sum', column: 'Amount', as: 'Total' }],
    where: { predicates: [{ column: 'Date', operator: 'gte', value: '2026-10-01' }, { column: 'Date', operator: 'lt', value: '2026-11-01' }] } };
const setup = () => {
    let state = { sessionId: 's1', currentDatasetId: 'd1', datasetBundle: null,
        csvData: { fileName: 'sample.csv', data: [{ Town: 'A', Amount: 10, Date: '2026-10-03' }] }, canonicalCsvData: null,
        columnProfiles: [{ name: 'Town', type: 'string' }, { name: 'Amount', type: 'number' }, { name: 'Date', type: 'date' }], columnRegistry: null,
    } as unknown as ReturnType<StoreApi['getState']>;
    const store: StoreApi = { getState: () => state, setState: patch => { state = { ...state, ...(typeof patch === 'function' ? patch(state) : patch) }; } };
    const lease = beginRun(store, 'follow_up', 'r1', 't1');
    const tool = scopeRunStore(store, lease);
    tool.executionContext = { lease, toolCallId: 'tool1' };
    const artifact = { taskSignal: 'inspect_data', expectedOutput: 'data_table', filterDescription: 'October 2026',
        timeScope: { kind: 'explicit', value: 'October 2026' }, requestedQueryScopes: [{ role: 'result', plan: october }],
        referencedColumns: ['Amount'], groupingColumns: ['Town'], aggregationFunctions: ['SUM'], unresolvedReferences: [],
    } as Parameters<typeof resolveAnswerScope>[1];
    const scope = resolveAnswerScope('List all totals by Town for October 2026 only.', artifact, undefined, store);
    const query = (plan = october): ActiveDataQuery => ({ ...captureQueryIdentity(tool).fields, queryMode: 'structured',
        explanation: 'October totals', plan: { ...plan, select: ['Town', 'Total'] }, appliedAt: new Date(), source: 'execute_data_query',
        engine: 'native', tableName: null, sqlPreview: null, loadVersion: null,
        result: { rows: [{ Town: 'A', Total: 10 }], selectedColumns: ['Town', 'Total'], returnedRows: 1, totalMatchedRows: 1,
            truncated: false, appliedLimit: 500, appliedOrderBy: [], durationMs: 1 } });
    return { store, tool, lease, scope, artifact, query };
};

describe('current-turn query grounding', () => {
    it('preserves typed preparation separately from query filters and refuses unknown preparation',()=>{
        const {store,artifact}=setup();
        const scope=resolveAnswerScope('Repair the canonical fact table and report October totals.',{...artifact!,requestedDataPreparation:'canonical_fact_table'},undefined,store);
        expect(scope).toMatchObject({dataPreparation:'canonical_fact_table',unresolved:[]});
        expect(scope.queries[0].plan.where).toEqual(october.where);
        const unknown=resolveAnswerScope('Report totals.',{...artifact!,requestedDataPreparation:'auto_approve' as never},undefined,store);
        expect(unknown.unresolved).toContain('Unsupported typed data preparation request.');
        expect(unknown.dataPreparation).toBeUndefined();
    });
    it.each(['current', 'stale', 'unbound', 'string'] as const)('uses only the current validated date schema with coarse profiles: %s', mode => {
        const { store, artifact } = setup();
        const version = captureQueryIdentity(store).fields.datasetVersion;
        store.setState(state => ({ columnProfiles: state.columnProfiles.map(profile => profile.name === 'Date' ? { ...profile, type: 'categorical' } : profile),
            datasetCommitBindingStatus: mode === 'unbound' ? 'awaiting_source' : 'ready',
            datasetBundle: { acceptedCommit: { sessionId: 's1', commitId: 'accepted', revision: 1 }, primaryTableId: 'facts',
                datasetVersion: version, tables: [{ tableId: 'facts', datasetVersion: mode === 'stale' ? 'old' : version,
                    schema: [{ name: 'Date', dataType: mode === 'string' ? 'string' : 'date' }] }] } as never }));
        const scope = resolveAnswerScope('October 2026 only', artifact, undefined, store);
        expect(scope.unresolved).toEqual(mode === 'current' ? [] : ['Specify an unambiguous date column for the requested period.']);
    });
    it('normalizes complete derived limits under the same host execution policy', () => {
        const { store, artifact } = setup();
        const scope = resolveAnswerScope('Profit margin by Town', { ...artifact!, timeScope: {kind:'none'},
            requestedQueryScopes:[{role:'result',plan:{...october,limit:100}}] }, undefined, store);
        expect(scope.queries[0].plan.limit).toBe(500);
    });
    it('refuses a cloned host receipt',()=>{
        const {store,tool,lease,scope,query}=setup();
        expect(admitQueryEvidence(store,lease,scope,[structuredClone(createQueryReceipt(tool,query())!)]).verdict.status).toBe('blocked');
    });
    it.each(['filter','or','group','metric','order','limit','post-filter'] as const)('compares an authentic execution against a wrong requested %s scope',kind=>{
        const {store,tool,lease,scope,query}=setup(),receipt=createQueryReceipt(tool,query())!;
        const plan=structuredClone(scope.queries[0].plan);
        if(kind==='filter')plan.where=undefined;
        if(kind==='or')plan.where={groups:plan.where!.predicates!.map(p=>({predicates:[p]}))};
        if(kind==='group')plan.groupBy=['Date'];
        if(kind==='metric')plan.aggregates![0].function='avg';
        if(kind==='order')plan.orderBy=[{column:'Total',direction:'desc'}];
        if(kind==='limit')plan.limit=100;
        if(kind==='post-filter')plan.postAggregateFilter={predicates:[{column:'Total',operator:'gt',value:5}]};
        expect(admitQueryEvidence(store,lease,{...scope,queries:[{role:'result',plan}]},[receipt]).verdict.status).toBe('blocked');
    });
    it('accepts a fresh October query and renders executed values', () => {
        const { store, tool, lease, scope, query } = setup();
        const receipt = createQueryReceipt(tool, query())!;
        const admitted = admitQueryEvidence(store, lease, scope, [receipt]);
        expect(admitted.verdict.status).toBe('accepted');
        expect(admitted.verdict.queryIds).toEqual([receipt.queryId]);
        expect(formatValidatedQueryReply(admitted.evidence[0], 'English')).toContain('| A | 10 |');
    });
    it('keeps a run alive after authorized cleaning but invalidates its previous-version receipt', () => {
        const { store, tool, lease, scope, query } = setup();
        const previous = createQueryReceipt(tool, query())!;
        store.setState({ csvData: { fileName: 'sample.csv', data: [{ Town: 'A', Amount: 20, Date: '2026-10-03' }] } });
        expect(canCommitRun(store, lease)).toBe(true);
        expect(admitQueryEvidence(store, lease, scope, [previous]).verdict.status).toBe('blocked');
        const current = query();
        current.result.rows = [{ Town: 'A', Total: 20 }];
        const accepted = admitQueryEvidence(store, lease, scope, [previous, createQueryReceipt(tool, current)!]);
        expect(accepted.verdict.status).toBe('accepted');
        expect(formatValidatedQueryReply(accepted.evidence[0], 'English')).toContain('| A | 20 |');
    });
    it.each(['filter', 'group', 'metric', 'version', 'session', 'turn', 'unverifiable', 'truncated', 'order', 'limit', 'row_count'])('rejects a mismatched %s receipt', kind => {
        const { store, tool, lease, scope, query } = setup();
        const receipt = createQueryReceipt(tool, query())!;
        if (kind === 'filter') receipt.query.plan.where = undefined;
        if (kind === 'group') receipt.query.plan.groupBy = ['Date'];
        if (kind === 'metric') receipt.query.plan.aggregates![0].function = 'avg';
        if (kind === 'version') receipt.query.datasetVersion = 'old-version';
        if (kind === 'session') receipt.query.sessionId = 'other-session';
        if (kind === 'turn') receipt.turnId = 'previous-turn';
        if (kind === 'unverifiable') receipt.semanticValidation = 'unverifiable';
        if (kind === 'truncated') receipt.query.result.truncated = true;
        if (kind === 'order') receipt.query.result.appliedOrderBy = [{ column: 'Total', direction: 'desc' }];
        if (kind === 'limit') { receipt.query.plan.limit = 500; receipt.query.result.appliedLimit = 1; }
        if (kind === 'row_count') receipt.query.result.returnedRows = 2;
        expect(admitQueryEvidence(store, lease, scope, [receipt]).verdict.status).toBe('blocked');
    });
    it('rejects a receipt after a session transition even with the same session id', () => {
        const { store, tool, lease, scope, query } = setup();
        const receipt = createQueryReceipt(tool, query())!;
        beginSessionTransition(store);
        expect(admitQueryEvidence(store, lease, scope, [receipt]).verdict.status).toBe('blocked');
    });
    it('selects the latest matching receipt without letting a later wrong-scope query replace it', () => {
        const { store, tool, lease, scope, query } = setup();
        const first = createQueryReceipt(tool, query())!;
        const second = createQueryReceipt(tool, query())!;
        const wrong = createQueryReceipt(tool, query({ ...october, where: undefined }))!;
        expect(admitQueryEvidence(store, lease, scope, [first, second, wrong]).verdict.queryIds).toEqual([second.queryId]);
    });
    it('treats zero matching rows as valid evidence', () => {
        const { store, tool, lease, scope, query } = setup();
        const value = query();
        value.result = { ...value.result, rows: [], returnedRows: 0, totalMatchedRows: 0 };
        const admitted = admitQueryEvidence(store, lease, scope, [createQueryReceipt(tool, value)!]);
        expect(admitted.verdict.status).toBe('accepted');
        expect(formatValidatedQueryReply(admitted.evidence[0], 'English')).toContain('matched no rows');
    });
    it('does not give a legacy saved query a new execution receipt', () => {
        const { tool, query } = setup();
        const old = query();
        delete old.queryId;
        delete old.toolCallId;
        expect(createQueryReceipt(tool, old)).toBeNull();
    });
    it('keeps OR groups separate from AND predicates', () => {
        const { store, tool, lease, scope, query } = setup();
        const receipt = createQueryReceipt(tool, query())!;
        receipt.query.plan.where = { groups: october.where!.predicates!.map(predicate => ({ predicates: [predicate] })) };
        expect(admitQueryEvidence(store, lease, scope, [receipt]).verdict.status).toBe('blocked');
    });
    it('requires clarification for a missing year or untyped filters', () => {
        const { store, artifact } = setup();
        store.setState({ csvData: { fileName: 'two-years.csv', data: [{ Town: 'A', Amount: 1, Date: '2025-10-01' }, { Town: 'A', Amount: 2, Date: '2026-10-01' }] } });
        expect(resolveAnswerScope('October only', { ...artifact!, timeScope: { kind: 'explicit', value: 'October' } }, undefined, store).unresolved)
            .toContain('Specify the year and date column for the requested period.');
        expect(resolveAnswerScope('October only', { ...artifact!, requestedQueryScopes: [] }, undefined, store).unresolved.length).toBeGreaterThan(0);
    });
    it('keeps conversation outside the query requirement', () => {
        const { store } = setup();
        expect(resolveAnswerScope('Hello', undefined, undefined, store).requiresEvidence).toBe(false);
    });
    it('clarifies a statistical data request without a resolved method scope',()=>{
        const {store}=setup();
        const scope=resolveAnswerScope('Calculate Pearson correlation of the two columns.',undefined,undefined,store);
        expect(scope.requiresEvidence).toBe(true);expect(scope.unresolved.length).toBeGreaterThan(0);
        expect(resolveAnswerScope('Explain the correlation method.',undefined,undefined,store).requiresEvidence).toBe(false);
    });
    it('fences an old query before it can be stamped with the replacement binding', () => {
        const { store, tool } = setup();
        const identity = captureQueryIdentity(tool);
        store.setState({ csvData: { fileName: 'changed.csv', data: [{ Amount: 99 }] } });
        expect(() => identity.assertCurrent()).toThrow('current dataset');
        expect(identity.fields.datasetId).toBe('d1');
    });
    it('requires the complete October interval rather than an arbitrary date in October', () => {
        const { store, artifact } = setup();
        const partial = { ...october, where: { predicates: [october.where!.predicates![0], { column: 'Date', operator: 'lt' as const, value: '2026-10-10' }] } };
        expect(resolveAnswerScope('October 2026', { ...artifact!, requestedQueryScopes: [{ role: 'result', plan: partial }] }, undefined, store).unresolved.join(' ')).toContain('exact requested date interval');
    });
    it('selects explicit roles and computes a ratio from complete inputs', () => {
        const { store, tool, lease, query, scope } = setup();
        const denominator = { ...october, aggregates: [{ function: 'count' as const, as: 'Count' }] };
        scope.queries = [{ role: 'numerator', plan: october }, { role: 'denominator', plan: denominator }];
        scope.calculation = { operation: 'ratio', leftRole: 'numerator', rightRole: 'denominator' };
        const a = query();
        const b = query(denominator);
        b.result.rows = [{ Town: 'A', Count: 2 }];
        b.result.selectedColumns = ['Town', 'Count'];
        b.plan.select = ['Town','Count'];
        const admitted = admitQueryEvidence(store, lease, scope, [createQueryReceipt(tool, b)!, createQueryReceipt(tool, a)!]);
        expect(admitted.verdict.status).toBe('accepted');
        expect(formatValidatedCalculation(scope, admitted.evidence)).toContain('Town: A: 5');
        admitted.evidence[1].result.rows[0].Count = 0;
        expect(formatValidatedCalculation(scope, admitted.evidence)).toBeNull();
    });

});
