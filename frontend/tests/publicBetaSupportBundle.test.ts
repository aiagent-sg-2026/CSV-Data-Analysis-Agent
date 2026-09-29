import { describe, expect, it } from 'vitest';
import type { AppStore } from '../store/useAppStore';
import { buildPublicBetaSupportBundle } from '../services/support/publicBetaSupportBundle';
import { createTestSettings } from './testSettings';

describe('buildPublicBetaSupportBundle', () => {
    it('exports lifecycle metadata without user data, prompts, SQL, identifiers, or credentials', () => {
        const sensitiveValues = [
            'customer-secret@example.com',
            'super-secret-api-key',
            'SELECT * FROM confidential_orders',
            'Ask about customer-secret@example.com',
            'private-report-name.csv',
            'dataset-secret-id',
            'session-secret-id',
            'Customer Email',
        ];
        const state = {
            sessionId: 'session-secret-id',
            currentDatasetId: 'dataset-secret-id',
            settings: createTestSettings({
                provider: 'openai',
                openAIApiKey: 'super-secret-api-key',
                simpleModel: 'gpt-5-mini',
                complexModel: 'gpt-5-mini',
            }),
            csvData: {
                fileName: 'private-report-name.csv',
                data: [{ 'Customer Email': 'customer-secret@example.com', Revenue: 42 }],
            },
            canonicalCsvData: null,
            pipelineOutcome: {
                status: 'degraded_but_usable',
                canAutoAnalyze: true,
                severity: 'warning',
                reasonCode: 'structure_warning',
                message: 'customer-secret@example.com requires review',
            },
            analysisCards: [],
            agentEvents: [{
                id: 'event-1',
                phase: 'execution',
                step: 'query',
                status: 'error',
                message: 'SELECT * FROM confidential_orders',
                detail: {
                    failureStage: 'duckdb_query_failed',
                    sql: 'SELECT * FROM confidential_orders',
                },
                timestamp: new Date(),
            }],
            runtimeEvents: [{
                id: 'runtime-event-1',
                type: 'failed',
                stage: 'execution',
                message: 'customer-secret@example.com',
                timestamp: new Date(),
                sessionId: 'session-secret-id',
                failureClass: 'tool',
                reason: 'Ask about customer-secret@example.com',
            }],
            runtimeRunHistory: [{
                runId: 'run-secret-id',
                outcomeKind: 'failed',
                lifecycleState: 'failed',
                retryCount: 1,
                toolSequence: ['data.query'],
                reason: 'customer-secret@example.com',
                finalObservationSummary: 'Ask about customer-secret@example.com',
            }],
            chatHistory: [{
                sender: 'user',
                text: 'Ask about customer-secret@example.com',
                timestamp: new Date(),
            }],
            queryHistory: [{
                sqlPreview: 'SELECT * FROM confidential_orders',
            }],
        } as unknown as AppStore;

        const bundle = buildPublicBetaSupportBundle(state, {
            appVersion: '0.1.0-beta.1',
            releaseCommit: 'abc123',
            userAgent: 'Release Browser',
            language: 'en-SG',
            generatedAt: '2026-07-25T00:00:00.000Z',
        });

        for (const sensitiveValue of sensitiveValues) {
            expect(bundle).not.toContain(sensitiveValue);
        }
        expect(bundle).not.toContain('run-secret-id');
        expect(bundle).toContain('"rowCount": 1');
        expect(bundle).toContain('"columnCount": 2');
        expect(bundle).toContain('"code": "duckdb_query_failed"');
        expect(bundle).toContain('"containsRawRows": false');
        expect(bundle).toContain('"automaticUpload": false');
    });

    it('reports the full backed dataset shape without exposing column names', () => {
        const state = {
            settings: createTestSettings(),
            csvData: {
                fileName: 'private-large.csv',
                data: [{ 'Sensitive Name': 'sample' }],
                backing: {
                    rowCount: 982_589,
                    columnNames: ['Sensitive Name', 'Secret Amount'],
                },
            },
            canonicalCsvData: null,
            analysisCards: [],
            agentEvents: [],
            runtimeEvents: [],
            runtimeRunHistory: [],
        } as unknown as AppStore;

        const bundle = buildPublicBetaSupportBundle(state, {
            appVersion: 'test',
            releaseCommit: 'local',
            userAgent: 'Test Browser',
            language: 'en-SG',
            generatedAt: '2026-09-29T00:00:00.000Z',
        });

        expect(bundle).toContain('"rowCount": 982589');
        expect(bundle).toContain('"columnCount": 2');
        expect(bundle).not.toContain('Sensitive Name');
        expect(bundle).not.toContain('Secret Amount');
        expect(bundle).not.toContain('private-large.csv');
    });

    it('counts columns introduced after the first in-memory row', () => {
        const state = {
            settings: createTestSettings(),
            csvData: {
                fileName: 'private-sparse.csv',
                data: [
                    { Town: 'A' },
                    { Town: 'B', 'Private Note': 'later value' },
                ],
            },
            canonicalCsvData: null,
            analysisCards: [],
            agentEvents: [],
            runtimeEvents: [],
            runtimeRunHistory: [],
        } as unknown as AppStore;

        const bundle = buildPublicBetaSupportBundle(state, {
            appVersion: 'test',
            releaseCommit: 'local',
            userAgent: 'Test Browser',
            language: 'en-SG',
            generatedAt: '2026-09-29T00:00:00.000Z',
        });

        expect(bundle).toContain('"rowCount": 2');
        expect(bundle).toContain('"columnCount": 2');
        expect(bundle).not.toContain('Private Note');
        expect(bundle).not.toContain('private-sparse.csv');
    });
});
