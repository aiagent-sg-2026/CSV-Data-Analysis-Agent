// @vitest-environment jsdom
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { CandidateDraft } from '../components/task/CandidateDraft';
import { readTaskCandidateDraft } from '../services/agent/runtime/pi/piTaskInspection';
vi.mock('../services/agent/runtime/pi/piTaskInspection', () => ({ readTaskCandidateDraft: vi.fn() }));
afterEach(() => { cleanup(); vi.resetAllMocks(); });
describe('validated draft UI', () => {
    it('uses actual returned rows for the next local cursor and discloses uncommitted state', async () => {
        vi.mocked(readTaskCandidateDraft).mockResolvedValueOnce({ offset: 0, rows: [{ label: 'synthetic' }], totalRows: 5, truncated: true } as never)
            .mockResolvedValueOnce({ offset: 1, rows: [{ label: 'next' }], totalRows: 5, truncated: true } as never);
        render(<CandidateDraft taskId="task" candidateId="candidate" table="records" digest="receipt" />);
        expect(screen.getByText(/Validated Draft \/ Uncommitted/)).toBeTruthy();
        fireEvent.click(screen.getByRole('button', { name: 'Read draft from start' }));
        await screen.findByText(/Rows 1–1 \/ 5/);
        fireEvent.click(screen.getByRole('button', { name: 'Next draft rows' }));
        await screen.findByText(/Rows 2–2 \/ 5/);
        expect(vi.mocked(readTaskCandidateDraft).mock.calls[1].slice(1)).toEqual(['task', 'candidate', 'records', 'receipt', 1]);
    });
    it('replaces old page with visible unavailable-storage errors', async () => {
        vi.mocked(readTaskCandidateDraft).mockResolvedValueOnce({ offset: 0, rows: [{ label: 'synthetic' }], totalRows: 5, truncated: true } as never)
            .mockRejectedValueOnce(new Error('spill_storage_unavailable'));
        render(<CandidateDraft taskId="task" candidateId="candidate" table="records" digest="receipt" />);
        fireEvent.click(screen.getByRole('button', { name: 'Read draft from start' })); await screen.findByText(/Rows 1–1/);
        fireEvent.click(screen.getByRole('button', { name: 'Next draft rows' }));
        await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('spill_storage_unavailable'));
        expect(screen.queryByLabelText('Draft rows')).toBeNull();
    });
});
