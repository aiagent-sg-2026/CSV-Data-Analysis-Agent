import Papa from 'papaparse';

export const MAX_CSV_BYTES = 128 * 1024 * 1024;
const CHUNK_BYTES = 2 * 1024 * 1024;
const SAMPLE_ROWS = 200;

function validateColumns(columns, renamedHeaders) {
  if (columns.length === 0 || columns.some((column) => !column.trim())) {
    throw new Error('CSV needs a non-empty header row.');
  }
  if (Object.keys(renamedHeaders || {}).length > 0) {
    throw new Error('CSV header names must be unique.');
  }
  return columns;
}

function parseError(error) {
  return new Error(`CSV parse failed at row ${error.row ?? 'unknown'}: ${error.message}`);
}

function firstFatalError(errors, columns) {
  return errors.find((error) => error.code !== 'UndetectableDelimiter' || columns.length !== 1);
}

export function parseCsvText(text, name = 'uploaded.csv') {
  const parsed = Papa.parse(text, { header: true, skipEmptyLines: 'greedy' });
  const error = firstFatalError(parsed.errors, parsed.meta.fields || []);
  if (error) throw parseError(error);

  const columns = validateColumns(parsed.meta.fields || [], parsed.meta.renamedHeaders);
  if (parsed.data.length === 0) {
    throw new Error('CSV contains no data rows.');
  }

  const rows = parsed.data;
  return {
    name,
    columns,
    rowCount: rows.length,
    sampleRows: rows.slice(0, SAMPLE_ROWS),
    scanRows: async (visitRow, onProgress) => {
      for (const row of rows) visitRow(row);
      onProgress?.(rows.length);
    },
  };
}

export function scanCsvFile(file, visitRow, onProgress) {
  return new Promise((resolve, reject) => {
    let columns = null;
    let rowCount = 0;
    let settled = false;
    const fail = (error, parser) => {
      if (settled) return;
      settled = true;
      parser?.abort();
      reject(error);
    };

    try {
      // FileReader loads one chunk at a time; no full-file row array is retained.
      Papa.parse(file, {
        header: true,
        skipEmptyLines: 'greedy',
        chunkSize: CHUNK_BYTES,
        chunk: (result, parser) => {
          if (settled) return;
          try {
            const error = firstFatalError(result.errors, result.meta.fields || columns || []);
            if (error) throw parseError(error);
            if (!columns) columns = validateColumns(result.meta.fields || [], result.meta.renamedHeaders);
            for (const row of result.data) {
              visitRow(row);
              rowCount += 1;
            }
            onProgress?.(rowCount);
          } catch (error) {
            fail(error, parser);
          }
        },
        complete: () => {
          if (settled) return;
          if (!columns || !rowCount) {
            fail(new Error(columns ? 'CSV contains no data rows.' : 'CSV needs a non-empty header row.'));
            return;
          }
          settled = true;
          resolve({ columns, rowCount });
        },
        error: (error) => fail(new Error(`CSV read failed: ${error.message}`)),
      });
    } catch (error) {
      fail(error);
    }
  });
}

export async function parseCsvFile(file, onProgress) {
  if (!file) throw new Error('Choose a CSV file first.');
  if (file.size > MAX_CSV_BYTES) {
    throw new Error(`This spike accepts CSV files up to ${MAX_CSV_BYTES / 1024 / 1024} MB.`);
  }

  const sampleRows = [];
  const { columns, rowCount } = await scanCsvFile(file, (row) => {
    if (sampleRows.length < SAMPLE_ROWS) sampleRows.push(row);
  }, onProgress);
  return {
    name: file.name,
    columns,
    rowCount,
    sampleRows,
    scanRows: (visitRow, progress) => scanCsvFile(file, visitRow, progress),
  };
}
