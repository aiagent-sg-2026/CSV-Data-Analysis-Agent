import React, { useState } from 'react';
import { createPortal, flushSync } from 'react-dom';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
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

const NestedDialogHarness: React.FC<{ reverseListeners?: boolean }> = ({ reverseListeners = false }) => {
    const [outer, setOuter] = useState(true), [inner, setInner] = useState(false);
    const [outerKeyboard, setOuterKeyboard] = useState(!reverseListeners);
    const parent = useDialogAccessibility<HTMLDivElement>(outer && outerKeyboard, () => setOuter(false));
    const child = useDialogAccessibility<HTMLDivElement>(inner, () => flushSync(() => setInner(false)));
    return <>{outer && <div className="fixed"><div ref={parent} role="dialog" aria-label="Outer dialog">
        <button onClick={() => setInner(true)}>Open inner dialog</button>
    </div></div>}{inner && createPortal(<div className="fixed"><div ref={child} role="dialog" aria-label="Inner dialog">
        <button data-dialog-initial-focus>Inner action</button>
        {reverseListeners && <button onClick={() => setOuterKeyboard(true)}>Enable outer keyboard</button>}
    </div></div>, document.body)}</>;
};

afterEach(cleanup);
describe('useDialogAccessibility', () => {
    it.each([false, true])('leaves the outer dialog open when Escape closes its portaled child (reverse listeners: %s)', async reverseListeners => {
        render(<NestedDialogHarness reverseListeners={reverseListeners} />);
        const trigger = screen.getByRole('button', {name:'Open inner dialog'}); trigger.focus(); fireEvent.click(trigger);
        await waitFor(() => expect(screen.getByRole('button', {name:'Inner action'})).toHaveFocus());
        if (reverseListeners) {
            fireEvent.click(screen.getByRole('button', {name:'Enable outer keyboard'}));
            await waitFor(() => expect(trigger).toHaveFocus());
        }
        fireEvent.keyDown(document, {key:'Escape'});
        expect(screen.queryByRole('dialog', {name:'Inner dialog'})).not.toBeInTheDocument();
        expect(screen.getByRole('dialog', {name:'Outer dialog'})).toBeInTheDocument();
        expect(trigger).toHaveFocus();
    });
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
});
