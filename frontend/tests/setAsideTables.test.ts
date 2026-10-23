import { describe, expect, it } from 'vitest';
import { describeSetAsideTables, formatSetAsideRowCounts, getActiveSetAsideSections } from '../utils/setAsideTables';
import type { IntakeSetAsideSection } from '../types';

const section = (rowStart: number, rowCount: number): IntakeSetAsideSection => ({
    rowStart, rowEnd: rowStart + rowCount, titleRowIndex: rowStart, headerRowIndex: rowStart + 1, title: 'T', headerLabels: [], rowCount,
});

describe('set-aside table wording', () => {
    it('lists row counts with a language-specific "and"', () => {
        expect(formatSetAsideRowCounts([700, 900], 'English')).toBe('700 and 900 rows');
        expect(formatSetAsideRowCounts([700, 800, 900], 'English')).toBe('700, 800 and 900 rows');
        expect(formatSetAsideRowCounts([700, 900], 'Mandarin')).toBe('700和900 行');
        expect(formatSetAsideRowCounts([700, 900], 'Japanese')).toBe('700と900 行');
        expect(formatSetAsideRowCounts([700, 900], 'Malay')).toBe('700 dan 900 baris');
    });

    it('uses singular wording for one table and one row', () => {
        expect(formatSetAsideRowCounts([1], 'English')).toBe('1 row');
        expect(formatSetAsideRowCounts([700], 'English')).toBe('700 rows');
        expect(describeSetAsideTables([700], 'English')).toBe('1 other table in the file was set aside (700 rows)');
        expect(describeSetAsideTables([700, 900], 'English')).toBe('2 other tables in the file were set aside (700 and 900 rows)');
        expect(describeSetAsideTables([], 'English')).toBeNull();
    });

    it('describes the set-aside tables in all four languages', () => {
        expect(describeSetAsideTables([700, 900], 'Mandarin')).toBe('文件中另有 2 张表格已被搁置（700和900 行）');
        expect(describeSetAsideTables([700, 900], 'Japanese')).toBe('ファイル内の他の表 2 個を除外しました（700と900 行）');
        expect(describeSetAsideTables([700, 900], 'Malay')).toBe('2 jadual lain dalam fail telah diketepikan (700 dan 900 baris)');
    });

    it('keeps the tables above a confirmed summary start and drops the ones taken back as data', () => {
        const sections = [section(100, 10), section(200, 20)];
        expect(getActiveSetAsideSections(sections, null)).toEqual(sections);
        expect(getActiveSetAsideSections(sections, { summaryStartIndex: 100 })).toEqual(sections);
        expect(getActiveSetAsideSections(sections, { summaryStartIndex: 150 })).toEqual([sections[1]]);
        expect(getActiveSetAsideSections(sections, { summaryStartIndex: null })).toEqual([]);
        expect(getActiveSetAsideSections(undefined, null)).toEqual([]);
    });
});
