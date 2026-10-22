import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
    DEMO_DATASET_CATALOG_URL,
    __resetDemoDatasetCatalogCacheForTests,
    fetchDemoDatasetCatalog,
    getBuiltInDemoDatasets,
    loadDemoDatasetCatalog,
    parseDemoDatasetCatalog,
    resolveDemoText,
} from '../services/data/demoDatasetCatalog';

const validEntry = (overrides: Record<string, unknown> = {}) => ({
    id: 'sg-cpi',
    file: 'singapore-cpi.csv',
    title: { English: 'Consumer prices', Mandarin: '消费者物价', Malay: 'Harga pengguna', Japanese: '消費者物価' },
    description: { English: 'Monthly CPI by category.', Mandarin: '按类别的月度 CPI。' },
    theme: 'business',
    rows: 1200,
    columns: 6,
    sizeBytes: 54000,
    speed: 'fast',
    suggestedQuestion: { English: 'Which category rose fastest?' },
    source: {
        publisher: 'Singapore Department of Statistics',
        datasetIds: ['d_123', '', 7],
        url: 'https://data.gov.sg/datasets/d_123/view',
        licence: 'Singapore Open Data Licence',
    },
    ...overrides,
});

const jsonResponse = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

describe('demo dataset catalog parser', () => {
    it('accepts a valid catalog and derives a relative demo-data URL', () => {
        const datasets = parseDemoDatasetCatalog({ version: 1, datasets: [validEntry()] });

        expect(datasets).toHaveLength(1);
        const [dataset] = datasets!;
        expect(dataset.url).toBe('demo-data/singapore-cpi.csv');
        expect(dataset.file).toBe('singapore-cpi.csv');
        expect(dataset.theme).toBe('business');
        expect(dataset.sizeBytes).toBe(54000);
        expect(dataset.source.datasetIds).toEqual(['d_123']);
        expect(dataset.source.licence).toBe('Singapore Open Data Licence');
        expect(dataset.suggestedQuestion).toEqual({ English: 'Which category rose fastest?' });
    });

    it('ignores malformed entries and keeps the valid ones in order', () => {
        const datasets = parseDemoDatasetCatalog({
            version: 1,
            datasets: [
                validEntry({ id: 'first' }),
                null,
                'not-an-object',
                validEntry({ id: 'no-english', title: { Mandarin: '只有中文' } }),
                validEntry({ id: 'traversal', file: '../secret.csv' }),
                validEntry({ id: 'nested', file: 'sub/dir.csv' }),
                validEntry({ id: 'absolute', file: 'https://evil.example/x.csv' }),
                validEntry({ id: 'not-csv', file: 'data.json' }),
                validEntry({ id: 'bad-rows', rows: -1 }),
                validEntry({ id: 'float-cols', columns: 2.5 }),
                validEntry({ id: 'bad-speed', speed: 'medium' }),
                validEntry({ id: 'js-link', source: { publisher: 'X', url: 'javascript:alert(1)' } }),
                validEntry({ id: 'http-link', source: { publisher: 'X', url: 'http://data.gov.sg/' } }),
                validEntry({ id: 'no-publisher', source: { url: 'https://data.gov.sg/' } }),
                validEntry({ id: 'first', file: 'duplicate-id.csv' }),
                validEntry({ id: 'second', file: 'second.csv', theme: 'space', sizeBytes: 'big', suggestedQuestion: 5 }),
            ],
        });

        expect(datasets!.map(dataset => dataset.id)).toEqual(['first', 'second']);
        const second = datasets![1];
        expect(second.theme).toBeNull();
        expect(second.sizeBytes).toBeNull();
        expect(second.suggestedQuestion).toBeNull();
    });

    it('rejects documents with the wrong version, shape, or no valid dataset', () => {
        expect(parseDemoDatasetCatalog(null)).toBeNull();
        expect(parseDemoDatasetCatalog([])).toBeNull();
        expect(parseDemoDatasetCatalog({ version: 2, datasets: [validEntry()] })).toBeNull();
        expect(parseDemoDatasetCatalog({ version: 1, datasets: {} })).toBeNull();
        expect(parseDemoDatasetCatalog({ version: 1, datasets: [{ id: 'broken' }] })).toBeNull();
    });
});

describe('checked-in demo catalog', () => {
    const repoDemoData = path.resolve(process.cwd(), '../demo-data');
    const raw = JSON.parse(readFileSync(path.join(repoDemoData, 'catalog.json'), 'utf8'));

    it('parses every entry and points each card at a CSV that exists', () => {
        const datasets = parseDemoDatasetCatalog(raw);

        expect(datasets).not.toBeNull();
        expect(datasets!.map(dataset => dataset.id)).toEqual(raw.datasets.map((entry: { id: string }) => entry.id));
        for (const dataset of datasets!) {
            expect(existsSync(path.join(repoDemoData, dataset.file))).toBe(true);
            expect(dataset.theme).not.toBeNull();
            for (const language of ['English', 'Mandarin', 'Malay', 'Japanese']) {
                expect(dataset.title[language as 'English']).toBeTruthy();
            }
        }
    });

    it('keeps the built-in HDB fallback in step with the catalog entries', () => {
        const datasets = parseDemoDatasetCatalog(raw)!;
        for (const fallback of getBuiltInDemoDatasets()) {
            const entry = datasets.find(dataset => dataset.id === fallback.id);
            expect(entry, fallback.id).toBeDefined();
            expect(fallback).toMatchObject({
                file: entry!.file,
                rows: entry!.rows,
                columns: entry!.columns,
                sizeBytes: entry!.sizeBytes,
                speed: entry!.speed,
                title: entry!.title,
            });
        }
    });
});

describe('demo dataset text fallback', () => {
    it('uses the requested language and falls back to English', () => {
        const [dataset] = parseDemoDatasetCatalog({ version: 1, datasets: [validEntry()] })!;

        expect(resolveDemoText(dataset.title, 'Japanese')).toBe('消費者物価');
        expect(resolveDemoText(dataset.description, 'Mandarin')).toBe('按类别的月度 CPI。');
        expect(resolveDemoText(dataset.description, 'Malay')).toBe('Monthly CPI by category.');
        expect(resolveDemoText(dataset.description, 'Spanish')).toBe('Monthly CPI by category.');
    });

    it('drops blank translations so they fall back to English', () => {
        const [dataset] = parseDemoDatasetCatalog({
            version: 1,
            datasets: [validEntry({ title: { English: 'Prices', Malay: '   ' } })],
        })!;

        expect(dataset.title).toEqual({ English: 'Prices' });
        expect(resolveDemoText(dataset.title, 'Malay')).toBe('Prices');
    });

    it('localizes the built-in HDB fallback in all four languages', () => {
        const [sample, full] = getBuiltInDemoDatasets();

        expect(resolveDemoText(sample.title, 'English')).toBe('HDB resale prices (small sample)');
        expect(resolveDemoText(sample.title, 'Mandarin')).toBe('组屋转售价格（小样本）');
        expect(resolveDemoText(full.title, 'Malay')).toBe('Harga jualan semula HDB (sejarah penuh)');
        expect(resolveDemoText(full.title, 'Japanese')).toBe('HDB公営住宅の再販価格（全期間）');
    });
});

describe('demo dataset catalog loader', () => {
    beforeEach(() => {
        __resetDemoDatasetCatalogCacheForTests();
        vi.spyOn(console, 'warn').mockImplementation(() => {});
    });

    afterEach(() => {
        vi.restoreAllMocks();
        vi.unstubAllGlobals();
    });

    it('fetches the relative catalog URL and returns the catalog datasets', async () => {
        const fetchImpl = vi.fn(async () => jsonResponse({ version: 1, datasets: [validEntry()] }));

        const result = await fetchDemoDatasetCatalog(fetchImpl);

        expect(fetchImpl).toHaveBeenCalledWith('demo-data/catalog.json');
        expect(DEMO_DATASET_CATALOG_URL).toBe('demo-data/catalog.json');
        expect(result.origin).toBe('catalog');
        expect(result.datasets.map(dataset => dataset.id)).toEqual(['sg-cpi']);
    });

    it.each([
        ['a missing catalog', async () => new Response('Not found', { status: 404 })],
        ['a non-JSON body', async () => new Response('a,b\n1,2\n', { status: 200 })],
        ['an invalid catalog', async () => jsonResponse({ version: 1, datasets: [{ id: 'broken' }] })],
        ['a network error', async () => { throw new TypeError('Failed to fetch'); }],
    ])('falls back to the two built-in HDB datasets on %s', async (_label, fetchImpl) => {
        const result = await fetchDemoDatasetCatalog(fetchImpl);

        expect(result.origin).toBe('fallback');
        expect(result.datasets.map(dataset => dataset.url)).toEqual([
            'demo-data/singapore-hdb-resale-prices-sample.csv',
            'demo-data/singapore-hdb-resale-prices.csv',
        ]);
        expect(result.datasets.map(dataset => dataset.speed)).toEqual(['fast', 'slow']);
        expect(result.datasets[0]).toMatchObject({ rows: 4988, columns: 11, sizeBytes: 423089 });
    });

    it('memoizes a valid catalog but retries after a fallback', async () => {
        const fetchMock = vi.fn()
            .mockRejectedValueOnce(new TypeError('offline'))
            .mockResolvedValue(jsonResponse({ version: 1, datasets: [validEntry()] }));
        vi.stubGlobal('fetch', fetchMock);

        expect((await loadDemoDatasetCatalog()).origin).toBe('fallback');
        expect((await loadDemoDatasetCatalog()).origin).toBe('catalog');
        expect((await loadDemoDatasetCatalog()).origin).toBe('catalog');
        expect(fetchMock).toHaveBeenCalledTimes(2);
    });
});
