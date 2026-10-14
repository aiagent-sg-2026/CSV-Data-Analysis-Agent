import type { Report, DatasetBundle, DatasetScopeBinding } from '../../types';
import { commitHeadKey, type DatasetCommitRecord, type DatasetCommitMarker } from '../../types/datasetCommit';

export const datasetCommitBindings = (bundle: DatasetBundle): DatasetScopeBinding[] => bundle.tables.map(table => ({
    tableId: table.tableId, datasetVersion: table.datasetVersion, relationshipSetId: bundle.relationshipSetId,
}));

/** Always apply the durable pointer, including when an outgoing snapshot predates admission. */
export const projectCommittedReport = (report: Report, marker: DatasetCommitMarker): Report => ({
    ...report,
    lineage: report.lineage ? { ...report.lineage, currentVersionId: marker.bundle.datasetVersion } : undefined,
    appState: {
        ...report.appState, datasetBundle: structuredClone(marker.bundle), datasetCommitBindingStatus: 'awaiting_source',
        csvData: null, canonicalCsvData: null, rawCsvData: null, rawIntakeIr: null, initialDataSample: null,
        currentView: 'file_upload', activeDataQuery: null, datasetSemanticSnapshot: null, semanticDatasetVersion: null,
        semanticStatus: 'idle', columnProfiles: [], columnRegistry: null, canonicalBuildMeta: null,
        activeMetricMappingValidation: null, activeSpreadsheetFilter: null, spreadsheetFilterFunction: null,
        pendingClarification: null, pendingMutationConfirmation: null, activeTurn: null, activeAgentTask: null,
        candidateRecovery: report.appState.candidateRecovery
            && JSON.stringify(report.appState.candidateRecovery.proposal.inputBindings) === JSON.stringify(datasetCommitBindings(marker.bundle))
            && report.appState.candidateRecovery.proposal.commitId !== marker.commitId
            && report.appState.candidateRecovery.proposal.idempotencyKey !== marker.idempotencyKey
            ? report.appState.candidateRecovery : null,
        isBusy: false, isGeneratingReport: false, isSummaryGenerating: false,
        duckDbSessionStatus: { status: 'idle', engine: null, tableName: null, loadVersion: null, fallbackReason: null, lastSyncedAt: null },
        workspaceFiles: Object.fromEntries(Object.entries(report.appState.workspaceFiles ?? {})
            .filter(([path]) => !path.startsWith('/dataset/') && !path.startsWith('/workspace/dataset/'))),
    },
});

export interface CommitRecordReader {
    get(key: string): Promise<DatasetCommitRecord | undefined>;
    index?(name:'commitId'): {getAll(key:string):Promise<DatasetCommitRecord[]>};
}
export const reconcileReportCommit = async (reader: CommitRecordReader, report: Report): Promise<Report> => {
    const head = await reader.get(commitHeadKey(report.appState.sessionId));
    if (!head) {
        const ref=report.appState.datasetBundle?.acceptedCommit;
        if(!ref||!reader.index)return report;
        const records=await reader.index('commitId').getAll(ref.commitId);
        const marker=records.find((r):r is DatasetCommitMarker=>r.kind==='commit'&&r.sessionId===ref.sessionId&&r.revision===ref.revision);
        if(!marker)throw new Error('commit_marker_invalid');
        return projectCommittedReport(report,marker);
    }
    if (head.kind !== 'head') throw new Error('commit_marker_invalid');
    const marker = await reader.get(head.markerKey);
    if (!marker || marker.kind !== 'commit' || marker.commitId !== head.commitId || marker.revision !== head.revision
        || marker.sessionId !== head.sessionId) throw new Error('commit_marker_invalid');
    return projectCommittedReport(report, marker);
};
