import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AnalysisCardHeader } from '../components/analysis-card/AnalysisCardHeader';

const baseProps = {
    cardId: 'test-card',
    plan: {
        title: 'Spend by Project',
        description: 'Compare project spending.',
        chartType: 'bar',
    } as any,
    displayChartType: 'bar' as const,
    availableChartTypes: ['bar', 'line', 'pie'] as const,
    isExporting: false,
    trustStatus: 'verified' as const,
    isCardExpanded: false,
    language: 'English',
    onToggleExpand: vi.fn(),
    onToggleProvenance: vi.fn(),
    onVerdictClick: vi.fn(),
    onChartTypeChange: vi.fn(),
    onExport: vi.fn(),
    onDelete: vi.fn(),
};

afterEach(() => {
    cleanup();
});

describe('AnalysisCardHeader', () => {
    it('shows business-style primary controls instead of always-visible delete and chart icon buttons', () => {
        render(<AnalysisCardHeader {...baseProps} />);

        expect(screen.getByRole('button', { name: /chart type: bar/i })).toBeInTheDocument();
        expect(screen.getByRole('button', { name: /export/i })).toBeInTheDocument();
        expect(screen.getByRole('button', { name: /more actions/i })).toBeInTheDocument();
        expect(screen.queryByRole('button', { name: /^delete$/i })).not.toBeInTheDocument();
        expect(screen.queryByRole('button', { name: /line/i })).not.toBeInTheDocument();
        expect(screen.queryByRole('button', { name: /pie/i })).not.toBeInTheDocument();
    });

    it('requires confirmation and preserves the card when cancelled', async () => {
        const onDelete = vi.fn();
        render(<AnalysisCardHeader {...baseProps} onDelete={onDelete} />);

        const moreTrigger = screen.getByRole('button', { name: /more actions/i });
        fireEvent.click(moreTrigger);
        fireEvent.click(screen.getByRole('menuitem', { name: /delete card/i }));

        expect(screen.getByRole('dialog', { name: /delete this card/i })).toBeInTheDocument();
        expect(onDelete).not.toHaveBeenCalled();
        const keepCard = screen.getByRole('button', { name: /keep card/i });
        await waitFor(() => expect(keepCard).toHaveFocus());
        fireEvent.click(keepCard);

        expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
        expect(onDelete).not.toHaveBeenCalled();
        await waitFor(() => expect(moreTrigger).toHaveFocus());
    });

    it('deletes only after the dialog action is confirmed', () => {
        const onDelete = vi.fn();
        render(<AnalysisCardHeader {...baseProps} onDelete={onDelete} />);

        fireEvent.click(screen.getByRole('button', { name: /more actions/i }));
        fireEvent.click(screen.getByRole('menuitem', { name: /delete card/i }));
        fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: /delete card/i }));

        expect(onDelete).toHaveBeenCalledTimes(1);
    });

    it('opens a chart type dropdown instead of exposing all chart buttons at once', () => {
        const onChartTypeChange = vi.fn();
        render(<AnalysisCardHeader {...baseProps} onChartTypeChange={onChartTypeChange} />);

        fireEvent.click(screen.getByRole('button', { name: /chart type: bar/i }));
        fireEvent.click(screen.getByRole('menuitemradio', { name: /line/i }));

        expect(onChartTypeChange).toHaveBeenCalledWith('line');
    });

    it('does not offer chart controls or chart-only export for table-only evidence', () => {
        render(<AnalysisCardHeader
            {...baseProps}
            plan={{ ...baseProps.plan, artifactMetadata: { hideChartByDefault: true } }}
        />);

        expect(screen.queryByRole('button', { name: /chart type/i })).not.toBeInTheDocument();
        fireEvent.click(screen.getByRole('button', { name: /export chart or data/i }));
        expect(screen.queryByRole('menuitem', { name: /PNG — Chart only/i })).not.toBeInTheDocument();
        expect(screen.getByRole('menuitem', { name: /PNG — Full card/i })).toBeInTheDocument();
        expect(screen.getByRole('menuitem', { name: /CSV table data/i })).toBeInTheDocument();
    });

    it('supports keyboard opening and focus movement inside the chart type menu', async () => {
        render(<AnalysisCardHeader {...baseProps} />);

        const trigger = screen.getByRole('button', { name: /chart type: bar/i });
        trigger.focus();
        fireEvent.keyDown(trigger, { key: 'ArrowDown' });
        await new Promise(resolve => setTimeout(resolve, 0));

        const barItem = screen.getByRole('menuitemradio', { name: /bar/i });
        const chartMenu = screen.getAllByRole('menu', { hidden: true })[0];
        expect(barItem).toHaveFocus();

        fireEvent.keyDown(chartMenu, { key: 'ArrowDown' });
        const lineItem = screen.getByRole('menuitemradio', { name: /line/i });
        expect(lineItem).toHaveFocus();

        fireEvent.keyDown(lineItem, { key: 'Escape' });
        await new Promise(resolve => setTimeout(resolve, 0));
        expect(trigger).toHaveAttribute('aria-expanded', 'false');
    });

    it('renders business-facing title and description when the stored plan uses helper columns', () => {
        render(
            <AnalysisCardHeader
                {...baseProps}
                plan={{
                    title: 'Value by SeriesLabelL1',
                    description: 'Compare Value by SeriesLabelL1.',
                    chartType: 'bar',
                    groupByColumn: 'SeriesLabelL1',
                    valueColumn: 'Value',
                } as any}
            />,
        );

        expect(screen.getByText('Value by Series Label 1')).toBeInTheDocument();
        expect(screen.getByText('Compare Value by Series Label 1.')).toBeInTheDocument();
    });

    it('shows explicit stale, degraded, and unverified evidence states', () => {
        const { rerender } = render(<AnalysisCardHeader {...baseProps} trustStatus="stale" />);
        expect(screen.getByText('Stale evidence')).toBeInTheDocument();

        rerender(<AnalysisCardHeader {...baseProps} trustStatus="caveated" />);
        expect(screen.getByText('Needs review')).toBeInTheDocument();

        rerender(<AnalysisCardHeader {...baseProps} trustStatus="unverified" />);
        expect(screen.getByText('Unverified')).toBeInTheDocument();
    });

    it('removes closed menus from the accessibility tree', () => {
        render(<AnalysisCardHeader {...baseProps} />);

        expect(screen.queryByRole('menu')).not.toBeInTheDocument();
        expect(screen.queryByRole('menuitem')).not.toBeInTheDocument();
        expect(screen.queryByRole('menuitemradio')).not.toBeInTheDocument();
    });

    it('keeps exploration actions out of the simple results presentation', () => {
        render(<AnalysisCardHeader {...baseProps} showActions={false} />);

        expect(screen.getByText('Spend by Group')).toBeInTheDocument();
        expect(screen.getByText('Verified')).toBeInTheDocument();
        expect(screen.queryByRole('button', { name: /chart type/i })).not.toBeInTheDocument();
        expect(screen.queryByRole('button', { name: /export/i })).not.toBeInTheDocument();
        expect(screen.queryByRole('button', { name: /more actions/i })).not.toBeInTheDocument();
    });
});
