import Papa from 'papaparse';

export const MAX_CSV_BYTES = 10 * 1024 * 1024;

export function parseCsvText(text, name = 'uploaded.csv') {
  const parsed = Papa.parse(text, { header: true, skipEmptyLines: 'greedy' });
  if (parsed.errors.length > 0) {
    const first = parsed.errors[0];
    throw new Error(`CSV parse failed at row ${first.row ?? 'unknown'}: ${first.message}`);
  }

  const columns = parsed.meta.fields || [];
  if (columns.length === 0 || columns.some((column) => !column.trim())) {
    throw new Error('CSV needs a non-empty header row.');
  }
  if (Object.keys(parsed.meta.renamedHeaders || {}).length > 0) {
    throw new Error('CSV header names must be unique.');
  }
  if (parsed.data.length === 0) {
    throw new Error('CSV contains no data rows.');
  }

  return { name, columns, rows: parsed.data };
}

export async function parseCsvFile(file) {
  if (!file) throw new Error('Choose a CSV file first.');
  if (file.size > MAX_CSV_BYTES) {
    throw new Error(`This spike accepts CSV files up to ${MAX_CSV_BYTES / 1024 / 1024} MB.`);
  }
  return parseCsvText(await file.text(), file.name);
}
