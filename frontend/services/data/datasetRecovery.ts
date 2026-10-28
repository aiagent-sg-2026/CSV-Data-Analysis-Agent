import type { StoreApi } from '../agent/types';
import type { DatasetCommitMarker, DatasetCommitReference } from '../../types/datasetCommit';
import type { DatasetRecoveryMaterial, DatasetReplayManifest } from './datasetRecoveryContract';
import { bindRecoverySource, captureRecoverySource, readSourceRecords } from './immutableCsvSource';
import { parseReplayRoot } from './datasetReplay';
import { codeDigest, CODE_TABLE_LIMITS } from '../agent/execution/codeTableInputs';
import { assertRunActive } from '../session/sessionOwnership';
import { sha256Bytes } from './sourceDigest';
import { parseCandidateOutput } from './candidateContract';
import { validateCandidateSemantics } from './candidateValidation';
import { assessDatasetRelationship } from './datasetBundle';
import { validateCodeRunRequest } from '../agent/execution/codeExecutionContract';
import { createJavaScriptGuest } from '../sandbox/javascriptGuestClient';
import { JAVASCRIPT_GUEST_PIN, GUEST_LOG_BYTES, resolveGuestLimits } from '../sandbox/javascriptGuestProtocol';
import { executeCodeStream, planCodeStream } from '../agent/execution/codeStatefulStream';
import * as Papa from 'papaparse';

const textDigest = (text: string) => sha256Bytes(new TextEncoder().encode(text));
type Guest = ReturnType<typeof createJavaScriptGuest>;
export interface RecoveryOptions {
    file?: File;
    dependencies?: Record<string, string>;
    guest?: Guest;
    material?: DatasetRecoveryMaterial;
    readParent?: (ref: DatasetCommitReference) => Promise<DatasetCommitMarker>;
    readMaterial?: (marker: DatasetCommitMarker) => Promise<DatasetRecoveryMaterial | undefined>;
    deadline?: number;
}

export const verifyReplayManifest = async (marker: DatasetCommitMarker): Promise<DatasetReplayManifest> => {
    const m = marker.replayManifest;
    if (!m || m.version !== 1) throw new Error('recovery_metadata_unavailable');
    const { digest, ...body } = m;
    if (m.effectSafety !== 'isolated_local_compute_only' || marker.environment?.egress !== 'denied') throw new Error('recovery_uncertain_effect');
    if (await codeDigest(body) !== digest || !validateCodeRunRequest(m.request)
        || JSON.stringify(m.request.program) !== JSON.stringify({path:marker.program.path,revision:marker.program.revision,sha256:marker.program.sha256})
        || marker.program.sha256 !== marker.validation.programDigest || await textDigest(marker.program.content) !== marker.program.sha256
        || await codeDigest(m.validationBinding) !== marker.validation.contractDigest
        ||JSON.stringify(m.validationBinding.protectedSource)!==JSON.stringify(marker.validation.protectedSource)
        ||JSON.stringify(m.validationBinding.inputBindings)!==JSON.stringify(m.inputBundle.tables.map(t=>({tableId:t.tableId,datasetVersion:t.datasetVersion,relationshipSetId:m.inputBundle.relationshipSetId})))
        || await codeDigest(marker.environment) !== marker.validation.environmentDigest) throw new Error('recovery_metadata_mismatch');
    const limits = resolveGuestLimits(marker.environment.limits as Parameters<typeof resolveGuestLimits>[0]);
    const mode = m.request.mode ?? (m.request.tables?.length ? 'whole_table' : 'artifact_json');
    const expected = { protocol: 1, runtime: JAVASCRIPT_GUEST_PIN,
        wasmSha256: '105c3bed22d457e43e3d1c3c1c6959fda62a8fe06f0fc8a985303c3a2be72232', mode, semantics: 1,
        tableLimits: CODE_TABLE_LIMITS, egress: 'denied', limits, logBytes: GUEST_LOG_BYTES };
    if (await codeDigest(expected) !== marker.validation.environmentDigest) throw new Error('recovery_environment_unavailable');
    if (marker.validation.decision !== 'validated' || marker.validation.validator !== 'host-candidate-semantics-v1'
        || marker.outputArtifacts[0]?.sha256 !== marker.validation.outputDigest
        || marker.outputArtifacts[0]?.path !== m.request.output.path
        || JSON.stringify(m.coverage.map(c => [c.name, c.tableId])) !== JSON.stringify((m.request.tables ?? []).map(t => [t.name, t.tableId]))
        || m.coverage.some(c=>c.sha256!==m.validationBinding.tableDigests[c.tableId]
            ||!m.inputBundle.tables.some(t=>t.tableId===c.tableId&&t.datasetVersion===c.datasetVersion)
            ||c.relationshipSetId!==m.inputBundle.relationshipSetId)
        ||JSON.stringify(m.parent)!==JSON.stringify(m.inputBundle.acceptedCommit??null)
        ||JSON.stringify(m.source)!==JSON.stringify(m.inputBundle.source.inspection??null)) {
        throw new Error('recovery_metadata_mismatch');
    }
    return m;
};

const executionInput = (manifest: DatasetReplayManifest, material: DatasetRecoveryMaterial) => {
    const inputs: Record<string, unknown> = Object.create(null);
    for (const ref of manifest.request.inputs) inputs[ref.name] = { ...ref, content: material.dependencies[ref.name] };
    // Match the adapter's artifact envelope (the name belongs to the input map, not the envelope).
    for (const ref of manifest.request.inputs) delete (inputs[ref.name] as Record<string, unknown>).name;
    for (const s of manifest.request.sources ?? []) {
        const bytes = material.sourceBytes;
        if (!bytes || !manifest.source || s.sourceId !== manifest.source.sourceId || s.sha256 !== manifest.source.sha256) throw new Error('recovery_source_unavailable');
        const end = Math.min(bytes.length, s.offset + s.length);
        inputs[s.name] = { source: manifest.source, offset: s.offset, end, bytes: bytes.slice(s.offset, end), complete: end === bytes.length };
    }
    Object.assign(inputs, material.tables); return inputs;
};

export const validateRecoveryMaterial = async (marker: DatasetCommitMarker, material: DatasetRecoveryMaterial) => {
    const m = await verifyReplayManifest(marker);
    if (!material || material.version !== 1 || await textDigest(material.outputText) !== marker.validation.outputDigest) throw new Error('recovery_output_mismatch');
    for (const ref of m.request.inputs) if (typeof material.dependencies[ref.name] !== 'string'
        || await textDigest(material.dependencies[ref.name]) !== ref.sha256) throw new Error('recovery_dependency_unavailable');
    for (const c of m.coverage) {
        const table = material.tables[c.name];
        if (!table || table.rows.length !== c.rowCount || !c.complete || c.deliveredRows !== c.rowCount
            || await codeDigest(table.rows) !== c.sha256 || await codeDigest(material.validationInputs.tables[c.name]) !== c.sha256
            || JSON.stringify(table.columns) !== JSON.stringify(m.inputBundle.tables.find(t => t.tableId === c.tableId)?.schema.map(c => c.name))) {
            throw new Error('recovery_input_mismatch');
        }
    }
    if (m.source && material.sourceBytes && (material.sourceBytes.length!==m.source.byteSize
        ||material.sourceBytes.some(b=>!Number.isInteger(b)||b<0||b>255)
        ||await sha256Bytes(new Uint8Array(material.sourceBytes)) !== m.source.sha256)) throw new Error('recovery_source_mismatch');
    if ((m.request.sources??[]).length) {
        if(!m.source||!material.sourceBytes)throw new Error('recovery_source_unavailable');
        const parsed=Papa.parse<string[]>(new TextDecoder('utf-8',{fatal:true}).decode(new Uint8Array(material.sourceBytes)),
            {header:false,skipEmptyLines:false,delimiter:m.source.dialect.delimiter,quoteChar:m.source.dialect.quoteChar});
        if(parsed.data.length===m.source.recordCount+1&&parsed.data.at(-1)?.join('')==='')parsed.data.pop();
        if(parsed.errors.length||parsed.data.length!==m.source.recordCount)throw new Error('recovery_source_structure_mismatch');
        for(const s of m.request.sources??[])if(JSON.stringify(parsed.data)!==JSON.stringify(material.validationInputs.sources[s.name])
            ||material.validationInputs.sourceIdentities?.[s.name]!==s.sourceId)throw new Error('recovery_input_mismatch');
    }
    if (await codeDigest(executionInput(m, material)) !== marker.validation.inputDigest) throw new Error('recovery_input_mismatch');
    let outputText = material.outputText;
    if (m.request.mode === 'stateful_stream') {
        const array: unknown = JSON.parse(outputText);
        if (!Array.isArray(array) || array.length !== 1) throw new Error('recovery_output_mismatch');
        outputText = JSON.stringify(array[0]);
    }
    const output = parseCandidateOutput(outputText);
    const verdict = validateCandidateSemantics(output, m.validationBinding.contract, material.validationInputs);
    if (verdict.decision !== 'validated') throw new Error('recovery_validation_failed');
    if (output.tables.length !== marker.bundle.tables.length || output.tables.some(t => {
        const saved = marker.bundle.tables.find(b => b.name === t.name);
        return !saved || saved.rowCount !== t.rowCount || saved.role !== t.role || JSON.stringify(saved.schema) !== JSON.stringify(t.schema);
    })) throw new Error('recovery_output_mismatch');
    if (m.validationBinding.contract.completeSourceCells) {
        if (JSON.stringify(marker.lineage) !== JSON.stringify({ tables: output.tables.map(t => ({ name: t.name, cells: t.lineage })), excludedRows: output.excludedRows })
            || marker.bundle.relationships.length !== output.relationships.length) throw new Error('recovery_relationship_mismatch');
        for (const relation of output.relationships) {
            const from = marker.bundle.tables.find(t => t.name === relation.fromTable)!, to = marker.bundle.tables.find(t => t.name === relation.toTable)!;
            const saved = marker.bundle.relationships.find(r => r.fromTableId === from.tableId && r.toTableId === to.tableId);
            if (!saved) throw new Error('recovery_relationship_mismatch');
            const assessed = assessDatasetRelationship({ fromTable: from, toTable: to,
                fromRows: output.tables.find(t => t.name === from.name)!.rows, toRows: output.tables.find(t => t.name === to.name)!.rows,
                fromKeys: relation.fromKeys, toKeys: relation.toKeys }, saved.validatedAt);
            if (assessed.decision !== 'trusted' || assessed.cardinality !== relation.cardinality
                || JSON.stringify(assessed) !== JSON.stringify(saved)) throw new Error('recovery_relationship_mismatch');
        }
    }
    return { output, material, manifest: m };
};

/** Explicit host operation under a fresh lease. It can only recompute isolated local work. */
export const reconstructDatasetCommit = async (store: StoreApi, marker: DatasetCommitMarker, options: RecoveryOptions = {}, depth = 0):
    Promise<Awaited<ReturnType<typeof validateRecoveryMaterial>>> => {
    const lease = store.executionContext?.lease;
    if (!lease) throw new Error('scope_revoked');
    const own = () => { assertRunActive(store, lease); if (options.deadline && Date.now() >= options.deadline) throw new Error('recovery_deadline'); }; own();
    if (depth > 16) throw new Error('recovery_chain_capacity');
    const m = await verifyReplayManifest(marker); own();
    // Explicit reattachment must verify the supplied file even if retained rows are usable.
    if (options.file) {
        if (!m.source) throw new Error('recovery_source_unavailable');
        await bindRecoverySource(store, options.file, m.source); own();
    }
    let retained=options.material;
    if(!retained)try{retained=await options.readMaterial?.(marker);}
    catch(error){if(!options.file||!(error instanceof Error)||error.message!=='retention_rows_unavailable')throw error;}
    own();
    if (retained) {
        const result = await validateRecoveryMaterial(marker, retained); own();
        if(m.source&&retained.sourceBytes&&!options.file){await bindRecoverySource(store,new File([new Uint8Array(retained.sourceBytes)],m.source.fileName),m.source);own();}
        return result;
    }
    if (!m.source || !options.file) throw new Error('recovery_source_unavailable');
    const source = captureRecoverySource(store, m.source.sourceId);
    const material: DatasetRecoveryMaterial = { version: 1, outputText: '', tables: {}, dependencies: options.dependencies ?? {}, sourceBytes: Array.from(source.bytes),
        validationInputs: { tables: {}, sources: {}, sourceIdentities: {} } };
    for (const ref of m.request.inputs) if (typeof material.dependencies[ref.name] !== 'string'
        || await textDigest(material.dependencies[ref.name]) !== ref.sha256) throw new Error('recovery_dependency_unavailable');
    own();
    let parent: Awaited<ReturnType<typeof validateRecoveryMaterial>> | undefined;
    if (m.parent) {
        if (!options.readParent) throw new Error('recovery_parent_unavailable');
        const saved = await options.readParent(m.parent); own();
        if (saved.sessionId !== m.parent.sessionId || saved.commitId !== m.parent.commitId || saved.revision !== m.parent.revision) throw new Error('recovery_parent_mismatch');
        parent = await reconstructDatasetCommit(store, saved, { ...options, material: undefined }, depth + 1); own();
    }
    for (const coverage of m.coverage) {
        const inputTable = m.inputBundle.tables.find(t => t.tableId === coverage.tableId);
        if (!inputTable) throw new Error('recovery_input_mismatch');
        const recipe = m.roots[coverage.name];
        const rows = parent ? parent.output.tables.find(t => t.name === inputTable.name)?.rows
            : recipe?.kind === 'csv_header' ? parseReplayRoot(new TextDecoder('utf-8', { fatal: true }).decode(source.bytes), m.source, recipe.dynamicTyping) : undefined;
        if (!rows || await codeDigest(rows) !== coverage.sha256) throw new Error('recovery_source_structure_unavailable');
        own(); material.tables[coverage.name] = { rows, columns: inputTable.schema.map(c => c.name) };
        material.validationInputs.tables[coverage.name] = rows;
    }
    for (const s of m.request.sources ?? []) {
        const rows: string[][] = [];
        if (m.source.recordCount > CODE_TABLE_LIMITS.rows) throw new Error('recovery_source_capacity');
        for (let row = 0; row < m.source.recordCount; row++) {
            const record = readSourceRecords(store, m.source.sourceId, row, 1).records[0];
            if (!record || record.diagnostics.length) throw new Error('recovery_source_structure_mismatch');
            rows.push(record.cells.map(c => c.value));
        }
        material.validationInputs.sources[s.name] = rows; material.validationInputs.sourceIdentities![s.name] = s.sourceId;
    }
    const inputs = executionInput(m, material);
    if (await codeDigest(inputs) !== marker.validation.inputDigest) throw new Error('recovery_input_mismatch'); own();
    const guest = options.guest ?? createJavaScriptGuest(store), limits = resolveGuestLimits(marker.environment.limits as Parameters<typeof resolveGuestLimits>[0]);
    const deadline = Math.min(options.deadline ?? Infinity, Date.now() + limits.timeoutMs);
    const run = async (inputJson: string) => {
        own(); const remaining = deadline - Date.now(); if (remaining < 1) throw new Error('recovery_deadline');
        const result = await guest.run(marker.program.content, inputJson, { limits: { ...limits, timeoutMs: remaining }, signal: lease.signal }); own(); return result;
    };
    try {
        const result = m.request.stream ? await executeCodeStream(m.request.stream, planCodeStream(m.request.stream, material.tables), inputs, limits,
            run, own, () => undefined, { recovery: marker.commitId }) : await run(JSON.stringify(inputs));
        own(); if (result.status !== 'completed' || typeof result.outputJson !== 'string') throw new Error('recovery_execution_failed');
        material.outputText = result.outputJson;
        const verified = await validateRecoveryMaterial(marker, material); own(); return verified;
    } finally { if (!options.guest) guest.dispose(); }
};
