import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { openReportArtifact, printReportArtifact, reserveReportWindow } from '../../services/reporting/reportArtifactViewer';

describe('reportArtifactViewer', () => {
    const originalCreateObjectURL = URL.createObjectURL;
    const originalRevokeObjectURL = URL.revokeObjectURL;
    const originalOpen = window.open;
    let reportWindow: Window;
    let navigation: ReturnType<typeof vi.fn>;

    beforeEach(() => {
        vi.restoreAllMocks();
        URL.createObjectURL = vi.fn(() => 'blob:report-artifact');
        URL.revokeObjectURL = vi.fn();
        navigation = vi.fn();
        reportWindow = { opener: window, location: { replace: navigation }, close: vi.fn() } as unknown as Window;
        window.open = vi.fn(() => reportWindow);
    });

    afterEach(() => {
        URL.createObjectURL = originalCreateObjectURL;
        URL.revokeObjectURL = originalRevokeObjectURL;
        window.open = originalOpen;
    });

    it('opens report html in a new tab', () => {
        navigation.mockImplementation(() => expect(reportWindow.opener).toBeNull());
        const result = openReportArtifact('<!DOCTYPE html><html><body>Report</body></html>');

        expect(result).toBe(reportWindow);
        expect(window.open).toHaveBeenCalledWith('', '_blank');
        expect(reportWindow.opener).toBeNull();
        expect(navigation).toHaveBeenCalledWith('blob:report-artifact');
    });

    it('opens report html in print mode with hash-based auto print', () => {
        const result = printReportArtifact('<!DOCTYPE html><html><body>Report</body></html>');

        expect(result).toBe(reportWindow);
        expect(reportWindow.opener).toBeNull();
        expect(navigation).toHaveBeenCalledWith('blob:report-artifact#print');
    });

    it('navigates a window reserved during the click without opening a second tab', () => {
        const reserved = reserveReportWindow();
        expect(reserved).toBe(reportWindow);
        expect(window.open).toHaveBeenCalledTimes(1);

        expect(openReportArtifact('<html>Report</html>', reserved!)).toBe(reportWindow);
        expect(window.open).toHaveBeenCalledTimes(1);
        expect(navigation).toHaveBeenCalledWith('blob:report-artifact');
    });

    it('reports a blocked popup without creating an unused blob URL', () => {
        window.open = vi.fn(() => null);

        expect(openReportArtifact('<html>Report</html>')).toBeNull();
        expect(URL.createObjectURL).not.toHaveBeenCalled();
    });

    it('closes the blank tab if report navigation fails', () => {
        navigation.mockImplementation(() => { throw new Error('blocked navigation'); });

        expect(openReportArtifact('<html>Report</html>')).toBeNull();
        expect(reportWindow.close).toHaveBeenCalledOnce();
        expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:report-artifact');
    });
});
