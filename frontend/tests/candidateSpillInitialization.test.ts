// @vitest-environment node
import { afterEach, expect, it, vi } from 'vitest';
import { openCandidateSpillDirectory } from '../services/data/opfsDatasetStorage';
import { createCandidateSpill } from '../services/data/candidateSpill';

afterEach(() => vi.unstubAllGlobals());
it.each(['fence', 'quota', 'prior', 'metadata-quota'] as const)('cleans only an owned generation on initialization %s failure', async fault => {
    const names = new Set(['accepted-data', ...(fault === 'prior' ? ['candidate-generation'] : [])]);
    let opened = 0, removed = 0, stale = false;
    const current = () => { if (stale) throw new Error('scope_revoked'); };
    const directory = {
        async getDirectoryHandle(name: string, options?: { create: boolean }) {
            if (!name.startsWith('candidate-')) return directory;
            if (!options?.create) { if (names.has(name)) return directory; throw new DOMException('absent', 'NotFoundError'); }
            names.add(name); opened++;
            if (fault === 'quota') throw new DOMException('full', 'QuotaExceededError');
            if (fault === 'fence') stale = true;
            return directory;
        },
        async getFileHandle() { return { createWritable: async () => ({
            write: async () => { if (fault === 'metadata-quota') throw new DOMException('full', 'QuotaExceededError'); },
            close: async () => {}, abort: async () => {},
        }) }; },
        async removeEntry(name: string) { removed++; names.delete(name); },
    };
    vi.stubGlobal('navigator', { storage: { getDirectory: async () => directory } });
    await expect(openCandidateSpillDirectory('session', 'generation', current)).rejects.toThrow();
    expect({ opened, removed }).toEqual({ opened: fault === 'prior' || fault === 'metadata-quota' ? 0 : 1, removed: fault === 'prior' || fault === 'metadata-quota' ? 0 : 1 });
    expect([...names]).toEqual(['accepted-data', ...(fault === 'prior' ? ['candidate-generation'] : [])]);
});
it('coalesces removal and permits retry after a transient cleanup error without reopening scratch', async () => {
    let removed = 0;
    const spill = await createCandidateSpill('s', 'identity', () => {}, async () => ({
        put: async () => {}, get: async () => '', remove: async () => { if (++removed === 1) throw new Error('transient'); },
    }));
    await expect(spill.dispose()).rejects.toThrow('transient');
    await Promise.all([spill.dispose(), spill.dispose()]); expect(removed).toBe(2);
});
