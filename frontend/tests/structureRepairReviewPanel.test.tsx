import React from 'react';
import { File as NodeFile } from 'node:buffer';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ReportBoundaryConfirmModal } from '../components/modals/ReportBoundaryConfirmModal';
import { StructureRepairEntry } from '../components/analysis-panel/StructureRepairEntry';
import { useAppStore } from '../store/useAppStore';
import { captureCsvSource } from '../services/data/immutableCsvSource';
import { parseCsvTextWithDetection } from '../services/data/csvDialectDetector';
import { buildReportIntakeIr } from '../services/data/reportCsvIntake';
import { beginSessionTransition } from '../services/session/sessionOwnership';

const original = useAppStore.getState();
const setup = async () => {
    useAppStore.setState({ ...original, sessionId: crypto.randomUUID(), structureRepairReview: null, isBusy: false });
    const text = 'Entity,N,S,N,S\r\nCount,Rate,Count,Rate\r\na,0,,-3,0.5,x,y\r\nb,2,N/A,4,0,x,y';
    const source = await captureCsvSource(useAppStore, new NodeFile([text], 'synthetic.csv') as unknown as File);
    const parsed = parseCsvTextWithDetection(text);
    const intake = buildReportIntakeIr('synthetic.csv', parsed.rawRows, parsed.detection);
    const refresh = vi.fn();
    const data = { fileName: 'synthetic.csv', data: [{ unchanged: 'accepted' }] };
    useAppStore.setState({ rawIntakeIr: intake, csvData: data, canonicalCsvData: null,
        datasetBundle: { source: { inspection: source } } as never,
        reportStructureResolution: { ...intake.provisionalTable!, headerLayerRowIndexes: [0, 1], headerRowIndex: 0,
            requiresHumanReview: true, blockingReasons: ['header_shape_drift'] } as never,
        pipelineOutcome: { status: 'needs_structure_review', reasonCode: 'header_shape_drift', canAutoAnalyze: false } as never,
        isReportBoundaryConfirmModalOpen: true, refreshDuckDbSession: refresh,
        settings: { ...original.settings, language: 'English' }, columnProfiles: [], userColumnAnnotations: {},
    });
    return { refresh, data };
};

describe('real semantic review UI and host actions', () => {
    afterEach(() => { cleanup(); beginSessionTransition(useAppStore); useAppStore.setState(original); });
    it.each(['A', 'B'])('visibly confirms %s then resumes only a draft with the legacy approval disabled', async label => {
        const { refresh, data } = await setup();
        render(<ReportBoundaryConfirmModal />);
        const choose = await screen.findByRole('button', { name: `Choose ${label} — confirm meaning` });
        expect(screen.getByRole('button', { name: 'Confirm & Start Analysis' })).toBeDisabled();
        fireEvent.click(choose);
        fireEvent.click(await screen.findByRole('button', { name: 'Resume read-only mapping draft' }));
        expect(await screen.findByRole('heading', { name: 'Draft / Uncommitted — not validated' })).toBeInTheDocument();
        expect(useAppStore.getState().structureRepairReview?.status).toBe('draft_uncommitted');
        expect(useAppStore.getState().csvData).toBe(data);
        expect(useAppStore.getState().datasetBundle?.acceptedCommit).toBeUndefined();
        expect(refresh).not.toHaveBeenCalled();
    });
    it('rejects Choose A when only its public digest is swapped with legitimate B', async () => {
        const { refresh, data } = await setup();
        render(<ReportBoundaryConfirmModal />);
        await screen.findByRole('button', { name: 'Choose A — confirm meaning' });
        const review = structuredClone(useAppStore.getState().structureRepairReview!);
        const candidateA = review.choices[0].candidate;
        review.choices[0].candidateDigest = review.choices[1].candidateDigest;
        act(() => useAppStore.setState({ structureRepairReview: review }));
        expect(useAppStore.getState().structureRepairReview?.choices[0].candidate).toEqual(candidateA);
        fireEvent.click(screen.getByRole('button', { name: 'Choose A — confirm meaning' }));
        expect(await screen.findByRole('alert')).toHaveTextContent('No dataset was committed');
        expect(useAppStore.getState().structureRepairReview?.status).not.toBe('confirmed');
        expect(screen.queryByRole('button', { name: 'Resume read-only mapping draft' })).toBeNull();
        expect(useAppStore.getState().csvData).toBe(data);
        expect(refresh).not.toHaveBeenCalled();
    });
    it('exposes local semantic review even without a provisional report boundary or cloud consent', async () => {
        await setup();
        useAppStore.setState({ reportStructureResolution: null, isReportBoundaryConfirmModalOpen: false, initialAnalysisFailureKind: 'cloud_consent_declined' });
        render(<><StructureRepairEntry /><ReportBoundaryConfirmModal /></>);
        fireEvent.click(screen.getByRole('button', { name: 'Review structural interpretations' }));
        expect(await screen.findByRole('button', { name: 'Choose A — confirm meaning' })).toBeInTheDocument();
        expect(screen.getByRole('dialog', { name: 'Review structural interpretations' })).toBeInTheDocument();
    });
    it('does not let a late closed-panel preparation cancel the reopened review', async () => {
        const { refresh, data } = await setup();
        const realPrepare = useAppStore.getState().prepareStructureRepairReview;
        let releaseFirst!: () => void;
        const held = new Promise<void>(resolve => { releaseFirst = resolve; });
        let calls = 0;
        useAppStore.setState({ prepareStructureRepairReview: async () => {
            const call = ++calls;
            const review = await realPrepare();
            if (call === 1) await held;
            return review;
        } });
        const first = render(<ReportBoundaryConfirmModal />);
        await screen.findByRole('button', { name: 'Choose A — confirm meaning' });
        first.unmount();
        render(<ReportBoundaryConfirmModal />);
        await waitFor(() => expect(calls).toBe(2));
        await act(async () => { releaseFirst(); await held; });
        expect(screen.getByRole('button', { name: 'Choose A — confirm meaning' })).toBeEnabled();
        expect(useAppStore.getState().structureRepairReview?.status).toBe('awaiting_semantic_confirmation');
        expect(useAppStore.getState().csvData).toBe(data);
        expect(refresh).not.toHaveBeenCalled();
    });
    it('still cancels a late preparation when the closed panel is not reopened', async () => {
        const { refresh, data } = await setup();
        const realPrepare = useAppStore.getState().prepareStructureRepairReview;
        let release!: () => void;
        const held = new Promise<void>(resolve => { release = resolve; });
        useAppStore.setState({ prepareStructureRepairReview: async () => {
            const review = await realPrepare();
            await held;
            return review;
        } });
        const view = render(<ReportBoundaryConfirmModal />);
        await screen.findByRole('button', { name: 'Choose A — confirm meaning' });
        view.unmount();
        await act(async () => { release(); await held; });
        expect(useAppStore.getState().structureRepairReview?.status).toBe('cancelled');
        expect(useAppStore.getState().csvData).toBe(data);
        expect(refresh).not.toHaveBeenCalled();
    });
    it('keeps Neither blocked and cancels authority when the modal is closed', async () => {
        await setup(); render(<ReportBoundaryConfirmModal />);
        fireEvent.click(await screen.findByRole('button', { name: 'Neither / Correct mapping' }));
        await waitFor(() => expect(useAppStore.getState().structureRepairReview?.status).toBe('neither'));
        expect(screen.queryByRole('button', { name: 'Resume read-only mapping draft' })).toBeNull();
        expect(screen.getByText(/Neither interpretation was confirmed/)).toBeInTheDocument();
        fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
        await waitFor(() => expect(useAppStore.getState().structureRepairReview?.status).toBe('cancelled'));
    });
});
