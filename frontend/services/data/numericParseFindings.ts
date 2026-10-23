import type { NumericParseCheck, NumericParseFinding } from '../../types';

// Pure and dependency-free so provenance and trust code can use it without
// pulling the query engine into their import graph.

/** The failed columns among `columns`, for the dataset version the check ran on. */
export const findNumericParseMismatches = (
    check: NumericParseCheck | null | undefined,
    datasetVersion: string | null | undefined,
    columns: readonly string[],
): NumericParseFinding[] => {
    if (!check || check.status !== 'mismatch' || !datasetVersion || check.datasetVersion !== datasetVersion) return [];
    const wanted = new Set(columns.map(column => column.toLowerCase()));
    return check.findings.filter(finding => wanted.has(finding.column.toLowerCase()));
};

