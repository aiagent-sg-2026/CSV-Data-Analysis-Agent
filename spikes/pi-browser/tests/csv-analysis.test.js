import assert from 'node:assert/strict';
import test from 'node:test';
import { aggregateDataset, inspectDataset } from '../src/analysis.js';
import { MAX_CSV_BYTES, parseCsvFile, parseCsvText } from '../src/csv.js';

test('CSV parser keeps quoted delimiters and newlines, and rejects malformed rows', () => {
  const dataset = parseCsvText('group,amount,note\nA,10,"hello, world"\nB,20,"two\nlines"\n', 'quoted.csv');
  assert.equal(dataset.rowCount, 2);
  assert.equal(dataset.sampleRows[0].note, 'hello, world');
  assert.equal(dataset.sampleRows[1].note, 'two\nlines');
  assert.throws(() => parseCsvText('group,amount\nA\n'), /CSV parse failed/);
  assert.throws(() => parseCsvText('group,group\nA,B\n'), /unique/);
});

test('CSV file limit rejects oversized uploads before reading', async () => {
  await assert.rejects(parseCsvFile({ size: MAX_CSV_BYTES + 1, name: 'huge.csv' }), /up to 128 MB/);
});

test('browser aggregation filters, groups, and counts numeric values', async () => {
  const dataset = parseCsvText('month,town,flat_type,resale_price\n2023-01,ANG MO KIO,3 ROOM,100\n2023-02,ANG MO KIO,3 ROOM,200\n2023-03,ANG MO KIO,4 ROOM,400\n2024-01,BEDOK,3 ROOM,900\n');
  assert.deepEqual(inspectDataset(dataset).numericColumns, ['resale_price']);
  const result = await aggregateDataset(dataset, {
    metric: 'resale_price',
    filters: [
      { column: 'month', operator: 'starts_with', value: '2023' },
      { column: 'town', operator: 'equals', value: 'Ang Mo Kio' },
    ],
    groupBy: 'flat_type',
  });
  assert.equal(result.matchedRows, 3);
  assert.deepEqual(result.groups, [
    { group: '3 ROOM', count: 2, numericCount: 2, sum: 300, average: 150 },
    { group: '4 ROOM', count: 1, numericCount: 1, sum: 400, average: 400 },
  ]);
});

test('large numeric aggregation avoids cumulative floating-point drift', async () => {
  const dataset = parseCsvText(`amount\n${'0.1\n'.repeat(10000)}`);
  const result = await aggregateDataset(dataset, { metric: 'amount' });
  assert.equal(result.groups[0].sum, 1000);
});
