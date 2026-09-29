import type {
    CsvData,
    CsvRow,
    DatasetBundle,
    TransformationProgram,
} from '../../types';
import { getCsvDatasetVersion } from '../../utils/datasetId';
import { applyDataOperations } from '../agent/execution/dataOperationRunner';
import { validateTransformationProgram } from './datasetBundle';

export interface TransformationReplayOutcome {
    status: 'trusted' | 'needs_confirmation' | 'blocked';
    data: CsvData;
    committedTransformationIds: string[];
    reasonCodes: string[];
}

export interface DatasetBundleReplayOutcome {
    status: 'replayed' | 'fresh_import_required';
    data: CsvData;
    committedTransformationIds: string[];
    reasonCodes: string[];
}

const cloneData = (data: CsvData): CsvData => ({
    ...data,
    data: data.data.map(row => ({ ...row })),
});

/**
 * Replays an already-verified declarative transformation program. Sandbox
 * programs are intentionally rejected here and must pass through SANDBOX-700.
 */
export const replayVerifiedTransformationProgram = (input: {
    bundle: DatasetBundle;
    program: TransformationProgram;
    currentData: CsvData;
    committedTransformationIds?: string[];
}): TransformationReplayOutcome => {
    const existingIds = new Set(input.committedTransformationIds ?? []);
    const validationErrors = validateTransformationProgram(input.program);
    if (validationErrors.length > 0 || input.program.status !== 'committed') {
        return {
            status: 'blocked',
            data: cloneData(input.currentData),
            committedTransformationIds: [...existingIds],
            reasonCodes: validationErrors.length > 0 ? validationErrors : ['program_not_committed'],
        };
    }
    if (input.program.bundleId !== input.bundle.bundleId) {
        return {
            status: 'blocked',
            data: cloneData(input.currentData),
            committedTransformationIds: [...existingIds],
            reasonCodes: ['program_bundle_mismatch'],
        };
    }
    const pendingSteps = input.program.steps.filter(step => !existingIds.has(step.idempotencyKey));
    if (pendingSteps.some(step => step.kind !== 'declarative' || !step.operation)) {
        return {
            status: 'needs_confirmation',
            data: cloneData(input.currentData),
            committedTransformationIds: [...existingIds],
            reasonCodes: ['sandbox_replay_requires_isolated_runtime'],
        };
    }

    const source = cloneData(input.currentData);
    const applyPendingSteps = (rows: CsvRow[]): CsvRow[] => {
        let nextRows = rows;
        for (const step of pendingSteps) {
            nextRows = applyDataOperations(nextRows, [step.operation!], { allowEmptyResult: false }).data;
        }
        return nextRows;
    };
    let nextRows: CsvRow[];
    try {
        nextRows = applyPendingSteps(source.data);
    } catch (error) {
        return {
            status: 'blocked',
            data: source,
            committedTransformationIds: [...(input.committedTransformationIds ?? [])],
            reasonCodes: [`transformation_replay_failed:${error instanceof Error ? error.message : String(error)}`],
        };
    }
    const replayedData = { ...source, data: nextRows };
    if (getCsvDatasetVersion(replayedData) !== input.program.outputVersion) {
        // Earlier cleaning runs dropped fully empty columns before recording
        // their declarative operations. Recover only when replaying that exact
        // deterministic step also reproduces the committed output hash.
        const columns = new Set<string>();
        if (!source.backing) {
            source.data.forEach(row => Object.keys(row).forEach(column => columns.add(column)));
        }
        const emptyColumns = [...columns]
            .filter(column => source.data.every(row => row[column] == null || String(row[column]).trim() === ''));
        if (emptyColumns.length > 0) {
            const emptyColumnSet = new Set(emptyColumns);
            const withoutEmptyColumns = source.data.map(row => Object.fromEntries(
                Object.entries(row).filter(([column]) => !emptyColumnSet.has(column)),
            ));
            try {
                const recoveredData = { ...source, data: applyPendingSteps(withoutEmptyColumns) };
                if (getCsvDatasetVersion(recoveredData) === input.program.outputVersion) {
                    pendingSteps.forEach(step => existingIds.add(step.idempotencyKey));
                    return {
                        status: 'trusted',
                        data: recoveredData,
                        committedTransformationIds: [...existingIds],
                        reasonCodes: ['transformation_replay_verified'],
                    };
                }
            } catch {
                // The output hash remains the only acceptance condition.
            }
        }
        return {
            status: 'blocked',
            data: source,
            committedTransformationIds: [...(input.committedTransformationIds ?? [])],
            reasonCodes: ['transformation_output_version_mismatch'],
        };
    }
    pendingSteps.forEach(step => existingIds.add(step.idempotencyKey));
    return {
        status: 'trusted',
        data: replayedData,
        committedTransformationIds: [...existingIds],
        reasonCodes: ['transformation_replay_verified'],
    };
};

/**
 * Replays the complete saved lineage atomically. If any program cannot be
 * reproduced, callers receive the untouched current import so they can start
 * a fresh governed analysis instead of leaving the user unable to import.
 */
export const replayDatasetBundlePrograms = (input: {
    bundle: DatasetBundle;
    currentData: CsvData;
}): DatasetBundleReplayOutcome => {
    const source = cloneData(input.currentData);
    let replayedData = source;
    let committedTransformationIds: string[] = [];

    for (const program of input.bundle.transformationPrograms) {
        const replay = replayVerifiedTransformationProgram({
            bundle: input.bundle,
            program,
            currentData: replayedData,
            committedTransformationIds,
        });
        if (replay.status !== 'trusted') {
            return {
                status: 'fresh_import_required',
                data: source,
                committedTransformationIds: [],
                reasonCodes: replay.reasonCodes,
            };
        }
        replayedData = replay.data;
        committedTransformationIds = replay.committedTransformationIds;
    }

    return {
        status: 'replayed',
        data: replayedData,
        committedTransformationIds,
        reasonCodes: ['transformation_lineage_replay_verified'],
    };
};
