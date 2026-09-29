import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AgentMonitorModal } from '../components/modals/AgentMonitorModal';
import { AgentMemoryView } from '../components/agent-monitor/AgentMemoryView';
import { DatasetKnowledgeView } from '../components/agent-monitor/DatasetKnowledgeView';

const { useAppStoreMock } = vi.hoisted(() => ({
    useAppStoreMock: Object.assign(vi.fn(), { getState: vi.fn() }),
}));

vi.mock('../store/useAppStore', () => ({
    useAppStore: useAppStoreMock,
}));

vi.mock('../components/agent-activity/AgentActivityView', () => ({
    AgentActivityView: () => <div>Activity timeline</div>,
}));

const liveMemoryRun = {
    runId: 'run-live',
    datasetId: 'dataset-1',
    createdAt: new Date('2026-07-28T00:00:00.000Z'),
    origin: { label: 'Completed agent analysis run' },
    findings: {
        datasetFacts: {
            fileName: 'prepared.csv',
            rowCount: 2,
            columnCount: 1,
            dimensions: [],
            metrics: ['Amount'],
        },
        columnVerdicts: [],
        explorations: [],
        warnings: [],
        datasetKnowledge: {
            facts: {
                originalRowCount: 3,
                originalColumnCount: 1,
                cleanedRowCount: 2,
                cleanedColumnCount: 1,
                primaryDimensions: [],
                primaryMetrics: ['Amount'],
            },
            columns: [],
            dimensionMap: {
                project: [],
                account: [],
                allocation: [],
                keys: [],
                otherDimensions: [],
                metrics: ['Amount'],
            },
            highValueDimensions: [],
            suspiciousMetrics: [],
            groupByInsights: [],
            summary: 'Prepared dataset is ready.',
        },
    },
};

const createState = (liveRun: typeof liveMemoryRun | null = liveMemoryRun, hasCards = false) => ({
    isAgentModalOpen: true,
    setIsAgentModalOpen: vi.fn(),
    syncTelemetryToStore: vi.fn(),
    syncTelemetryEventsToStore: vi.fn(),
    agentEvents: [],
    agentToolLogs: [{
        id: 'tool-1',
        tool: 'data.query',
        timestamp: new Date('2026-07-28T00:00:00.000Z'),
        description: 'Previewed bounded rows.',
        detail: { attempt: 1, rows: 25 },
    }],
    aiTaskStatus: null,
    agentMemoryRun: null,
    agentMemoryHistory: [],
    selectedMemoryRunId: null,
    liveAgentMemoryRun: liveRun,
    selectAgentMemoryRun: vi.fn(),
    cardEnhancementSuggestions: [],
    analysisCards: hasCards ? [{ id: 'card-1' }] : [],
    isCardReviewInProgress: false,
    runCardEnhancementReview: vi.fn(),
    applyCardEnhancementSuggestion: vi.fn(),
    dismissCardEnhancementSuggestion: vi.fn(),
    sessionId: 'session-1',
    currentDatasetId: 'dataset-1',
});

describe('agent monitor progressive disclosure', () => {
    beforeEach(() => {
        const state = createState();
        useAppStoreMock.mockImplementation((selector: (value: typeof state) => unknown) => selector(state));
        useAppStoreMock.getState.mockReturnValue(state);
    });

    afterEach(() => {
        cleanup();
        vi.clearAllMocks();
    });

    it('keeps tool payloads collapsed until technical details are requested', () => {
        render(<AgentMonitorModal />);

        expect(screen.getByRole('option', { name: 'Latest finished analysis' })).toBeInTheDocument();

        fireEvent.click(screen.getByRole('button', { name: 'Tools' }));

        const summary = screen.getByText('Technical payload');
        const details = summary.closest('details');
        expect(details).not.toHaveAttribute('open');
        expect(screen.getByText('Previewed bounded rows.')).toBeInTheDocument();
    });

    it('does not present an empty session as an analysis in progress', () => {
        const state = createState(null);
        useAppStoreMock.mockImplementation((selector: (value: typeof state) => unknown) => selector(state));
        useAppStoreMock.getState.mockReturnValue(state);

        render(<AgentMonitorModal />);

        expect(screen.getByRole('option', { name: 'Current session (no finished run)' })).toBeInTheDocument();
        expect(screen.getByRole('combobox', { name: 'Memory Run' })).toHaveValue('live');
        expect(screen.queryByText(/in progress/i)).not.toBeInTheDocument();

        fireEvent.click(screen.getByRole('button', { name: 'Memory' }));
        expect(screen.getByText('Memory will appear after an analysis run finishes.')).toBeInTheDocument();
        fireEvent.click(screen.getByRole('button', { name: 'Dataset Knowledge' }));
        expect(screen.getByText('Dataset knowledge will appear after an analysis finishes.')).toBeInTheDocument();
    });

    it('explains why card review is unavailable before any cards exist', () => {
        render(<AgentMonitorModal />);
        fireEvent.click(screen.getByRole('button', { name: 'Tools' }));

        const reviewButton = screen.getByRole('button', { name: 'Review Cards' });
        expect(reviewButton).toBeDisabled();
        expect(screen.getByText('Upload a CSV and create analysis cards before requesting a review.')).toBeInTheDocument();
        fireEvent.click(reviewButton);
        expect(useAppStoreMock.getState().runCardEnhancementReview).not.toHaveBeenCalled();
    });

    it('enables card review when an analysis card exists', () => {
        const state = createState(liveMemoryRun, true);
        useAppStoreMock.mockImplementation((selector: (value: typeof state) => unknown) => selector(state));
        useAppStoreMock.getState.mockReturnValue(state);

        render(<AgentMonitorModal />);
        fireEvent.click(screen.getByRole('button', { name: 'Tools' }));

        const reviewButton = screen.getByRole('button', { name: 'Review Cards' });
        expect(reviewButton).toBeEnabled();
        fireEvent.click(reviewButton);
        expect(state.runCardEnhancementReview).toHaveBeenCalledOnce();
    });

    it('uses the latest finished live run when no historical run is selected', () => {
        const { rerender } = render(<AgentMemoryView />);

        expect(screen.getByText('Completed agent analysis run')).toBeInTheDocument();
        expect(screen.getByText('Rows:').parentElement).toHaveTextContent('Rows: 2');

        rerender(<DatasetKnowledgeView />);
        expect(screen.getByText('Rows (cleaned):').parentElement).toHaveTextContent('Rows (cleaned): 2');
        expect(screen.getByText('Prepared dataset is ready.')).toBeInTheDocument();
    });
});
