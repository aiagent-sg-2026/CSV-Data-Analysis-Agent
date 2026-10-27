// @vitest-environment node

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { processAndCleanFile } from '../services/agent/fileProcessor';
import type { CsvData } from '../types';
import type { AppStore } from '../store/useAppStore';
import { buildCsvDataFromRawRows } from '../services/data/reportCsvIntake';
import { createMixedDelimiterWeakSignalReportIntakeCase } from './reportShapeFixtures/cases';

const {
    processCsvWithIntakeIrMock,
    profileDataWithWorkerMock,
    extractAiReportContextMock,
    resolveReportStructureArtifactsWithProposalMock,
    primeDuckDbFileDatasetMock,
    stageDatasetFileInOpfsMock,
    cleanupStaleOpfsSessionsMock,
} = vi.hoisted(() => ({
    processCsvWithIntakeIrMock: vi.fn(),
    profileDataWithWorkerMock: vi.fn(),
    extractAiReportContextMock: vi.fn(),
    resolveReportStructureArtifactsWithProposalMock: vi.fn(),
    primeDuckDbFileDatasetMock: vi.fn(),
    stageDatasetFileInOpfsMock: vi.fn(),
    cleanupStaleOpfsSessionsMock: vi.fn(),
}));

vi.mock('../services/data/csvParser', () => ({
    processCsvWithIntakeIr: processCsvWithIntakeIrMock,
}));

vi.mock('../services/workers/dataWorkerClient', () => ({
    profileDataWithWorker: profileDataWithWorkerMock,
}));

vi.mock('../services/ai/intakeStructureDetector', () => ({ detectIntakeStructureWithAi: vi.fn().mockResolvedValue(null) }));

vi.mock('../services/ai/reportContextExtractor', () => ({
    extractAiReportContext: extractAiReportContextMock,
}));

vi.mock('../services/agent/orchestration/reportStructureOrchestrator', () => ({
    resolveReportStructureArtifactsWithProposal: resolveReportStructureArtifactsWithProposalMock,
}));

vi.mock('../services/data/opfsDatasetStorage', () => ({
    cleanupStaleOpfsSessions: cleanupStaleOpfsSessionsMock, stageDatasetFileInOpfs: stageDatasetFileInOpfsMock,
}));

vi.mock('../services/duckdb/queryEngine', () => ({
    primeDuckDbFileDataset: primeDuckDbFileDatasetMock,
}));

const buildStore = () => {
    const agentEvents: AppStore['agentEvents'] = [];
    const state: any = {
        sessionId: 'file-processor-test',
        settings: {
            provider: 'google',
            geminiApiKey: 'key',
            openAIApiKey: '',
            simpleModel: 'gemini-3-flash-preview',
            complexModel: 'gemini-3-flash-preview',
            language: 'English',
            autoConfirmGoal: true,
        },
        recordAgentEvent: (payload: any) => {
            agentEvents.push({
                ...payload,
                id: payload.id ?? `event-${agentEvents.length + 1}`,
                timestamp: payload.timestamp ?? new Date(),
            });
        },
        logAgentToolUsage: vi.fn(),
    };

    return {
        store: {
            getState: () => state,
            setState: vi.fn((patch: any) => Object.assign(state, typeof patch === 'function' ? patch(state) : patch)),
        },
        agentEvents,
    };
};

const consumeGenerator = async <T>(generator: AsyncGenerator<any, T, unknown>): Promise<T> => {
    let next = await generator.next();
    while (!next.done) {
        next = await generator.next();
    }
    return next.value;
};

const consumeGeneratorWithUpdates = async <T>(generator: AsyncGenerator<any, T, unknown>) => {
    const updates: any[] = [];
    let next = await generator.next();
    while (!next.done) {
        updates.push(next.value);
        next = await generator.next();
    }
    return { result: next.value, updates };
};

describe('processAndCleanFile', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        stageDatasetFileInOpfsMock.mockReset();
        cleanupStaleOpfsSessionsMock.mockReset();
        resolveReportStructureArtifactsWithProposalMock.mockResolvedValue({
            reportStructureResolution: null,
            canonicalCsvData: null,
            canonicalBuildMeta: null,
            canonicalizationStatus: 'ready',
            pipelineOutcome: {
                status: 'ready',
                canAutoAnalyze: true,
            },
        });
    });

    it('preserves imported rows and initializes the AI-first cleaning session', async () => {
        const parsedData: CsvData = {
            fileName: 'sample.csv',
            data: [
                { Title: 'FY2026 Revenue Report', Amount: '' },
                { Title: 'East', Amount: '1200' },
                { Title: 'West', Amount: '950' },
            ],
            metadataRows: [],
            summaryRows: [],
            headerDepth: 1,
            intakeDetection: {
                strategy: 'papaparse_auto_fallback',
                confidence: 'low',
                delimiter: ',',
                quoteChar: null,
                warnings: [
                    {
                        code: 'low_confidence',
                        message: 'CSV dialect detection confidence is limited, so the imported structure should be reviewed in diagnostics.',
                    },
                ],
            },
        };

        const identifiedDatasetId = 'dataset-consent-source';
        processCsvWithIntakeIrMock.mockImplementation(async (
            _file: File,
            _settings: unknown,
            _telemetry: unknown,
            options: { onDatasetIdentified?: (datasetId: string) => void | Promise<void> },
        ) => {
            await options.onDatasetIdentified?.(identifiedDatasetId);
            return {
            csvData: parsedData,
            intakeIr: {
                fileName: 'sample.csv',
                columnCount: 2,
                rawRows: [['Title', 'Amount'], ['FY2026 Revenue Report', ''], ['East', '1200'], ['West', '950']],
                normalizedRows: [['Title', 'Amount'], ['FY2026 Revenue Report', ''], ['East', '1200'], ['West', '950']],
                detection: parsedData.intakeDetection,
                segments: [],
                provisionalTable: null,
                diagnostics: {
                    hasRepeatedHeader: false,
                    hasParameterRowsBetweenHeaderAndBody: false,
                    headerShapeDrift: false,
                    singleColumnFallbackApplied: true,
                    bodyEvidenceKind: 'unknown',
                    segmentCountsByKind: {},
                    headerCandidates: [],
                    bodyStartCandidates: [],
                    evidenceStrength: 'moderate',
                    fallbackReason: null,
                },
            },
            };
        });
        profileDataWithWorkerMock.mockResolvedValue({
            profiles: [
                { name: 'Title', type: 'categorical', uniqueValues: 3, missingPercentage: 0 },
                { name: 'Amount', type: 'numerical', missingPercentage: 33, valueRange: [950, 1200] },
            ],
            issues: ['Detected mixed structural rows.'],
        });
        extractAiReportContextMock.mockResolvedValue({
            reportTitle: 'FY2026 Revenue Report',
            reportDescription: 'Revenue report for fiscal year 2026.',
            parameterLines: [],
            footerLines: [],
            candidateHeaderLine: null,
            confidence: 'high',
            reasoning: 'The first sparse row is a standalone report title.',
        });

        const { store, agentEvents } = buildStore();
        const { result, updates } = await consumeGeneratorWithUpdates(processAndCleanFile(new File(['name,amount\nexample,1\n'], 'sample.csv'), store as any));

        expect(result.rawData.data).toHaveLength(3);
        expect(result.dataForAnalysis.data).toHaveLength(3);
        expect(result.datasetId).toBe(identifiedDatasetId);
        expect(store.setState).toHaveBeenCalledWith({ currentDatasetId: identifiedDatasetId });
        expect(result.dataForAnalysis.data[0].Title).toBe('FY2026 Revenue Report');
        expect(result.rawData.intakeDetection?.strategy).toBe('papaparse_auto_fallback');
        expect(result.dataForAnalysis.intakeDetection?.confidence).toBe('low');
        expect(result.dataPrepPlan?.explanation).toContain('AI cleaning pipeline has been initialized');
        expect(result.dataPrepPlan?.operations).toEqual([]);
        expect(result.dataQualityIssues).toEqual(['Detected mixed structural rows.']);
        expect(result.workspaceFiles['/workspace/report_context.json']).toContain('"aiExtracted"');
        expect(result.workspaceFiles['/workspace/report_context.json']).toContain('"effective"');
        expect(result.workspaceFiles['/workspace/report_context.json']).toContain('FY2026 Revenue Report');
        expect(agentEvents.some(event => event.step === 'dataset_ready_for_ai_cleaning')).toBe(true);
        expect(agentEvents.some(event => event.step === 'report_context_extracted')).toBe(true);
        expect(agentEvents.some(event => event.step === 'baseline_noise_rows_removed')).toBe(false);
        expect(agentEvents.find(event => event.step === 'parsing_completed')?.detail).toMatchObject({
            parserStrategy: 'papaparse_auto_fallback',
            parserConfidence: 'low',
            detectedDelimiter: ',',
            parserWarningCount: 1,
            singleColumnFallbackApplied: true,
        });
        expect(updates.some(update =>
            update.type === 'progress'
            && update.messageType === 'warning'
            && String(update.message).includes('papaparse_auto_fallback'),
        )).toBe(true);
    });

    it('preserves mixed-delimiter intake diagnostics from shared report fixtures through file processing', async () => {
        const fixture = createMixedDelimiterWeakSignalReportIntakeCase();
        const parsedData = buildCsvDataFromRawRows(fixture.fileName, fixture.rawRows, fixture.detection);

        processCsvWithIntakeIrMock.mockResolvedValue({
            csvData: parsedData,
            intakeIr: {
                fileName: fixture.fileName,
                columnCount: 6,
                rawRows: fixture.rawRows,
                normalizedRows: fixture.rawRows,
                detection: parsedData.intakeDetection,
                segments: [],
                provisionalTable: {
                    headerRowIndex: 2,
                    headerLayerRowIndexes: [1],
                    bodyStartIndex: 3,
                    summaryStartIndex: fixture.rawRows.length,
                    repeatedHeaderRowIndexes: [],
                    metadataRowIndexes: [0],
                    parameterRowIndexes: [],
                },
                diagnostics: {
                    hasRepeatedHeader: false,
                    hasParameterRowsBetweenHeaderAndBody: false,
                    headerShapeDrift: false,
                    singleColumnFallbackApplied: false,
                    bodyEvidenceKind: 'numeric',
                    segmentCountsByKind: { metadata: 1, header: 2, body: 1 },
                    headerCandidates: [],
                    bodyStartCandidates: [],
                    evidenceStrength: 'moderate',
                    fallbackReason: null,
                },
            },
        });
        profileDataWithWorkerMock.mockResolvedValue({
            profiles: [
                { name: 'Code', type: 'categorical', uniqueValues: 6, missingPercentage: 0 },
                { name: 'Description', type: 'categorical', uniqueValues: 6, missingPercentage: 0 },
                { name: '22000', type: 'numerical', missingPercentage: 0, valueRange: [70, 150] },
                { name: '22001', type: 'numerical', missingPercentage: 0, valueRange: [65, 120] },
                { name: '22002', type: 'numerical', missingPercentage: 0, valueRange: [75, 115] },
                { name: 'Grand Total', type: 'numerical', missingPercentage: 0, valueRange: [210, 380] },
            ],
            issues: ['Repeated report headers were detected in the imported body region.'],
        });
        extractAiReportContextMock.mockResolvedValue({
            reportTitle: 'OPERATING REVIEW PACK',
            reportDescription: 'Operating review pack extracted on 2026-09-30.',
            parameterLines: ['Extracted on 2026-09-30'],
            footerLines: ['Printed by runtime'],
            candidateHeaderLine: ['Code', 'Description', '22000', '22001', '22002', 'Grand Total'],
            confidence: 'high',
            reasoning: 'Detected metadata, a dominant header row, and a footer line.',
        });

        const { store, agentEvents } = buildStore();
        const { result, updates } = await consumeGeneratorWithUpdates(
            processAndCleanFile(new File(['name,amount\nexample,1\n'], fixture.fileName), store as any),
        );

        expect(result.rawData.intakeDetection?.warnings.map(warning => warning.code)).toEqual(fixture.expectedWarningCodes);
        expect(result.dataForAnalysis.intakeDetection?.warnings.map(warning => warning.code)).toEqual(fixture.expectedWarningCodes);
        expect(agentEvents.find(event => event.step === 'parsing_completed')?.detail).toMatchObject({
            parserStrategy: fixture.detection.strategy,
            parserConfidence: fixture.detection.confidence,
            parserWarningCount: fixture.expectedWarningCodes.length,
            selectedHeaderRowIndex: 2,
            bodyStartIndex: 3,
        });
        expect(updates.some(update =>
            update.type === 'progress'
            && update.messageType === 'warning'
            && String(update.message).includes('Multiple delimiter patterns were detected'),
        )).toBe(true);
    });

    it('normalizes only the staging dataset while keeping rawCsvData immutable', async () => {
        const parsedData: CsvData = {
            fileName: 'ragged.csv',
            data: [
                { Region: 'East', Revenue: '1200' },
                { Region: 'West' } as unknown as CsvData['data'][number],
                { Region: 'South', Revenue: '900', Notes: 'extra' } as unknown as CsvData['data'][number],
            ],
            metadataRows: [],
            summaryRows: [],
            headerDepth: 1,
        };

        processCsvWithIntakeIrMock.mockResolvedValue({
            csvData: parsedData,
            intakeIr: {
                fileName: 'ragged.csv',
                columnCount: 2,
                rawRows: [['Region', 'Revenue'], ['East', '1200'], ['West', ''], ['South', '900']],
                normalizedRows: [['Region', 'Revenue'], ['East', '1200'], ['West', ''], ['South', '900']],
                detection: parsedData.intakeDetection,
                segments: [],
                provisionalTable: null,
                diagnostics: {
                    hasRepeatedHeader: false,
                    hasParameterRowsBetweenHeaderAndBody: false,
                    headerShapeDrift: false,
                    singleColumnFallbackApplied: true,
                    bodyEvidenceKind: 'unknown',
                    segmentCountsByKind: {},
                    headerCandidates: [],
                    bodyStartCandidates: [],
                    evidenceStrength: 'moderate',
                    fallbackReason: null,
                },
            },
        });
        profileDataWithWorkerMock.mockResolvedValue({
            profiles: [
                { name: 'Region', type: 'categorical', uniqueValues: 3, missingPercentage: 0 },
                { name: 'Revenue', type: 'numerical', missingPercentage: 33, valueRange: [900, 1200] },
            ],
            issues: [],
        });
        extractAiReportContextMock.mockResolvedValue(null);

        const { store } = buildStore();
        const result = await consumeGenerator(processAndCleanFile(new File(['name,amount\nexample,1\n'], 'ragged.csv'), store as any));

        expect(result.rawData.data).toEqual([
            { Region: 'East', Revenue: '1200' },
            { Region: 'West', Revenue: '' },
            { Region: 'South', Revenue: '900' },
        ]);
        expect(result.dataForAnalysis.data).toEqual([
            { Region: 'East', Revenue: '1200' },
            { Region: 'West', Revenue: null },
            { Region: 'South', Revenue: '900' },
        ]);
        expect(result.dataForAnalysis.importNormalizationApplied).toBe(true);
        expect(result.dataForAnalysis.importNormalizationSummary).toContain('normalized at import time');
        expect(result.initialDataSample).toEqual(result.rawData.data);
    });

    it('keeps raw unnamed headers immutable while analysis data can expose auto-named columns', async () => {
        const parsedData: CsvData = {
            fileName: 'sales.csv',
            data: [
                { RowNumber: '1.', BRAND: 'Bosch', UOM: 'PCS', 'QTY SOLD': '12.00', 'AMOUNT (SGD)': '1,200.00' },
                { RowNumber: '2.', BRAND: 'Denso', UOM: 'EA', 'QTY SOLD': '8.00', 'AMOUNT (SGD)': '800.00' },
            ],
            metadataRows: [],
            summaryRows: [],
            headerDepth: 1,
            autoNamedColumns: [
                { from: '_unnamed_column_1', to: 'RowNumber', reason: 'sequence_like_row_number' },
                { from: '_unnamed_column_7', to: 'UOM', reason: 'unit_of_measure_between_quantity_and_amount' },
            ],
        };

        processCsvWithIntakeIrMock.mockResolvedValue({
            csvData: parsedData,
            intakeIr: {
                fileName: 'sales.csv',
                columnCount: 5,
                rawRows: [
                    ['', 'BRAND', '', 'QTY SOLD', 'AMOUNT (SGD)'],
                    ['1.', 'Bosch', 'PCS', '12.00', '1,200.00'],
                    ['2.', 'Denso', 'EA', '8.00', '800.00'],
                ],
                normalizedRows: [
                    ['', 'BRAND', '', 'QTY SOLD', 'AMOUNT (SGD)'],
                    ['1.', 'Bosch', 'PCS', '12.00', '1,200.00'],
                    ['2.', 'Denso', 'EA', '8.00', '800.00'],
                ],
                detection: parsedData.intakeDetection,
                segments: [],
                provisionalTable: {
                    headerRowIndex: 0,
                    headerLayerRowIndexes: [],
                    bodyStartIndex: 1,
                    summaryStartIndex: 3,
                    repeatedHeaderRowIndexes: [],
                    metadataRowIndexes: [],
                    parameterRowIndexes: [],
                },
                diagnostics: {
                    hasRepeatedHeader: false,
                    hasParameterRowsBetweenHeaderAndBody: false,
                    headerShapeDrift: false,
                    singleColumnFallbackApplied: false,
                    bodyEvidenceKind: 'numeric',
                    segmentCountsByKind: {},
                    headerCandidates: [],
                    bodyStartCandidates: [],
                    evidenceStrength: 'moderate',
                    fallbackReason: null,
                    autoNamedColumns: parsedData.autoNamedColumns,
                },
            },
        });
        profileDataWithWorkerMock.mockResolvedValue({
            profiles: [
                { name: 'RowNumber', type: 'categorical', uniqueValues: 2, missingPercentage: 0 },
                { name: 'BRAND', type: 'categorical', uniqueValues: 2, missingPercentage: 0 },
                { name: 'UOM', type: 'categorical', uniqueValues: 2, missingPercentage: 0 },
                { name: 'QTY SOLD', type: 'numerical', missingPercentage: 0, valueRange: [8, 12] },
                { name: 'AMOUNT (SGD)', type: 'currency', missingPercentage: 0, valueRange: [800, 1200] },
            ],
            issues: [],
        });
        extractAiReportContextMock.mockResolvedValue(null);

        const { store } = buildStore();
        const result = await consumeGenerator(processAndCleanFile(new File(['name,amount\nexample,1\n'], 'sales.csv'), store as any));

        expect(Object.keys(result.rawData.data[0] ?? {})).toContain('_unnamed_column_1');
        expect(Object.keys(result.rawData.data[0] ?? {})).toContain('_unnamed_column_3');
        expect(Object.keys(result.dataForAnalysis.data[0] ?? {})).toContain('RowNumber');
        expect(Object.keys(result.dataForAnalysis.data[0] ?? {})).toContain('UOM');
        expect(result.rawData.autoNamedColumns).toBeUndefined();
        expect(result.dataForAnalysis.autoNamedColumns).toEqual(parsedData.autoNamedColumns);
        expect(result.initialDataSample).toEqual(result.rawData.data);
    });

    it('rejects files that exceed the desktop capacity before parsing', async () => {
        const { store, agentEvents } = buildStore();
        const oversizedFile = { name: 'huge.csv', size: 101 * 1024 * 1024 } as File;

        const updates: any[] = [];
        const generator = processAndCleanFile(oversizedFile, store as any);
        let threw = false;
        try {
            let next = await generator.next();
            while (!next.done) {
                updates.push(next.value);
                next = await generator.next();
            }
        } catch (error) {
            threw = true;
            expect(error).toBeInstanceOf(Error);
            expect((error as Error).message).toContain('100');
        }

        expect(threw).toBe(true);
        // The generator should have yielded an error progress update before throwing
        expect(updates.some(update =>
            update.type === 'progress'
            && update.messageType === 'error'
            && String(update.message).includes('100'),
        )).toBe(true);
        // An agent event should be emitted for observability
        expect(agentEvents.some(event => event.step === 'file_too_large' && event.status === 'error')).toBe(true);
        // processCsvWithIntakeIr should never be called for oversized files
        expect(processCsvWithIntakeIrMock).not.toHaveBeenCalled();
    });

    it('loads an eligible large desktop CSV into DuckDB and keeps only a preview in CsvData', async () => {
        const previewRows = [
            { month: '1990-01', town: 'ANG MO KIO', resale_price: '9000' },
            { month: '2026-07', town: 'WOODLANDS', resale_price: '650000' },
        ];
        primeDuckDbFileDatasetMock.mockResolvedValue({
            binding: { engine: 'duckdb', tableName: 'session_clean_dataset', loadVersion: 'dataset-file-test' },
            rowCount: 982_589,
            preview: previewRows,
        });
        processCsvWithIntakeIrMock.mockResolvedValue({
            csvData: { fileName: 'large.csv', data: previewRows, headerDepth: 1 },
            intakeIr: {
                fileName: 'large.csv',
                columnCount: 3,
                rawRows: [Object.keys(previewRows[0]), ...previewRows.map(row => Object.values(row))],
                normalizedRows: [Object.keys(previewRows[0]), ...previewRows.map(row => Object.values(row))],
                segments: [],
                provisionalTable: null,
                diagnostics: {
                    hasRepeatedHeader: false,
                    hasParameterRowsBetweenHeaderAndBody: false,
                    headerShapeDrift: false,
                    singleColumnFallbackApplied: false,
                    bodyEvidenceKind: 'numeric',
                    segmentCountsByKind: {},
                    headerCandidates: [],
                    bodyStartCandidates: [],
                    evidenceStrength: 'strong',
                    fallbackReason: null,
                },
            },
        });
        profileDataWithWorkerMock.mockResolvedValue({ profiles: [], issues: [] });
        extractAiReportContextMock.mockResolvedValue(null);
        // Real retained bytes: a forged size is not valid streaming/source evidence.
        const file = new File(['month,town,resale_price\n' + `1990-01,${'A'.repeat(1000)},9000\n`.repeat(27000)], 'large.csv');
        file.arrayBuffer = () => { throw new Error('Large source must not be buffered in full'); };

        const { store } = buildStore();
        const { result, updates } = await consumeGeneratorWithUpdates(processAndCleanFile(file, store as any));

        expect(primeDuckDbFileDatasetMock).toHaveBeenCalledOnce();
        expect(store.getState().csvSourceScan).toMatchObject({ status: 'completed_clean', rows: 27001, bytesRead: file.size });
        expect(primeDuckDbFileDatasetMock.mock.calls[0][1]).toBe(`dataset-file-${result.datasetBundle.source.inspection?.sha256}`);
        expect(result.dataForAnalysis.data).toHaveLength(2);
        expect(result.dataForAnalysis.backing).toMatchObject({
            mode: 'duckdb_file',
            rowCount: 982_589,
            sampleRowCount: 2,
            columnNames: ['month', 'town', 'resale_price'],
            readOnly: true,
            ephemeral: true,
        });
        expect(result.dataQualityIssues.join(' ')).toContain('982,589 source rows');
        expect(updates.some(update => String(update.message).includes('Loaded all 982,589'))).toBe(true);
    });

    it.each([{ gap: '', tail: '\n' }, { gap: '', tail: '\nlast,2\n' }, { gap: '\n', tail: '' }])('preserves normal import semantics for harmless blanks with the real parser: %s', async ({ gap, tail }) => {
        const parser = await vi.importActual<typeof import('../services/data/csvParser')>('../services/data/csvParser');
        processCsvWithIntakeIrMock.mockImplementation(parser.processCsvWithIntakeIr);
        profileDataWithWorkerMock.mockResolvedValue({ profiles: [], issues: [] });
        extractAiReportContextMock.mockResolvedValue(null);
        const { store } = buildStore();
        const file = new File(['key,value\n' + gap + 'x,1\n'.repeat(40) + tail], 'ordinary-blanks.csv');
        const result = await consumeGenerator(processAndCleanFile(file, store as any));
        expect(result.rawData.data).toHaveLength(tail.includes('last') ? 41 : 40);
        expect(result.pipelineOutcome).toMatchObject({ canAutoAnalyze: true });
        expect(store.getState().csvSourceScan).toMatchObject({ status: 'completed_clean', counts: { blank_record: 1 } });
        expect(result.rawData.data.some(row => Object.values(row).every(value => !String(value).trim()))).toBe(false);
    });

    it('does not publish a clean canonical preview when the full source has a late repeated header', async () => {
        const csv = 'key,value\n' + 'x,1\n'.repeat(9000) + 'key,value\n';
        const { parseCsvTextWithDetection } = await import('../services/data/csvDialectDetector');
        const { buildReportIntakeIr } = await import('../services/data/reportCsvIntake');
        const parsed = parseCsvTextWithDetection('key,value\nx,1\n');
        const preview = { fileName: 'late.csv', data: [{ key: 'x', value: '1' }] };
        processCsvWithIntakeIrMock.mockResolvedValue({ csvData: preview, intakeIr: buildReportIntakeIr('late.csv', parsed.rawRows, parsed.detection) });
        profileDataWithWorkerMock.mockResolvedValue({ profiles: [], issues: [] });
        extractAiReportContextMock.mockResolvedValue(null);
        resolveReportStructureArtifactsWithProposalMock.mockResolvedValue({ canonicalCsvData: preview, canonicalBuildMeta: {}, canonicalizationStatus: 'ready', pipelineOutcome: { status: 'ready', canAutoAnalyze: true } });
        const { store } = buildStore();
        const result = await consumeGenerator(processAndCleanFile(new File([csv], 'late.csv'), store as any));
        expect(result.canonicalCsvData).toBeNull();
        expect(result.canonicalBuildMeta).toBeNull();
        expect(result.pipelineOutcome).toMatchObject({ canAutoAnalyze: false, reasonCode: 'source_scan_anomalies' });
        expect(result.datasetBundle.acceptedCommit).toBeUndefined();
        expect(JSON.parse(result.workspaceFiles['/intake/source-scan.json'])).toMatchObject({
            sourceId: result.datasetBundle.source.inspection?.sourceId, sha256: result.datasetBundle.source.inspection?.sha256,
            parsingCoverage: 'complete', schemaConfidence: 'uncertain', counts: { repeated_header: 1 },
            repairCoordinator: 'pending_implementation', commitAllowed: false,
        });
        expect(store.getState().csvSourceScan).toMatchObject({ status: 'completed_anomalies', rows: 9002, counts: { repeated_header: 1 } });
    });

    it.each(['parser', 'cleanup', 'staging'])('fences stale dataset identity and worker initiation after deferred %s', async phase => {
        const { scanCsvSourceForImport } = await import('../services/data/csvSourceScan');
        let release!: () => void;
        const deferred = new Promise<void>(resolve => { release = resolve; });
        let reached = false;
        processCsvWithIntakeIrMock.mockImplementation(async (_file, _settings, _state, options) => {
            reached = true;
            await deferred;
            options?.onDatasetIdentified('stale-dataset');
            throw new Error('parser_should_have_been_fenced');
        });
        if (phase === 'staging') stageDatasetFileInOpfsMock.mockImplementation(async () => { reached = true; await deferred; return 'stale.opfs'; });
        if (phase === 'cleanup') cleanupStaleOpfsSessionsMock.mockImplementation(async () => { reached = true; await deferred; });
        const text = phase !== 'parser' ? 'key,value\n' + `${'x'.repeat(1000)},1\n`.repeat(27000) : 'key,value\nx,1\n';
        const { store } = buildStore();
        const pending = consumeGenerator(processAndCleanFile(new File([text], 'old.csv'), store as any));
        void pending.catch(() => {});
        for (let i = 0; i < 1000 && !reached; i += 1) await new Promise(resolve => setTimeout(resolve, 5));
        expect(reached).toBe(true);
        await scanCsvSourceForImport(store as any, new File(['key,value\nnew,2\n'], 'new.csv'));
        const accepted = { acceptedCommit: { id: 'keep' } };
        const query = { loadVersion: 'newer-binding' };
        store.setState({ currentDatasetId: 'newer-dataset', datasetBundle: accepted, duckDbSessionStatus: query });
        release();
        await expect(pending).rejects.toThrow('scan_source_replaced');
        expect(store.getState().currentDatasetId).toBe('newer-dataset');
        expect(store.getState().datasetBundle).toBe(accepted);
        expect(store.getState().duckDbSessionStatus).toBe(query);
        expect(primeDuckDbFileDatasetMock).not.toHaveBeenCalled();
    });

    it('rejects an old completed scan when the source is replaced during asynchronous structure resolution', async () => {
        const { parseCsvTextWithDetection } = await import('../services/data/csvDialectDetector');
        const { buildReportIntakeIr } = await import('../services/data/reportCsvIntake');
        const { scanCsvSourceForImport } = await import('../services/data/csvSourceScan');
        const parsed = parseCsvTextWithDetection('key,value\nx,1\n');
        const preview = { fileName: 'old.csv', data: [{ key: 'x', value: '1' }] };
        processCsvWithIntakeIrMock.mockResolvedValue({ csvData: preview, intakeIr: buildReportIntakeIr('old.csv', parsed.rawRows, parsed.detection) });
        profileDataWithWorkerMock.mockResolvedValue({ profiles: [], issues: [] });
        extractAiReportContextMock.mockResolvedValue(null);
        let release!: (value: unknown) => void;
        resolveReportStructureArtifactsWithProposalMock.mockImplementation(() => new Promise(resolve => { release = resolve; }));
        const { store } = buildStore();
        const pending = consumeGenerator(processAndCleanFile(new File(['key,value\nx,1\n'], 'old.csv'), store as any));
        for (let i = 0; i < 200 && !release; i += 1) await new Promise(resolve => setTimeout(resolve, 1));
        expect(release).toBeTypeOf('function');
        await scanCsvSourceForImport(store as any, new File(['key,value\nx,2\n'], 'old.csv'));
        release({ canonicalCsvData: preview, canonicalBuildMeta: {}, canonicalizationStatus: 'ready', pipelineOutcome: { status: 'ready', canAutoAnalyze: true } });
        await expect(pending).rejects.toThrow('scan_source_replaced');
        expect(store.getState().canonicalCsvData).toBeUndefined();
    });

    it('rejects parsed datasets that exceed the desktop row limit before profiling', async () => {
        const { store, agentEvents } = buildStore();
        processCsvWithIntakeIrMock.mockResolvedValue({
            csvData: {
                fileName: 'too-many-rows.csv',
                data: Array.from({ length: 100_001 }, (_, index) => ({ Row: index + 1 })),
                metadataRows: [],
                summaryRows: [],
                headerDepth: 1,
            },
            intakeIr: {
                fileName: 'too-many-rows.csv',
                columnCount: 1,
                rawRows: [['Row']],
                normalizedRows: [['Row']],
                segments: [],
                provisionalTable: null,
                diagnostics: {
                    hasRepeatedHeader: false,
                    hasParameterRowsBetweenHeaderAndBody: false,
                    headerShapeDrift: false,
                    singleColumnFallbackApplied: false,
                    bodyEvidenceKind: 'numeric',
                    segmentCountsByKind: {},
                    headerCandidates: [],
                    bodyStartCandidates: [],
                    evidenceStrength: 'strong',
                    fallbackReason: null,
                },
            },
        });

        const updates: any[] = [];
        const generator = processAndCleanFile(
            new File(['name,amount\nexample,1\n'], 'too-many-rows.csv'),
            store as any,
        );

        await expect((async () => {
            let next = await generator.next();
            while (!next.done) {
                updates.push(next.value);
                next = await generator.next();
            }
        })()).rejects.toThrow('100,000');

        expect(updates).toEqual(expect.arrayContaining([
            expect.objectContaining({
                type: 'progress',
                messageType: 'error',
                message: expect.stringContaining('100,000'),
            }),
        ]));
        expect(agentEvents).toEqual(expect.arrayContaining([
            expect.objectContaining({
                step: 'file_row_limit_exceeded',
                status: 'error',
            }),
        ]));
        expect(profileDataWithWorkerMock).not.toHaveBeenCalled();
    });
});
