import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CredibilityBanner } from '../components/dashboard/CredibilityBanner';

describe('CredibilityBanner', () => {
    afterEach(() => cleanup());

    it('does not direct users to verified cards when none exist', () => {
        render(
            <CredibilityBanner
                overallVerdict="caveated"
                trustedCount={0}
                caveatedCount={3}
                weakCount={0}
                language="English"
            />,
        );

        expect(screen.getByText(
            '0 verified, 3 need review — review these cards and data warnings before using the findings.',
        )).toBeTruthy();
        expect(screen.queryByText(/start with verified cards/i)).toBeNull();
    });

    it('keeps the verified-first guidance when trusted cards exist', () => {
        render(
            <CredibilityBanner
                overallVerdict="caveated"
                trustedCount={2}
                caveatedCount={1}
                weakCount={0}
                language="English"
            />,
        );

        expect(screen.getByText(
            '2 verified, 1 need review — start with verified cards.',
        )).toBeTruthy();
    });

    it('does not claim unrestricted use when the run completed with data caveats', () => {
        render(
            <CredibilityBanner
                overallVerdict="trusted"
                trustedCount={5}
                caveatedCount={0}
                weakCount={0}
                hasRunCaveats
                language="English"
            />,
        );

        expect(screen.getByText('Results ready with limitations')).toBeTruthy();
        expect(screen.getByText(/data-quality limitations remain/i)).toBeTruthy();
        expect(screen.queryByText(/use these findings directly/i)).toBeNull();
    });

    it('offers a way to the cards under review when the current view hides them', () => {
        const onReviewAction = vi.fn();
        render(
            <CredibilityBanner
                overallVerdict="caveated"
                trustedCount={0}
                caveatedCount={2}
                weakCount={0}
                language="English"
                reviewActionLabel="Show the 2 cards to review"
                onReviewAction={onReviewAction}
            />,
        );

        fireEvent.click(screen.getByRole('button', { name: 'Show the 2 cards to review' }));
        expect(onReviewAction).toHaveBeenCalledTimes(1);
    });

    it('shows no review action unless the view asks for one', () => {
        render(
            <CredibilityBanner overallVerdict="caveated" trustedCount={0} caveatedCount={2} weakCount={0} language="English" />,
        );

        expect(screen.queryByRole('button')).toBeNull();
    });
});
