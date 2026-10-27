// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';
import { stageDatasetFileInOpfs } from '../services/data/opfsDatasetStorage';

afterEach(() => vi.unstubAllGlobals());
describe('OPFS upload staging ownership', () => {
    it('aborts a stale owned writer and cannot overwrite a newer same-name upload', async () => {
        const committed = new Map<string, unknown>();
        let release!: () => void, reached = false, held = false, oldCurrent = true;
        const abort = vi.fn().mockResolvedValue(undefined);
        const deferred = new Promise<void>(resolve => { release = resolve; });
        const directory: any = {
            getDirectoryHandle: async () => directory,
            getFileHandle: async (name: string) => ({ createWritable: async () => {
                const isOld = !held && name !== '.session.json';
                if (isOld) { held = true; reached = true; await deferred; }
                let content: unknown;
                return { write: async (value: unknown) => { content = value; }, close: async () => { committed.set(name, content); }, abort };
            } }),
        };
        vi.stubGlobal('navigator', { storage: { getDirectory: async () => directory } });
        const old = stageDatasetFileInOpfs('same-session', new File(['old'], 'same.csv'), {
            stagingId: 'old-upload', assertCurrent: () => { if (!oldCurrent) throw new Error('source_replaced'); },
        });
        void old.catch(() => {});
        for (let i = 0; i < 100 && !reached; i += 1) await new Promise(resolve => setTimeout(resolve, 1));
        expect(reached).toBe(true);
        oldCurrent = false;
        const newerFile = new File(['new'], 'same.csv');
        const newerPath = await stageDatasetFileInOpfs('same-session', newerFile, { stagingId: 'new-upload', assertCurrent: () => {} });
        release();
        await expect(old).rejects.toThrow('source_replaced');
        expect(abort).toHaveBeenCalledOnce();
        expect(newerPath).toBe('csv-analysis-agent-temp/same-session/new-upload-same.csv');
        expect(committed.get('new-upload-same.csv')).toBe(newerFile);
        expect(committed.has('old-upload-same.csv')).toBe(false);
    });
});
