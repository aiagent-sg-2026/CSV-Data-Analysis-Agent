import { describe, expect, it } from 'vitest';
import type { CsvData } from '../types';
import { parseCsvTextWithDetection } from '../services/data/csvDialectDetector';
import { buildCsvDataFromIntakeIr, buildReportIntakeIr } from '../services/data/reportCsvIntake';
import { profileData } from '../services/data/dataProfiler';
import { executeDataQuery } from '../services/agent/execution/dataQueryExecutor';

// Excel's accounting format exports a zero as an apostrophe-prefixed dash
// ('-). Aggregation no longer reads blanks as 0, so the intake must keep such
// a cell as the 0 it reports, in every numeric column, while a bare `-` or
// `na` stays missing.

const importCsv = (text: string): CsvData => {
    const { rawRows, detection } = parseCsvTextWithDetection(text);
    return buildCsvDataFromIntakeIr(buildReportIntakeIr('ledger.csv', rawRows, detection));
};

const LEDGER = [
    'Account,Region,Amount,Adjustment,Note',
    "A100,East,120.50,'-,ok",
    'A101,East,80,-,late',
    "A102,West,'-,10,'-",
    'A103,West,200,na,ok',
    'A104,North,40,5,early',
    'A105,North,60,7,ok',
    'A106,South,90,8,late',
    'A107,South,30,9,ok',
    'A108,East,70,11,ok',
    'A109,West,50,12,early',
].join('\n') + '\n';

describe("accounting zero placeholder ('-)", () => {
    it('keeps an apostrophe dash as 0 in a numeric column below any frequency threshold', () => {
        const data = importCsv(LEDGER);
        expect(data.data).toHaveLength(10);
        // One '- in ten rows: far below the cleaning pipeline's 30% backfill.
        expect(data.data.map(row => row.Amount)).toEqual(['120.50', '80', '0', '200', '40', '60', '90', '30', '70', '50']);
        expect(data.data[0].Adjustment).toBe('0');
        // A bare dash and `na` stay missing markers.
        expect(data.data[1].Adjustment).toBe('-');
        expect(data.data[3].Adjustment).toBe('na');
        // In a text column the apostrophe dash is not a number.
        expect(data.data[2].Note).toBe('');

        const result = executeDataQuery(data.data, {
            aggregates: [
                { function: 'avg', column: 'Amount', as: 'avg_amount' },
                { function: 'min', column: 'Amount', as: 'min_amount' },
                { function: 'count', column: 'Amount', as: 'amounts' },
                { function: 'count', column: 'Adjustment', as: 'adjustments' },
            ],
        }, { allowedColumns: Object.keys(data.data[0]) });
        expect(result.rows[0]).toMatchObject({ min_amount: 0, amounts: 10, adjustments: 8 });
        expect(Number(result.rows[0].avg_amount)).toBeCloseTo(740.5 / 10, 9);

        const profiles = new Map(profileData(data.data).profiles.map(profile => [profile.name, profile]));
        expect(profiles.get('Amount')).toMatchObject({ type: 'numerical', missingPercentage: 0, valueRange: [0, 200] });
        expect(profiles.get('Adjustment')).toMatchObject({ type: 'numerical', missingPercentage: 20 });
    });

    it('reads a column made only of apostrophe dashes as zeros, not as an empty column', () => {
        const data = importCsv(['Item,Sales,Returns', "A,100,'-", "B,200,'-", "C,50,'-"].join('\n') + '\n');
        const rows = data.data.filter(row => row.Item);
        expect(rows.map(row => row.Returns)).toEqual(['0', '0', '0']);
        expect(profileData(rows).profiles.find(profile => profile.name === 'Returns')).toMatchObject({ type: 'numerical', missingPercentage: 0 });
    });
});
