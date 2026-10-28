import type { StorageDatabase } from '../../services/storageService';
import type { AcceptedSpillStorage } from '../../services/data/acceptedSpill';

/** Transaction/failure model only. Native IndexedDB/OPFS are exercised in browser qualification. */
export const dualCommitStorage = () => {
    let records = new Map<string, any>(), fault = '';
    const files = new Map<string, { text: string; manifest: string }>();
    const key = (name: string, id: string) => name + '::' + id;
    const db = { get: async (name: string, id: string) => { if (fault === 'unknown' && records.has(key(name, id))) throw new Error('unreadable_ack'); return structuredClone(records.get(key(name, id))); },
        transaction: () => {
            if (fault === 'persist') throw new Error('injected_persistence');
            const next = new Map(records); let aborted = false;
            const done = new Promise<void>((resolve, reject) => setTimeout(() => { if (aborted) reject(new Error('abort')); else { records = next; if (fault === 'unknown') reject(new Error('lost_ack')); else resolve(); } }, 0));
            return { done, abort() { aborted = true; }, objectStore: (name: string) => ({
                get: async (id: string) => structuredClone(next.get(key(name, id))),
                put: async (v: any) => { next.set(key(name, v.recordId ?? v.id), structuredClone(v)); },
                add: async (v: any) => { if (next.has(key(name, v.recordId))) throw new Error('constraint'); next.set(key(name, v.recordId), structuredClone(v)); },
                delete: async (id: string) => { next.delete(key(name, id)); },
                index: () => ({ get: async (id: string) => [...next.values()].find(v => v.approvalKey === id) }),
            }) };
        } } as unknown as StorageDatabase;
    const storage: AcceptedSpillStorage = async (generation, create, current) => {
        current();
        if (create) { if (files.has(generation)) throw new Error('exists'); files.set(generation, { text: '', manifest: '' }); }
        const file = files.get(generation); if (!file) throw new Error('missing');
        return {
            async writeCsv(parts, fence) { for await (const p of parts) { fence(); if (fault === 'quota') throw new DOMException('quota', 'QuotaExceededError'); file.text += p; } },
            async seal(text) { file.manifest = text; }, async manifest() { return file.manifest; },
            async file() { return new File([file.text], 'material.json'); }, async remove() { files.delete(generation); },
        };
    };
    return { db, storage, files, setFault(v: string) { fault = v; } };
};
