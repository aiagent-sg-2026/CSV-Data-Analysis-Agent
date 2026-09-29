import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
    exportDatasetToCsv,
    exportToCsv,
    exportToHtml,
    exportToPng,
    type AnalysisExportMetadata,
} from '../utils/exportUtils';

const { toPngMock } = vi.hoisted(() => ({
    toPngMock: vi.fn(async (_element: HTMLElement) => 'data:image/png;base64,export'),
}));

vi.mock('html-to-image', () => ({
    toPng: toPngMock,
}));

const metadata: AnalysisExportMetadata = {
    cardId: 'card-1',
    scope: 'Top 10 · Town = WOODLANDS',
    trustStatus: 'verified',
    datasetVersion: 'version-current',
};

const readBlob = (blob: Blob): Promise<string> => new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result ?? ''));
    reader.onerror = () => reject(reader.error);
    reader.readAsText(blob);
});

describe('analysis exports', () => {
    let downloadedBlobs: Blob[];
    let clickedDownloads: string[];

    beforeEach(() => {
        downloadedBlobs = [];
        clickedDownloads = [];
        vi.clearAllMocks();
        Object.defineProperty(URL, 'createObjectURL', {
            configurable: true,
            value: vi.fn((blob: Blob) => {
                downloadedBlobs.push(blob);
                return `blob:export-${downloadedBlobs.length}`;
            }),
        });
        Object.defineProperty(URL, 'revokeObjectURL', {
            configurable: true,
            value: vi.fn(),
        });
        vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function captureDownload(this: HTMLAnchorElement) {
            clickedDownloads.push(this.download);
        });
    });

    it('adds the same scope, trust, dataset version, and card id to card CSV exports', async () => {
        expect(exportToCsv([{ Town: 'WOODLANDS', Total: 100 }], 'Town total', metadata))
            .toEqual({ success: true });

        const csv = await readBlob(downloadedBlobs[0]);
        expect(csv).toContain('_export_scope');
        expect(csv).toContain('Top 10 · Town = WOODLANDS');
        expect(csv).toContain('verified');
        expect(csv).toContain('version-current');
        expect(csv).toContain('card-1');
        expect(clickedDownloads).toEqual(['Town_total.csv']);
        expect(URL.revokeObjectURL).toHaveBeenCalledTimes(1);
    });

    it('downloads the complete prepared dataset without adding card metadata columns', async () => {
        expect(exportDatasetToCsv(
            [{ Row: 1 }, { Row: 2 }, { Row: 3 }],
            'cleaned_source.csv',
        )).toEqual({ success: true });

        const csv = await readBlob(downloadedBlobs[0]);
        expect(csv).toContain('Row');
        expect(csv).toContain('1');
        expect(csv).toContain('3');
        expect(csv).not.toContain('_export_scope');
        expect(clickedDownloads).toEqual(['cleaned_source.csv']);
    });

    it('embeds provenance in HTML and safely escapes report values', async () => {
        const root = document.createElement('div');
        const result = await exportToHtml(
            root,
            '<Town report>',
            [{ Town: '<script>alert(1)</script>', Total: 100 }],
            '<b>summary</b>',
            metadata,
        );

        expect(result).toEqual({ success: true });
        const html = await readBlob(downloadedBlobs[0]);
        expect(html).toContain('Export provenance');
        expect(html).toContain('version-current');
        expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
        expect(html).not.toContain('<script>alert(1)</script>');
    });

    it('adds export provenance to PNG capture and removes it from the live card afterwards', async () => {
        const root = document.createElement('div');
        root.textContent = 'Card';

        expect(await exportToPng(root, 'Card', { metadata })).toEqual({ success: true });

        expect(toPngMock).toHaveBeenCalledTimes(1);
        const capturedRoot = toPngMock.mock.calls[0][0] as HTMLElement;
        expect(capturedRoot.querySelector('[data-analysis-export-metadata]')).toBeNull();
        expect(root.querySelector('[data-analysis-export-metadata]')).toBeNull();
    });

    it('includes a collapsed card table in full PNG and removes the temporary table afterwards', async () => {
        const root = document.createElement('div');
        root.innerHTML = '<div data-export-table><table><tbody><tr><td>Selected row only</td></tr></tbody></table></div>';
        toPngMock.mockImplementationOnce(async (captured: HTMLElement) => {
            const table = captured.querySelector('[data-temporary-export-table] table');
            expect(table?.querySelectorAll('tbody tr')).toHaveLength(2);
            expect(table?.textContent).toContain('STREET 1');
            expect(table?.textContent).toContain('36506250');
            expect(captured.querySelector('script')).toBeNull();
            return 'data:image/png;base64,export';
        });

        expect(await exportToPng(root, 'Street total', {
            includeTable: true,
            tableData: [
                { street_name: 'STREET 1', sum_resale_price: 36506250 },
                { street_name: '<script>unsafe</script>', sum_resale_price: 1 },
            ],
        })).toEqual({ success: true });
        expect(root.querySelector('[data-temporary-export-table]')).toBeNull();
        expect(root.querySelector('script')).toBeNull();
    });

    it('captures every row of a vertically scrollable chart and restores its viewport', async () => {
        const root = document.createElement('div');
        const chartScroll = document.createElement('div');
        chartScroll.className = 'max-h-[540px] overflow-y-auto';
        chartScroll.dataset.exportChartScroll = 'true';
        root.appendChild(chartScroll);
        toPngMock.mockImplementationOnce(async () => {
            expect(chartScroll.style.maxHeight).toBe('none');
            expect(chartScroll.style.overflowY).toBe('visible');
            return 'data:image/png;base64,export';
        });

        expect(await exportToPng(root, 'All Towns')).toEqual({ success: true });
        expect(chartScroll.style.maxHeight).toBe('');
        expect(chartScroll.style.overflowY).toBe('');
    });
});
