// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryPanel } from '../components/modals/MemoryPanel';
import { resolveReportMemoryScope } from '../services/agent/memory/memoryScope';

const mocks = vi.hoisted(() => ({
    getDocumentsForScope: vi.fn(async () => [] as Array<{ id: string; text: string }>),
    ensureVectorMemoryReady: vi.fn(async () => undefined),
    search: vi.fn(async () => [] as Array<{ text: string; score: number }>),
    getStatus: vi.fn(() => 'ready' as const),
    getLastError: vi.fn(() => null),
    getDocuments: vi.fn(async () => []),
    deleteDocument: vi.fn(async () => true),
    schedulePersist: vi.fn(),
    flushPendingVectorMemoryDocs: vi.fn(async () => undefined),
}));

vi.mock('../services/vectorStore', () => ({
    vectorStore: mocks,
}));
vi.mock('../services/agent/memory/vectorMemorySync', () => ({
    flushPendingVectorMemoryDocs: mocks.flushPendingVectorMemoryDocs,
}));

const state = {
    isMemoryPanelOpen: true,
    setIsMemoryPanelOpen: vi.fn(),
    sessionId: 'report-1',
    currentDatasetId: null as string | null,
    reportMemoryScope: null,
    rawCsvData: null,
    canonicalCsvData: null,
    csvData: null as { fileName: string; data: Array<{ Town: string }> } | null,
};

const useAppStoreMock = vi.hoisted(() => Object.assign(vi.fn(), {
    getState: vi.fn(),
    setState: vi.fn(),
}));

vi.mock('../store/useAppStore', () => ({ useAppStore: useAppStoreMock }));

describe('MemoryPanel search availability and feedback', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        Object.defineProperty(Element.prototype, 'scrollIntoView', { configurable: true, value: vi.fn() });
        state.isMemoryPanelOpen = true;
        state.csvData = null;
        mocks.getDocumentsForScope.mockResolvedValue([]);
        mocks.search.mockResolvedValue([]);
        useAppStoreMock.mockImplementation((selector: (value: typeof state) => unknown) => selector(state));
        useAppStoreMock.getState.mockImplementation(() => state);
    });

    afterEach(cleanup);

    it('does not start the local memory model or offer search without a dataset', async () => {
        render(<MemoryPanel />);

        expect(screen.getByText('Upload and analyze a CSV to create searchable memory.')).toBeInTheDocument();
        expect(screen.getByRole('textbox', { name: 'Search saved memories' })).toBeDisabled();
        expect(screen.getByRole('button', { name: 'Search' })).toBeDisabled();
        await waitFor(() => expect(mocks.getDocumentsForScope).toHaveBeenCalled());
        expect(mocks.ensureVectorMemoryReady).not.toHaveBeenCalled();
    });

    it('explains an empty report memory after loading a dataset', async () => {
        state.csvData = { fileName: 'sample.csv', data: [{ Town: 'North' }] };
        render(<MemoryPanel />);

        expect(await screen.findByText('No saved memory items are available for this report yet.')).toBeInTheDocument();
        expect(screen.getByRole('textbox', { name: 'Search saved memories' })).toBeDisabled();
        expect(screen.getByRole('button', { name: 'Search' })).toBeDisabled();
        expect(mocks.search).not.toHaveBeenCalled();
    });

    it('shows a retry instead of an empty-memory claim when the worker list fails', async () => {
        mocks.getDocumentsForScope
            .mockRejectedValueOnce(new Error('Worker unavailable'))
            .mockResolvedValueOnce([{ id: 'memory-1', text: 'Town prices' }]);
        render(<MemoryPanel />);

        expect(await screen.findByRole('alert')).toHaveTextContent('Could not load report memory');
        expect(screen.queryByText("The AI's memory is currently empty.")).not.toBeInTheDocument();
        fireEvent.click(screen.getByRole('button', { name: 'Retry memory list' }));
        expect(await screen.findByText('Town prices')).toBeInTheDocument();
        expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    });

    it('does not show the previous report memory while a reopened panel loads', async () => {
        mocks.getDocumentsForScope
            .mockResolvedValueOnce([{ id: 'old-memory', text: 'Old report item' }])
            .mockImplementationOnce(() => new Promise<Array<{ id: string; text: string }>>(() => {}));
        const view = render(<MemoryPanel />);
        expect(await screen.findByText('Old report item')).toBeInTheDocument();

        state.isMemoryPanelOpen = false;
        view.rerender(<MemoryPanel />);
        state.isMemoryPanelOpen = true;
        view.rerender(<MemoryPanel />);

        expect(screen.queryByText('Old report item')).not.toBeInTheDocument();
        expect(screen.getByText('Loading report memory...')).toBeInTheDocument();
    });

    it('ignores a model activation that finishes after the panel closes', async () => {
        let finishActivation: (() => void) | undefined;
        mocks.ensureVectorMemoryReady.mockImplementationOnce(() => new Promise<void>(resolve => {
            finishActivation = resolve;
        }));
        mocks.getDocumentsForScope.mockResolvedValue([{ id: 'memory-1', text: 'Town prices' }]);
        state.csvData = { fileName: 'sample.csv', data: [{ Town: 'North' }] };
        const view = render(<MemoryPanel />);
        expect(await screen.findByText('Town prices')).toBeInTheDocument();

        state.isMemoryPanelOpen = false;
        view.rerender(<MemoryPanel />);
        await act(async () => finishActivation?.());

        expect(mocks.getDocumentsForScope).toHaveBeenCalledTimes(1);
        expect(screen.queryByText('Town prices')).not.toBeInTheDocument();
    });

    it('shows no-result and failure feedback for a scoped search', async () => {
        state.csvData = { fileName: 'sample.csv', data: [{ Town: 'North' }] };
        mocks.getDocumentsForScope.mockResolvedValue([{ id: 'memory-1', text: 'Town prices' }]);
        render(<MemoryPanel />);

        const input = screen.getByRole('textbox', { name: 'Search saved memories' });
        await waitFor(() => expect(input).toBeEnabled());
        fireEvent.change(input, { target: { value: 'town' } });
        fireEvent.click(screen.getByRole('button', { name: 'Search' }));

        expect(await screen.findByRole('status')).toHaveTextContent('No matching memories found for this query.');
        expect(mocks.search).toHaveBeenCalledOnce();

        mocks.search.mockRejectedValueOnce(new Error('model unavailable'));
        fireEvent.change(input, { target: { value: 'prices' } });
        fireEvent.click(screen.getByRole('button', { name: 'Search' }));

        expect(await screen.findByRole('alert')).toHaveTextContent('Memory search failed. Try again.');
        expect(screen.getByRole('button', { name: 'Search' })).toBeEnabled();
    });

    it('exposes a matching memory as a keyboard-accessible result action', async () => {
        state.csvData = { fileName: 'sample.csv', data: [{ Town: 'North' }] };
        mocks.getDocumentsForScope.mockResolvedValue([{ id: 'memory-1', text: 'Town prices' }]);
        mocks.search.mockResolvedValueOnce([{ text: 'Town prices', score: 0.9 }]);
        render(<MemoryPanel />);

        const input = screen.getByRole('textbox', { name: 'Search saved memories' });
        await waitFor(() => expect(input).toBeEnabled());
        fireEvent.change(input, { target: { value: 'town' } });
        fireEvent.click(screen.getByRole('button', { name: 'Search' }));

        const result = await screen.findByRole('button', { name: /Match.*90\.0%.*Town prices/ });
        fireEvent.click(result);
        expect(document.getElementById('memory-doc-Town prices')).toHaveClass('ring-2');
    });

    it('keeps exact scope and item provenance available without repeating IDs in the default view', async () => {
        state.csvData = { fileName: 'sample.csv', data: [{ Town: 'North' }] };
        const scope = resolveReportMemoryScope(state as never)!;
        mocks.getDocumentsForScope.mockResolvedValue([{
            id: 'memory-1',
            text: 'Town prices',
            metadata: {
                scope,
                origin: { kind: 'analysis_card', label: 'Saved analysis', createdAt: '2026-09-29T00:00:00.000Z' },
            },
        }] as never);
        render(<MemoryPanel />);

        expect(await screen.findByText('Town prices')).toBeInTheDocument();
        const scopeToggle = screen.getByRole('button', { name: 'View scope IDs' });
        expect(scopeToggle).toHaveAttribute('aria-expanded', 'false');
        expect(screen.getByText(new RegExp(scope.reportId))).not.toBeVisible();

        fireEvent.click(scopeToggle);
        expect(screen.getByRole('button', { name: 'Hide scope IDs' })).toHaveAttribute('aria-expanded', 'true');
        expect(screen.getByText(/Active scope: Report/)).toBeVisible();

        const provenance = screen.getByText('Exact provenance').closest('details');
        expect(provenance).not.toHaveAttribute('open');
        expect(provenance).toHaveTextContent(scope.datasetVersion);
    });

    it('requires an inline second action before deleting one memory item', async () => {
        mocks.getDocumentsForScope.mockResolvedValue([{ id: 'memory-1', text: 'Town prices' }]);
        render(<MemoryPanel />);

        const trigger = await screen.findByRole('button', { name: 'Delete memory item: Town prices' });
        fireEvent.click(trigger);
        expect(mocks.deleteDocument).not.toHaveBeenCalled();
        expect(screen.getByRole('alertdialog')).toHaveTextContent('Town prices');
        const cancel = screen.getByRole('button', { name: 'Cancel' });
        const confirm = screen.getByRole('button', { name: 'Delete memory' });
        expect(cancel).toHaveFocus();
        fireEvent.keyDown(cancel, { key: 'Tab', shiftKey: true });
        expect(confirm).toHaveFocus();
        fireEvent.keyDown(confirm, { key: 'Tab' });
        expect(cancel).toHaveFocus();
        fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
        expect(mocks.deleteDocument).not.toHaveBeenCalled();

        fireEvent.click(trigger);
        mocks.getDocumentsForScope.mockResolvedValue([]);
        fireEvent.click(screen.getByRole('button', { name: 'Delete memory' }));
        await waitFor(() => expect(mocks.deleteDocument).toHaveBeenCalledExactlyOnceWith('memory-1'));
        expect(mocks.schedulePersist).toHaveBeenCalledOnce();
    });

    it('cancels a pending report-memory clear with Escape', async () => {
        mocks.getDocumentsForScope.mockResolvedValue([{ id: 'memory-1', text: 'Town prices' }]);
        render(<MemoryPanel />);

        fireEvent.click(await screen.findByRole('button', { name: 'Clear Report Memory' }));
        expect(screen.getByRole('alertdialog')).toHaveTextContent('1 saved memory item');
        fireEvent.keyDown(screen.getByRole('button', { name: 'Cancel' }), { key: 'Escape' });
        expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
        expect(mocks.deleteDocument).not.toHaveBeenCalled();
        expect(state.setIsMemoryPanelOpen).not.toHaveBeenCalled();
    });

    it('keeps a failed report-memory clear visible for retry', async () => {
        mocks.getDocumentsForScope
            .mockResolvedValueOnce([
                { id: 'memory-1', text: 'Town prices' },
                { id: 'memory-2', text: 'Flat types' },
            ])
            .mockResolvedValueOnce([{ id: 'memory-1', text: 'Town prices' }]);
        mocks.deleteDocument.mockRejectedValueOnce(new Error('Worker unavailable'));
        render(<MemoryPanel />);

        fireEvent.click(await screen.findByRole('button', { name: 'Clear Report Memory' }));
        expect(screen.getByRole('alertdialog')).toHaveTextContent('2 saved memory items');
        fireEvent.click(screen.getByRole('button', { name: 'Clear report memory' }));

        expect(await screen.findByRole('alert')).toHaveTextContent('Some memory items could not be deleted');
        expect(mocks.deleteDocument).toHaveBeenCalledTimes(2);
        expect(screen.getByRole('alertdialog')).toHaveTextContent('1 saved memory item');

        mocks.getDocumentsForScope.mockResolvedValue([]);
        fireEvent.click(screen.getByRole('button', { name: 'Clear report memory' }));
        await waitFor(() => expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument());
        expect(mocks.deleteDocument).toHaveBeenCalledTimes(3);
    });
});
