// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import type { StoreApi } from '../services/agent/types';
import { parseCsvTextWithDetection } from '../services/data/csvDialectDetector';
import { buildReportIntakeIr } from '../services/data/reportCsvIntake';
import { inspectInitialHeaderAlignment } from '../services/agent/runtime/pi/piHeaderAlignmentGate';
import { runPiInitialAnalysis } from '../services/agent/runtime/pi/piInitialAnalysisRuntimeService';
import { beginSessionTransition } from '../services/session/sessionOwnership';
import { captureCsvSource } from '../services/data/immutableCsvSource';
import { confirmStructureRepairMeaning, resumeStructureRepairDraft } from '../services/agent/structureRepairConfirmation';

const intake = (rows: string[][]) => buildReportIntakeIr('synthetic.csv', rows,
    parseCsvTextWithDetection(rows.map(row => row.join(',')).join('\n')).detection);
const repeated = (malicious = false) => {
    const groups = Array.from({length: 12}, (_, i) => malicious && i === 0 ? '<img src=x onerror=alert(1)>' : `Group ${i}`);
    const measures = Array.from({length: 5}, (_, i) => `Measure ${i}`);
    return intake([['Synthetic'], [...Array.from({length:14}, (_, i) => `D${i}`), ...groups, ...groups, 'T1','T2','T3','T4'],
        ...[Array.from({length:12}, () => measures).flat()],
        ...Array.from({length:3}, (_, row) => Array.from({length:90}, (_, col) => `${row * 90 + col}`))]);
};

describe('qualified initial header diagnostic gate', () => {
    it('keeps normal four-column rows on the ordinary route', async () => {
        expect(await inspectInitialHeaderAlignment(intake([['A','B','C','D'], ['1','2','3','4'], ['5','6','7','8']]), undefined)).toMatchObject({status:'no_candidates', blocked:false});
    });
    it('reports separate associated byte and canonical row hashes without rendering source cells', async () => {
        const sha = 'a'.repeat(64);
        const diagnostic = await inspectInitialHeaderAlignment(repeated(true), sha);
        const message = diagnostic.summary;
        expect(message).toContain(`Associated source byte SHA-256 (not verified against these rows): ${sha}`);
        expect(message).toMatch(/Canonical rawRows fingerprint \(SHA-256 of declared width and parsed rows, not source bytes\): [a-f0-9]{64}/);
        expect(message).toContain('Structural alternatives: 1:');
        expect(message).toContain('; 2:');
        expect(message).toContain('diagnostics alone cannot authorize selection or resume');
        expect(JSON.stringify(diagnostic)).not.toContain('<img');
        expect(diagnostic.associatedSourceSha256).toBe(sha);
        expect(diagnostic.rawRowsFingerprintSha256).toMatch(/^[a-f0-9]{64}$/);
        expect(diagnostic.reasons).toContain('multiple_alignments');
        expect(diagnostic.possibleChoices.map(choice => choice.mainStartColumn)).toEqual([14, 26]);
        expect(diagnostic.possibleChoices[0]).toMatchObject({structuralIndex:0, headerSourceRows:[1,2],
            bodySourceRows:{start:3,endExclusive:6}});
        expect(diagnostic.possibleChoices[0].mappings[14]).toEqual({targetColumn:14,
            headerPath:[{rowIndex:1,columnIndex:14},{rowIndex:2,columnIndex:0}]});
    });
    it('fails closed when evidence is absent or unsupported', async () => {
        expect((await inspectInitialHeaderAlignment(null, undefined)).summary).toContain('blocked awaiting semantic state');
        const invalid = repeated(); invalid.columnCount = 2000;
        expect((await inspectInitialHeaderAlignment(invalid, undefined)).summary).toContain('diagnostics are unavailable');
        const drift = intake([['A','B','C','D'], ['1','2','3','4'], ['5','6','7','8']]);
        drift.diagnostics.headerShapeDrift = true;
        expect((await inspectInitialHeaderAlignment(drift, undefined)).summary).toContain('no reliable alignment');
    });
    it('prepares a bound human review on the real runtime block and permits only local draft resume', async () => {
        const rows = repeated();
        const data = {fileName:'synthetic.csv',data:[{A:1}]};
        let state = {sessionId:crypto.randomUUID(), rawIntakeIr:rows, csvData:data, rawCsvData:data, canonicalCsvData:null,
            settings:{provider:'default',simpleModel:'mock',complexModel:'mock',language:'English'}, analysisCards:[], columnProfiles:[],
            chatHistory:[], dataQualityIssues:[], agentEvents:[], agentToolLogs:[], runtimeEvents:[], progressMessages:[], telemetryEvents:[],
            workspaceFiles:{}, addProgress:vi.fn(), logAgentToolUsage(){}} as unknown as ReturnType<StoreApi['getState']>;
        const store:StoreApi = {getState:()=>state,setState:patch=>{state={...state,...(typeof patch==='function'?patch(state):patch)};}};
        const source = await captureCsvSource(store, new File([rows.rawRows.map(row => row.join(',')).join('\n')], 'synthetic.csv'));
        store.setState({datasetBundle:{source:{inspection:source}} as never});
        const stream = vi.fn();
        try {
            const result = await runPiInitialAnalysis({appSessionId:state.sessionId,datasetId:'synthetic',datasetVersion:'v1',researchGoal:'Analyze',
                provider:{provider:'default',modelId:'mock'}}, store, stream as never, {codingPreparation:{enabled:true,qualified:true}});
            expect(result.status).toBe('blocked');
            const review = store.getState().structureRepairReview!;
            expect(review.status).toBe('awaiting_semantic_confirmation');
            expect(review.sourceSha256).toBe(source.sha256);
            await confirmStructureRepairMeaning(store, review.reviewId, review.choices[1].candidateDigest);
            await resumeStructureRepairDraft(store, review.reviewId);
            expect(store.getState().structureRepairReview?.status).toBe('draft_uncommitted');
            expect(store.getState().csvData).toBe(data);
            expect(store.getState().canonicalCsvData).toBeNull();
            expect(store.getState().datasetBundle?.acceptedCommit).toBeUndefined();
            expect(stream).not.toHaveBeenCalled();
        } finally { beginSessionTransition(store); }
    });
    it('blocks the actual qualified runtime before provider, preparation, or any dataset mutation', async () => {
        const rows = repeated();
        const data = {fileName:'synthetic.csv',data:[{A:1}]};
        const progress = vi.fn();
        let state = {sessionId:`gate-${crypto.randomUUID()}`, rawIntakeIr:rows, csvData:data, rawCsvData:data, canonicalCsvData:data,
            settings:{provider:'default',simpleModel:'mock',complexModel:'mock',language:'English'}, analysisCards:[], columnProfiles:[],
            chatHistory:[], dataQualityIssues:[], agentEvents:[], agentToolLogs:[], runtimeEvents:[], progressMessages:[], telemetryEvents:[],
            workspaceFiles:{}, addProgress:progress, logAgentToolUsage(){}} as unknown as ReturnType<StoreApi['getState']>;
        const store:StoreApi = {getState:()=>state,setState:patch=>{state={...state,...(typeof patch==='function'?patch(state):patch)};}};
        const stream = vi.fn();
        try {
            const result = await runPiInitialAnalysis({appSessionId:state.sessionId,datasetId:'synthetic',datasetVersion:'v1',researchGoal:'Analyze',
                provider:{provider:'default',modelId:'mock'}}, store, stream as never, {codingPreparation:{enabled:true,qualified:true}});
            expect(result.status).toBe('blocked');
            expect(result.error?.message).toContain('blocked awaiting semantic state');
            expect(result.error?.retryable).toBe(false);
            expect(result.trustedCardIds).toEqual([]);
            expect(result.headerAlignmentDiagnostic).toMatchObject({status:'semantic_review_required', blocked:true,
                possibleChoices:[{mainStartColumn:14},{mainStartColumn:26}]});
            expect(progress).toHaveBeenCalledWith(expect.stringContaining('Canonical rawRows fingerprint'), 'warning');
            expect(stream).not.toHaveBeenCalled();
            expect(store.getState().csvData).toBe(data);
            expect(store.getState().pendingClarification).toBeFalsy();
        } finally { beginSessionTransition(store); }
    });
});
