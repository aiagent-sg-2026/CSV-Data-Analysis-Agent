import { useEffect, useRef } from 'react';

const FOCUSABLE_SELECTOR = [
    'button:not([disabled])',
    'a[href]',
    'input:not([disabled])',
    'select:not([disabled])',
    'textarea:not([disabled])',
    '[tabindex]:not([tabindex="-1"])',
].join(',');

const getFocusableElements = (dialog: HTMLElement) => Array.from(
    dialog.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR),
).filter(element =>
    !element.hidden
    && element.getAttribute('aria-hidden') !== 'true'
    && element.closest('[hidden]') === null,
);

type BackgroundState = {
    owners: number;
    wasInert: boolean;
    hadInertAttribute: boolean;
    previousAriaHidden: string | null;
};

// Dialogs can overlap; the last owner restores each sibling's original state.
const backgroundStates = new Map<HTMLElement, BackgroundState>();

const acquireBackground = (element: HTMLElement): void => {
    const existing = backgroundStates.get(element);
    if (existing) {
        existing.owners += 1;
        return;
    }

    backgroundStates.set(element, {
        owners: 1,
        wasInert: element.inert,
        hadInertAttribute: element.hasAttribute('inert'),
        previousAriaHidden: element.getAttribute('aria-hidden'),
    });
    element.inert = true;
    element.setAttribute('inert', '');
    element.setAttribute('aria-hidden', 'true');
};

const releaseBackground = (element: HTMLElement): void => {
    const state = backgroundStates.get(element);
    if (!state) return;
    state.owners -= 1;
    if (state.owners > 0) return;

    backgroundStates.delete(element);
    element.inert = state.wasInert;
    if (state.hadInertAttribute) element.setAttribute('inert', '');
    else element.removeAttribute('inert');
    if (state.previousAriaHidden === null) element.removeAttribute('aria-hidden');
    else element.setAttribute('aria-hidden', state.previousAriaHidden);
};

export const useDialogAccessibility = <T extends HTMLElement>(
    isOpen: boolean,
    onClose: () => void,
    options?: {
        restoreFocusSelector?: string;
    },
) => {
    const dialogRef = useRef<T>(null);
    const onCloseRef = useRef(onClose);
    onCloseRef.current = onClose;

    useEffect(() => {
        if (!isOpen || !dialogRef.current) return;

        const dialog = dialogRef.current;
        const overlay = dialog.classList.contains('fixed') ? dialog : dialog.parentElement;
        const applicationRoot = overlay?.parentElement;
        const previouslyFocused = document.activeElement instanceof HTMLElement
            ? document.activeElement
            : null;
        const inertedSiblings = applicationRoot
            ? Array.from(applicationRoot.children)
                .filter(element => element !== overlay)
                .map(element => {
                    const htmlElement = element as HTMLElement;
                    acquireBackground(htmlElement);
                    return htmlElement;
                })
            : [];

        const focusInitialElement = () => {
            const preferred = dialog.querySelector<HTMLElement>('[data-dialog-initial-focus]');
            (preferred ?? getFocusableElements(dialog)[0] ?? dialog).focus();
        };
        const frameId = requestAnimationFrame(focusInitialElement);

        const handleKeyDown = (event: KeyboardEvent) => {
            if (event.key === 'Escape') {
                event.preventDefault();
                onCloseRef.current();
                return;
            }
            if (event.key !== 'Tab') return;

            const focusable = getFocusableElements(dialog);
            if (focusable.length === 0) {
                event.preventDefault();
                dialog.focus();
                return;
            }
            const first = focusable[0];
            const last = focusable[focusable.length - 1];
            if (event.shiftKey && document.activeElement === first) {
                event.preventDefault();
                last.focus();
            } else if (!event.shiftKey && document.activeElement === last) {
                event.preventDefault();
                first.focus();
            }
        };
        document.addEventListener('keydown', handleKeyDown);

        return () => {
            cancelAnimationFrame(frameId);
            document.removeEventListener('keydown', handleKeyDown);
            inertedSiblings.forEach(releaseBackground);
            const preferredRestoreTarget = options?.restoreFocusSelector
                ? document.querySelector<HTMLElement>(options.restoreFocusSelector)
                : null;
            (preferredRestoreTarget ?? previouslyFocused)?.focus();
            if (!preferredRestoreTarget && options?.restoreFocusSelector) {
                requestAnimationFrame(() => {
                    document.querySelector<HTMLElement>(options.restoreFocusSelector!)?.focus();
                });
            }
        };
    }, [isOpen, options?.restoreFocusSelector]);

    return dialogRef;
};
