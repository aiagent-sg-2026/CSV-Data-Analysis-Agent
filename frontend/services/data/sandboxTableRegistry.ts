import type { CsvRow, SandboxTransformationOutput } from '../../types';

const tableRowsByBundle = new Map<string, Map<string, { rows: CsvRow[]; datasetVersion?: string }>>();

export const registerSandboxTableRows = (
    bundleId: string,
    output: SandboxTransformationOutput,
    datasetVersion?: string,
): void => {
    tableRowsByBundle.set(bundleId, new Map(output.tables.map(table => [
        table.tableId,
        { rows: table.rows.map(row => ({ ...row })), datasetVersion },
    ])));
};

export const getSandboxTableRows = (
    bundleId: string,
    tableId: string,
    datasetVersion?: string,
): CsvRow[] | null => {
    const entry = tableRowsByBundle.get(bundleId)?.get(tableId);
    return entry && (datasetVersion === undefined || entry.datasetVersion === datasetVersion)
        ? entry.rows.map(row => ({ ...row })) : null;
};

export const clearSandboxTableRows = (bundleId?: string | null): void => {
    if (bundleId) {
        tableRowsByBundle.delete(bundleId);
        return;
    }
    tableRowsByBundle.clear();
};
