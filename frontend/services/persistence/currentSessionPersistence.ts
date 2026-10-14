import type { AppStore } from '../../store/useAppStore';
import type { StoreApi } from '../agent/types';
import { captureSessionScope, ownsSessionScope, type SessionScope } from '../session/sessionOwnership';
import {
    CURRENT_SESSION_KEY,
    saveReport,
} from '../storageService';
import {
    buildPersistedAppState,
    buildPersistedReportRecord,
    hasSavableSession,
} from './persistedAppState';

/**
 * Commits both the tab-owned report and the shared current-session alias.
 *
 * Callers that establish a crash-recovery anchor use this helper instead of
 * waiting for the normal autosave debounce.
 */
let writes: Promise<unknown> = Promise.resolve();
export const queueSessionWrite = <T>(write: () => Promise<T>): Promise<T> => {
    const next = writes.then(write, write);
    writes = next.catch(() => undefined);
    return next;
};
export const drainSessionPersistence = async (): Promise<void> => { await writes; };

export const persistCurrentAppSessionSnapshot = async (
    state: AppStore,
    options: { store?: StoreApi; scope?: SessionScope } = {},
): Promise<boolean> => {
    if (!hasSavableSession(state)) return false;
    const currentReport = buildPersistedReportRecord(state, {
        id: state.sessionId,
        filename: state.csvData?.fileName || state.datasetBundle?.source.fileName || 'Current Session',
        createdAt: state.sessionCreatedAt,
    });
    currentReport.appState = buildPersistedAppState(state);
    const scope = options.scope ?? (options.store ? captureSessionScope(options.store) : null);
    const valid = () => !options.store || (!scope || ownsSessionScope(options.store, scope)) && options.store.isActive?.() !== false;
    return queueSessionWrite(async () => {
        if (!valid()) return false;
        await saveReport(currentReport);
        if (!valid()) return false;
        await saveReport({ ...currentReport, id: CURRENT_SESSION_KEY });
        return valid();
    });
};
