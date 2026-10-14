import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PiBrowserLab } from '../components/modals/PiBrowserLab';

const { state, executeManagedDataQueryMock, codingChecksMock, sqlChecksMock, tableChecksMock, preparationChecksMock, candidateChecksMock, validationChecksMock, commitChecksMock, lifecycleChecksMock, capacityChecksMock } = vi.hoisted(() => ({
    state: {
        currentDatasetId: 'test-dataset',
        csvData: {
            fileName: 'test.csv',
            data: [
                { Region: 'East', Amount: 10 },
                { Region: 'West', Amount: 20 },
            ],
        },
        canonicalCsvData: null,
        columnProfiles: [
            { name: 'Region', type: 'categorical' },
            { name: 'Amount', type: 'numerical' },
        ],
        settings: { openAIApiKey: '' },
    },
    executeManagedDataQueryMock: vi.fn(),
    codingChecksMock: vi.fn(),
    sqlChecksMock: vi.fn(),
    tableChecksMock: vi.fn(),
    preparationChecksMock: vi.fn(),
    candidateChecksMock: vi.fn(),
    validationChecksMock: vi.fn(),
    commitChecksMock: vi.fn(),
    lifecycleChecksMock: vi.fn(),
    capacityChecksMock: vi.fn(),
}));

vi.mock('../store/useAppStore', () => ({
    useAppStore: Object.assign(
        (selector: (value: typeof state) => unknown) => selector(state),
        { getState: () => state },
    ),
}));

vi.mock('../services/duckdb/queryEngine', () => ({
    executeManagedDataQuery: executeManagedDataQueryMock,
}));
vi.mock('../services/agent/runtime/pi/piCodingLoopQualification', () => ({qualifyPiCodingLoop: codingChecksMock}));
vi.mock('../services/duckdb/sqlQualification', () => ({qualifySqlWorker: sqlChecksMock}));
vi.mock('../services/agent/execution/codeTableExecutionQualification', () => ({qualifyCodeTableExecution: tableChecksMock}));

vi.mock('../services/agent/runtime/pi/piExecutorPreparationQualification', () => ({qualifyPiExecutorPreparation: preparationChecksMock}));
vi.mock('../services/data/candidateCommitQualification', () => ({qualifyCandidateCommit: commitChecksMock}));
vi.mock('../services/data/candidateValidationQualification', () => ({qualifyCandidateValidation: validationChecksMock}));
vi.mock('../services/data/candidateStagingQualification', () => ({qualifyCandidateStaging: candidateChecksMock}));
vi.mock('../services/agent/execution/codeCapacityQualification', () => ({qualifyCodeCapacity: capacityChecksMock}));
vi.mock('../services/agent/runtime/pi/piLifecycleQualification', () => ({qualifyPiLifecycle: lifecycleChecksMock}));

afterEach(() => {
    cleanup();
    executeManagedDataQueryMock.mockReset();
    codingChecksMock.mockReset();
    sqlChecksMock.mockReset();
    tableChecksMock.mockReset();
    preparationChecksMock.mockReset();
    candidateChecksMock.mockReset();
    validationChecksMock.mockReset();
    commitChecksMock.mockReset();
    lifecycleChecksMock.mockReset();
    capacityChecksMock.mockReset();
});

describe('Pi Browser Lab', () => {
    it('keeps lifecycle cancellation incomplete and lets the operator run again', async () => {
        let signal: AbortSignal | undefined;
        lifecycleChecksMock.mockImplementation((captured: AbortSignal, observe: (group: unknown) => void) => {
            signal = captured; observe({group: 'retirement', passed: true, cases: [1, 2, 3]});
            return new Promise(resolve => captured.addEventListener('abort', () => resolve({passed: false}), {once: true}));
        });
        render(<PiBrowserLab onClose={vi.fn()} />);
        fireEvent.click(screen.getByRole('button', {name: 'Run browser lifecycle checks'}));
        await waitFor(() => expect(lifecycleChecksMock).toHaveBeenCalledOnce());
        fireEvent.click(screen.getByRole('button', {name: 'Stop local checks'}));
        await screen.findByText(/Checks cancelled\. Results are incomplete\./);
        expect(signal?.aborted).toBe(true);
        expect(screen.getByRole('status').textContent).toContain('retirement: pass (3 cases)');
        expect((screen.getByRole('button', {name: 'Run browser lifecycle checks'}) as HTMLButtonElement).disabled).toBe(false);
    });
    it('retains failed lifecycle truth and aborts an in-flight matrix on dialog unmount', async () => {
        lifecycleChecksMock.mockResolvedValueOnce({passed: false});
        const {unmount} = render(<PiBrowserLab onClose={vi.fn()} />);
        fireEvent.click(screen.getByRole('button', {name: 'Run browser lifecycle checks'}));
        await screen.findByText(/Browser lifecycle checks incomplete or failed\./);
        let signal: AbortSignal | undefined;
        lifecycleChecksMock.mockImplementationOnce((captured: AbortSignal) => {signal = captured; return new Promise(() => undefined);});
        fireEvent.click(screen.getByRole('button', {name: 'Run browser lifecycle checks'}));
        await waitFor(() => expect(signal).toBeDefined()); unmount(); expect(signal?.aborted).toBe(true);
    });
    it.each(['Pi coding', 'SQL', 'full-table', 'shared preparation', 'candidate', 'validation', 'commit', 'capacity'])('labels %s Stop as cancellation when the qualifier resolves an incomplete result', async mode => {
        let capturedSignal: AbortSignal | undefined;
        const qualifier = mode === 'capacity' ? capacityChecksMock : mode === 'commit' ? commitChecksMock : mode === 'validation' ? validationChecksMock : mode === 'candidate' ? candidateChecksMock : mode === 'shared preparation' ? preparationChecksMock : mode === 'SQL' ? sqlChecksMock : mode === 'full-table' ? tableChecksMock : codingChecksMock;
        const button = `Run local ${mode} checks`;
        qualifier.mockImplementation((signal: AbortSignal, observe: (check: unknown) => void) => {
            capturedSignal = signal;
            observe({id: 'completed-before-stop', passed: true, status: 'completed'});
            return new Promise(resolve => signal.addEventListener('abort', () => resolve({passed: false}), {once: true}));
        });
        render(<PiBrowserLab onClose={vi.fn()} />);
        fireEvent.click(screen.getByRole('button', {name: button}));
        await waitFor(() => expect(qualifier).toHaveBeenCalledOnce());
        fireEvent.click(screen.getByRole('button', {name: 'Stop local checks'}));
        await screen.findByText(/Checks cancelled\. Results are incomplete\./);
        expect(capturedSignal?.aborted).toBe(true);
        expect(screen.getByRole('status').textContent).toContain('completed-before-stop: pass');
        expect(screen.getByRole('status').textContent).not.toContain('checks passed');
        expect((screen.getByRole('button', {name: button}) as HTMLButtonElement).disabled).toBe(false);
    });
    it('keeps capacity failure truthful and aborts it on dialog unmount', async () => {
        capacityChecksMock.mockResolvedValueOnce({passed: false});
        const {unmount} = render(<PiBrowserLab onClose={vi.fn()} />);
        fireEvent.click(screen.getByRole('button', {name: 'Run local capacity checks'}));
        await screen.findByText(/Local capacity checks incomplete or failed\./);
        let signal: AbortSignal | undefined;
        capacityChecksMock.mockImplementationOnce((captured: AbortSignal) => {signal=captured;return new Promise(() => undefined);});
        fireEvent.click(screen.getByRole('button', {name: 'Run local capacity checks'}));
        await waitFor(() => expect(signal).toBeDefined()); unmount(); expect(signal?.aborted).toBe(true);
    });
    it('runs the keyless Pi tool cycle from the React dialog', async () => {
        executeManagedDataQueryMock.mockResolvedValue({
            engine: 'duckdb',
            result: { rows: [{ row_count: 2, metric_sum: 30 }], truncated: false },
        });
        render(<PiBrowserLab onClose={vi.fn()} />);

        expect(screen.getByRole('dialog', { name: 'Pi Browser Lab' })).toBeTruthy();
        fireEvent.click(screen.getByRole('button', { name: 'Run mock tool cycle' }));

        // The dialog dynamically imports the Pi agent on click; a cold module load under
        // CPU contention can exceed testing-library's default 1s waitFor timeout.
        await waitFor(
            () => expect(screen.getByLabelText('Pi answer').textContent).toContain('metric_sum'),
            { timeout: 10_000 },
        );
        expect(executeManagedDataQueryMock).toHaveBeenCalledOnce();
        expect(screen.queryByRole('alert')).toBeNull();
    });
});
