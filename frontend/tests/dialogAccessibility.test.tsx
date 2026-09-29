import React, { useState } from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { useDialogAccessibility } from '../hooks/useDialogAccessibility';

const DialogHarness: React.FC = () => {
    const [isOpen, setIsOpen] = useState(false);
    const dialogRef = useDialogAccessibility<HTMLDivElement>(isOpen, () => setIsOpen(false));
    return (
        <div>
            <main data-testid="dialog-background">
                <button type="button" onClick={() => setIsOpen(true)}>Open dialog</button>
            </main>
            {isOpen ? (
                <div className="fixed">
                    <div
                        ref={dialogRef}
                        role="dialog"
                        aria-modal="true"
                        aria-labelledby="dialog-title"
                        tabIndex={-1}
                    >
                        <h2 id="dialog-title">Accessible dialog</h2>
                        <button type="button" data-dialog-initial-focus>First action</button>
                        <button type="button">Last action</button>
                    </div>
                </div>
            ) : null}
        </div>
    );
};

const RemountingTriggerHarness: React.FC = () => {
    const [isOpen, setIsOpen] = useState(false);
    const dialogRef = useDialogAccessibility<HTMLDivElement>(
        isOpen,
        () => setIsOpen(false),
        { restoreFocusSelector: '[data-remounting-trigger="true"]' },
    );
    return (
        <div>
            {!isOpen ? (
                <button
                    type="button"
                    data-remounting-trigger="true"
                    onClick={() => setIsOpen(true)}
                >
                    Open remounting dialog
                </button>
            ) : null}
            {isOpen ? (
                <div className="fixed">
                    <div ref={dialogRef} role="dialog" aria-modal="true" tabIndex={-1}>
                        <button type="button" data-dialog-initial-focus>Close target</button>
                    </div>
                </div>
            ) : null}
        </div>
    );
};

const OverlappingDialogsHarness: React.FC = () => {
    const [firstOpen, setFirstOpen] = useState(false);
    const [secondOpen, setSecondOpen] = useState(false);
    const firstRef = useDialogAccessibility<HTMLDivElement>(firstOpen, () => setFirstOpen(false));
    const secondRef = useDialogAccessibility<HTMLDivElement>(secondOpen, () => setSecondOpen(false));

    return (
        <div>
            <main data-testid="shared-background">
                <button type="button" data-testid="open-first" onClick={() => setFirstOpen(true)}>Open first</button>
                <button type="button" data-testid="open-second" onClick={() => setSecondOpen(true)}>Open second</button>
            </main>
            {firstOpen && (
                <div className="fixed">
                    <div ref={firstRef} role="dialog" aria-modal="true" aria-label="First dialog" tabIndex={-1}>
                        <button type="button" data-testid="close-first" onClick={() => setFirstOpen(false)}>Close first</button>
                    </div>
                </div>
            )}
            {secondOpen && (
                <div className="fixed">
                    <div ref={secondRef} role="dialog" aria-modal="true" aria-label="Second dialog" tabIndex={-1}>
                        <button type="button" data-testid="close-second" onClick={() => setSecondOpen(false)}>Close second</button>
                    </div>
                </div>
            )}
        </div>
    );
};

describe('useDialogAccessibility', () => {
    it('moves and traps focus, closes on Escape, inerts background, and restores focus', async () => {
        render(<DialogHarness />);
        const trigger = screen.getByRole('button', { name: 'Open dialog' });
        trigger.focus();
        fireEvent.click(trigger);

        const background = screen.getByTestId('dialog-background');
        const first = screen.getByRole('button', { name: 'First action' });
        const last = screen.getByRole('button', { name: 'Last action' });
        await waitFor(() => expect(first).toHaveFocus());
        expect(background).toHaveAttribute('inert');
        expect(background).toHaveAttribute('aria-hidden', 'true');

        last.focus();
        fireEvent.keyDown(document, { key: 'Tab' });
        expect(first).toHaveFocus();
        fireEvent.keyDown(document, { key: 'Tab', shiftKey: true });
        expect(last).toHaveFocus();

        fireEvent.keyDown(document, { key: 'Escape' });
        expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
        expect(trigger).toHaveFocus();
        expect(background).not.toHaveAttribute('inert');
    });

    it('restores focus to a trigger that remounts after the dialog closes', async () => {
        render(<RemountingTriggerHarness />);
        fireEvent.click(screen.getByRole('button', { name: 'Open remounting dialog' }));
        await waitFor(() => expect(screen.getByRole('button', { name: 'Close target' })).toHaveFocus());

        fireEvent.keyDown(document, { key: 'Escape' });

        await waitFor(() => expect(screen.getByRole('button', { name: 'Open remounting dialog' })).toHaveFocus());
    });

    it('restores the background when overlapping dialogs close out of order', () => {
        render(<OverlappingDialogsHarness />);
        const background = screen.getByTestId('shared-background');

        fireEvent.click(screen.getByTestId('open-first'));
        fireEvent.click(screen.getByTestId('open-second'));
        expect(background).toHaveAttribute('inert');

        fireEvent.click(screen.getByTestId('close-first'));
        expect(background).toHaveAttribute('inert');

        fireEvent.click(screen.getByTestId('close-second'));
        expect(background).not.toHaveAttribute('inert');
        expect(background).not.toHaveAttribute('aria-hidden');
    });
});
