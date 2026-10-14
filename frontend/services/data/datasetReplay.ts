import * as Papa from 'papaparse';
import type { CsvRow, DatasetBundle } from '../../types';
import type { StoreApi } from '../agent/types';
import type { StagedDatasetCandidate } from './candidateContract';
import { captureRecoverySource } from './immutableCsvSource';
import { codeDigest } from '../agent/execution/codeTableInputs';
import { assertRunActive, captureSessionScope, registerSessionResource, type SessionScope } from '../session/sessionOwnership';
import type { DatasetReplayManifest, DatasetRecoveryMaterial } from './datasetRecoveryContract';

const live = new WeakMap<SessionScope, Map<string, DatasetRecoveryMaterial>>();
export const rememberRecoveryMaterial = (store: StoreApi, commitId: string, material: DatasetRecoveryMaterial): void => {
    const scope = captureSessionScope(store), entries = live.get(scope) ?? new Map();
    entries.set(commitId, structuredClone(material)); live.set(scope, entries);
    registerSessionResource(scope, () => { entries.clear(); live.delete(scope); });
};
export const currentRecoveryMaterial = (store: StoreApi, commitId: string): DatasetRecoveryMaterial | undefined => {
    const value = live.get(captureSessionScope(store))?.get(commitId);
    return value ? structuredClone(value) : undefined;
};
export const parseReplayRoot = (text: string, source: NonNullable<DatasetReplayManifest['source']>, dynamicTyping: boolean): CsvRow[] => {
    const parsed = Papa.parse<CsvRow>(text, { header: true, skipEmptyLines: true, dynamicTyping,
        delimiter: source.dialect.delimiter, quoteChar: source.dialect.quoteChar });
    const renamed = (parsed.meta as Papa.ParseMeta & { renamedHeaders?: Record<string, string> }).renamedHeaders;
    if (parsed.errors.length || renamed && Object.keys(renamed).length
        || parsed.data.some(row => Object.values(row).some(v => v !== null && !['string', 'number', 'boolean'].includes(typeof v)))) {
        throw new Error('recovery_source_structure_unavailable');
    }
    return parsed.data;
};

/** Capture only from the successfully validated host port. Model parameters supply no lineage. */
export const captureDatasetReplay = async (store: StoreApi, candidate: StagedDatasetCandidate, inputBundle: DatasetBundle) => {
    const lease = store.executionContext!.lease, own = () => assertRunActive(store, lease);
    own();
    const port = store.candidateStaging!, execution = store.codeExecution!;
    const captured = port.captureRecovery(candidate.candidateId), request = candidate.execution.runRequest;
    if (!request) throw new Error('recovery_metadata_unavailable');
    const source = inputBundle.source.inspection ?? null;
    let bytes: Uint8Array | null = null;
    if (source) {
        try { bytes = captureRecoverySource(store, source.sourceId).bytes; }
        catch (error) { if (!(error instanceof Error) || error.message !== 'recovery_source_capacity') throw error; }
    }
    const tables = Object.fromEntries((candidate.execution.coverage ?? []).map(c => [c.name, {
        rows: captured.inputs.tables[c.name], columns: inputBundle.tables.find(t => t.tableId === c.tableId)!.schema.map(c => c.name),
    }]));
    const roots: DatasetReplayManifest['roots'] = {};
    for (const coverage of candidate.execution.coverage ?? []) {
        roots[coverage.name] = null;
        if (!inputBundle.acceptedCommit && bytes && source) for (const dynamicTyping of [false, true]) {
            try {
                const rows = parseReplayRoot(new TextDecoder('utf-8', { fatal: true }).decode(bytes), source, dynamicTyping);
                if (await codeDigest(rows) === coverage.sha256) { roots[coverage.name] = { kind: 'csv_header', dynamicTyping }; break; }
            } catch { /* A nonmatching source recipe remains explicitly unavailable. */ }
            own();
        }
    }
    const body = { version: 1 as const, effectSafety: 'isolated_local_compute_only' as const,
        request: structuredClone(request), inputBundle: structuredClone(inputBundle), parent: inputBundle.acceptedCommit ?? null,
        source: source ? structuredClone(source) : null, roots, coverage: structuredClone(candidate.execution.coverage ?? []),
        validationBinding: captured.binding };
    const manifest: DatasetReplayManifest = { ...body, digest: await codeDigest(body) }; own();
    const material: DatasetRecoveryMaterial = { version: 1, outputText: execution.workspace.read(candidate.outputArtifacts[0].path).content,
        tables, validationInputs: captured.inputs,
        dependencies: Object.fromEntries(request.inputs.map(ref => [ref.name, execution.workspace.read(ref.path, ref.revision).content])),
        sourceBytes: bytes ? Array.from(bytes) : null };
    own(); return { manifest, material };
};
