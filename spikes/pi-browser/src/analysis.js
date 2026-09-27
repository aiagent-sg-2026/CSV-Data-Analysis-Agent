const MAX_GROUPS = 30;

function numericValue(value) {
  if (value === null || value === undefined || String(value).trim() === '') return null;
  const number = Number(String(value).trim().replaceAll(',', ''));
  return Number.isFinite(number) ? number : null;
}

function requireColumn(dataset, column) {
  if (!dataset.columns.includes(column)) throw new Error(`Unknown column: ${column}`);
}

export function inspectDataset(dataset) {
  const sample = dataset.sampleRows;
  const numericColumns = dataset.columns.filter((column) => {
    const values = sample.map((row) => row[column]).filter((value) => String(value ?? '').trim());
    return values.length > 0 && values.filter((value) => numericValue(value) !== null).length / values.length >= 0.9;
  });
  // Only schema and counts leave the browser during inspection; raw rows stay local.
  return { rowCount: dataset.rowCount, columns: dataset.columns, numericColumns };
}

export async function aggregateDataset(dataset, { metric, filters = [], groupBy }, onProgress) {
  if (metric) requireColumn(dataset, metric);
  if (groupBy) requireColumn(dataset, groupBy);
  if (filters.length > 6) throw new Error('Use at most six filters per aggregation.');
  for (const filter of filters) {
    requireColumn(dataset, filter.column);
    if (!['equals', 'starts_with'].includes(filter.operator)) {
      throw new Error(`Unsupported filter operator: ${filter.operator}`);
    }
  }

  const groups = new Map();
  let matchedRows = 0;
  await dataset.scanRows((row) => {
    const matches = filters.every(({ column, operator, value }) => {
      const cell = String(row[column] ?? '').toLowerCase();
      const expected = String(value).toLowerCase();
      return operator === 'equals' ? cell === expected : cell.startsWith(expected);
    });
    if (!matches) return;

    matchedRows += 1;
    const group = groupBy ? String(row[groupBy] ?? '') : 'all';
    if (!groups.has(group)) {
      if (groups.size >= MAX_GROUPS) throw new Error(`More than ${MAX_GROUPS} groups; add a filter.`);
      groups.set(group, { group, count: 0, numericCount: 0, sum: 0, compensation: 0 });
    }
    const summary = groups.get(group);
    summary.count += 1;
    if (metric) {
      const number = numericValue(row[metric]);
      if (number !== null) {
        summary.numericCount += 1;
        // Compensated summation prevents row-order drift across large CSV scans.
        const corrected = number - summary.compensation;
        const next = summary.sum + corrected;
        summary.compensation = (next - summary.sum) - corrected;
        summary.sum = next;
      }
    }
  }, onProgress);

  return {
    matchedRows,
    metric: metric || null,
    groupBy: groupBy || null,
    groups: [...groups.values()].sort((a, b) => a.group.localeCompare(b.group)).map((summary) => ({
      group: summary.group,
      count: summary.count,
      numericCount: summary.numericCount,
      sum: summary.sum,
      ...(metric ? { average: summary.numericCount ? Number((summary.sum / summary.numericCount).toFixed(2)) : null } : {}),
    })),
  };
}
