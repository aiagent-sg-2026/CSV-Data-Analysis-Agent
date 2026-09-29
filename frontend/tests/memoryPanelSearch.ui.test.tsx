// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryPanel } from '../components/modals/MemoryPanel';

const mocks = vi.hoisted(() => ({
    getDocumentsForScope: vi.fn(async () => [] as Array<{ id: string; text: string }>),
    ensureVectorMemoryReady: vi.fn(async () => undefined),
    search: vi.fn(async () => [] as Array<{ text: string; score: number }>),
    getStatus: vi.fn(() => 'ready' as const),
    getLastError: vi.fn(() => null),
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
});
