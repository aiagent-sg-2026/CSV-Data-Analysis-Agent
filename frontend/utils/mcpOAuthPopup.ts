/** Handle the host-only OAuth callback before the app restores sessions or providers. */
export const finishMcpOAuthPopup = (): boolean => {
    const params = new URLSearchParams(window.location.search), state = params.get('state');
    if (!window.opener || !state?.startsWith('csv-mcp-')) return false;
    const message = { kind: 'csv-mcp-oauth', code: params.get('code') ?? undefined, state,
        iss: params.get('iss') ?? undefined, error: params.get('error') ?? undefined };
    window.history.replaceState(null, '', window.location.pathname);
    window.opener.postMessage(message, window.location.origin); window.close(); return true;
};
