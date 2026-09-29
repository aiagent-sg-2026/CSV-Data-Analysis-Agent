const BLOB_URL_REVOKE_DELAY_MS = 180_000;

const openReportWindow = (
    html: string,
    mode: 'open' | 'print',
): Window | null => {
    if (typeof window === 'undefined' || typeof Blob === 'undefined' || typeof URL === 'undefined') {
        return null;
    }

    const blob = new Blob([html], { type: 'text/html;charset=utf-8' });
    const objectUrl = URL.createObjectURL(blob);
    const targetUrl = mode === 'print' ? `${objectUrl}#print` : objectUrl;
    // noopener makes window.open return null even when the tab opens, so isolate
    // the blank tab before navigating it to the generated report.
    const openedWindow = window.open('', '_blank');
    if (!openedWindow) {
        URL.revokeObjectURL(objectUrl);
        return null;
    }

    try {
        openedWindow.opener = null;
        openedWindow.location.replace(targetUrl);
    } catch {
        openedWindow.close();
        URL.revokeObjectURL(objectUrl);
        return null;
    }

    window.setTimeout(() => {
        URL.revokeObjectURL(objectUrl);
    }, BLOB_URL_REVOKE_DELAY_MS);

    return openedWindow;
};

export const openReportArtifact = (html: string): Window | null => openReportWindow(html, 'open');

export const printReportArtifact = (html: string): Window | null => openReportWindow(html, 'print');
