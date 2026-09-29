const BLOB_URL_REVOKE_DELAY_MS = 180_000;

export const reserveReportWindow = (): Window | null => {
    if (typeof window === 'undefined') return null;
    let openedWindow: Window | null = null;
    try {
        openedWindow = window.open('', '_blank');
        if (!openedWindow) return null;
        openedWindow.opener = null;
        return openedWindow;
    } catch {
        try { openedWindow?.close(); } catch { /* The browser denied window control. */ }
        return null;
    }
};

const openReportWindow = (
    html: string,
    mode: 'open' | 'print',
    reservedWindow?: Window,
): Window | null => {
    if (typeof window === 'undefined' || typeof Blob === 'undefined' || typeof URL === 'undefined') {
        reservedWindow?.close();
        return null;
    }

    // Reserve during the click when saved HTML must be loaded asynchronously.
    const openedWindow = reservedWindow ?? reserveReportWindow();
    if (!openedWindow) return null;

    let objectUrl: string | null = null;
    try {
        const blob = new Blob([html], { type: 'text/html;charset=utf-8' });
        objectUrl = URL.createObjectURL(blob);
        const targetUrl = mode === 'print' ? `${objectUrl}#print` : objectUrl;
        openedWindow.opener = null;
        openedWindow.location.replace(targetUrl);
        const urlToRevoke = objectUrl;
        window.setTimeout(() => {
            URL.revokeObjectURL(urlToRevoke);
        }, BLOB_URL_REVOKE_DELAY_MS);
        return openedWindow;
    } catch {
        openedWindow.close();
        if (objectUrl) URL.revokeObjectURL(objectUrl);
        return null;
    }
};

export const openReportArtifact = (html: string, reservedWindow?: Window): Window | null => openReportWindow(html, 'open', reservedWindow);

export const printReportArtifact = (html: string, reservedWindow?: Window): Window | null => openReportWindow(html, 'print', reservedWindow);
