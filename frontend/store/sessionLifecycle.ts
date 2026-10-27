import { createId } from '../utils/createId';

export const TAB_SESSION_STORAGE_KEY = 'csv_agent_tab_session_id';
// History loads rotate the app session too, but must not replenish repair accounting.
export const REPAIR_BUDGET_SESSION_STORAGE_KEY = 'csv_agent_repair_budget_session_id';
export const startDeliberateRepairBudgetSession = (sessionId: string) => {
    if (isSessionStorageAvailable()) window.sessionStorage.setItem(REPAIR_BUDGET_SESSION_STORAGE_KEY, sessionId);
};

const isSessionStorageAvailable = () =>
    typeof window !== 'undefined' && typeof window.sessionStorage !== 'undefined';

export const generateSessionId = () => createId('session');

export const readTabSessionId = (): string | null => {
    if (!isSessionStorageAvailable()) {
        return null;
    }
    return window.sessionStorage.getItem(TAB_SESSION_STORAGE_KEY);
};

export const writeTabSessionId = (sessionId: string) => {
    if (!isSessionStorageAvailable()) {
        return sessionId;
    }
    window.sessionStorage.setItem(TAB_SESSION_STORAGE_KEY, sessionId);
    return sessionId;
};

export const createAndStoreTabSessionId = () => writeTabSessionId(generateSessionId());
