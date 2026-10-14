import React from 'react';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ClarificationCard } from '../components/chat/ClarificationCard';

const { state } = vi.hoisted(() => ({ state: {
    sessionId: 'restored-session', isBusy: false, activeTurn: null,
    settings: { language: 'English' }, handleClarificationResponse: vi.fn(),
    pendingClarification: {
        question: 'Approve the exact candidate?', interactionKind: 'approval', allowFreeText: false,
        options: [{ label: 'Approve', value: 'approve' }, { label: 'Deny', value: 'deny' }],
        resumeContext: { piCandidateApproval: { reviewId: 'saved-review', reviewDigest: 'saved-digest' },
            piTaskContinuation: { taskId: 'saved-task', revision: 1, scopeDigest: 'saved-scope' } },
    },
} }));
vi.mock('../store/useAppStore', () => ({ useAppStore: Object.assign(
    (select: (s: typeof state) => unknown) => select(state), { getState: () => state },
) }));
afterEach(cleanup);
describe('historical candidate review', () => {
    it('never offers executable approval from a restored locator with matching question text', () => {
        render(<ClarificationCard msg={{ id: 'saved-message', sender: 'ai', type: 'ai_clarification',
            timestamp: new Date(), text: state.pendingClarification.question,
            clarificationRequest: state.pendingClarification as never }} />);
        const approve = screen.queryByRole('button', { name: 'Approve' });
        expect(approve === null || (approve as HTMLButtonElement).disabled).toBe(true);
        expect(screen.getByText(/historical|unavailable/i)).toBeInTheDocument();
    });
});
