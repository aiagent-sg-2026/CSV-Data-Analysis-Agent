// Deterministic transactional adapter for Node host-path tests. Browser qualification uses real IDB.
export const repairReservationStorage = (values = new Map<string, unknown>()) => {
    let denied = false;
    const get = async (_store: string, key: string) => structuredClone(values.get(key));
    const db = {
        get,
        transaction() {
            if (denied) throw new Error('qualification_storage_denied');
            const staged = new Map<string, unknown>();
            let aborted = false;
            return { store: { get: (key: string) => get('settings', key), put: async (v: { key: string }) => { staged.set(v.key, structuredClone(v)); } },
                abort() { aborted = true; },
                get done() { if (aborted) return Promise.reject(new Error('aborted')); for (const [k, v] of staged) values.set(k, v); return Promise.resolve(); } };
        },
    };
    return { values, db, deny: () => { denied = true; } };
};
