import { afterEach, describe, expect, it } from 'vitest';
import { createUISlice } from '../store/slices/uiSlice';

const originalInnerWidth = window.innerWidth;

const createState = () => {
    let state: ReturnType<typeof createUISlice>;
    const set = (update: Partial<typeof state>) => {
        Object.assign(state, update);
    };
    state = createUISlice(set as never, (() => state) as never, {} as never);
    return state;
};

afterEach(() => {
    window.sessionStorage.removeItem('csv_agent_results_view');
    Object.defineProperty(window, 'innerWidth', {
        configurable: true,
        value: originalInnerWidth,
    });
});

describe('UI slice responsive defaults', () => {
    it('starts with the Assistant drawer closed on mobile', () => {
        Object.defineProperty(window, 'innerWidth', {
            configurable: true,
            value: 390,
        });

        expect(createState().isAsideVisible).toBe(false);
    });

    it('starts with the Assistant sidebar open on desktop', () => {
        Object.defineProperty(window, 'innerWidth', {
            configurable: true,
            value: 1280,
        });

        expect(createState().isAsideVisible).toBe(true);
    });

    it.each([[767, false], [768, true]])('uses the existing mobile breakpoint at %i pixels', (width, expected) => {
        Object.defineProperty(window, 'innerWidth', { configurable: true, value: width });
        expect(createState().isAsideVisible).toBe(expected);
    });

    it('preserves manual hide and show without resetting the resize width', () => {
        Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1280 });
        const state = createState();
        expect(state.isAsideVisible).toBe(true);
        const width = state.asideWidth;
        state.setIsAsideVisible(false);
        expect(state.isAsideVisible).toBe(false);
        expect(state.asideWidth).toBe(width);
        state.setIsAsideVisible(true);
        expect(state.isAsideVisible).toBe(true);
        expect(state.asideWidth).toBe(width);
    });

    it.each([[768, 100, 320], [768, 600, 320], [1365, 865, 500], [1365, 0, 765]])(
        'keeps readable sidebar bounds when dragging at viewport %i and x=%i', (width, clientX, expected) => {
            Object.defineProperty(window, 'innerWidth', { configurable: true, value: width });
            const state = createState();
            state.handleAsideMouseDown({ preventDefault() {} } as never);
            try {
                document.dispatchEvent(new MouseEvent('mousemove', { clientX }));
                expect(state.asideWidth).toBe(expected);
                expect(state.asideWidth).toBeGreaterThanOrEqual(320);
                // The constrained desktop already starts at this readable width.
                expect(width - state.asideWidth).toBeGreaterThanOrEqual(width === 768 ? 448 : 600);
            } finally { document.dispatchEvent(new MouseEvent('mouseup')); }
            expect(state.isResizing).toBe(false);
        }
    );

    it('persists the results disclosure preference for the current session', () => {
        const state = createState();
        expect(state.resultsViewMode).toBe('simple');

        state.setResultsViewMode('explore');

        expect(window.sessionStorage.getItem('csv_agent_results_view')).toBe('explore');
        expect(createState().resultsViewMode).toBe('explore');
    });
});
