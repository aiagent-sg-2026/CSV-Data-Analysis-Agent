import { buildMissingCellSqlCondition } from './dimensionNormalization';

/**
 * SQL text-to-number expressions shared by the query compiler, the diagnostic
 * templates and the DuckDB worker's VARCHAR aggregate repair, so every SQL path
 * reads European, Swiss and US numbers the same way the JS parser does.
 */

const quoteIdentifier = (value: string) => `"${value.replace(/"/g, '""')}"`;
const quoteStringLiteral = (value: string) => `'${value.replace(/'/g, "''")}'`;

export const buildEmptyAwareExpression = (column: string) => `TRIM(COALESCE(CAST(${quoteIdentifier(column)} AS VARCHAR), ''))`;
/**
 * Cells that are only valid in the European style: `1.234,56`, `161,30`,
 * `0,500`, `1234,567`. A lone `1,234` or `4.567` fits both styles and is
 * deliberately not matched, so it keeps the US reading (thousands comma,
 * decimal point) here. Dotted groups alone (`1.234.567`) are not matched either:
 * they may be part codes, so they only become numbers in a column that proves
 * the decimal comma, which is normalised per column before the data reaches
 * DuckDB (see `normalizeDecimalCommaColumns`). Mirrors `classifyNumberBody` in
 * services/data/numberLocale.ts.
 */
const EUROPEAN_NUMBER_SQL_PATTERN = String.raw`^[+-]?[$€£¥]?\s*(\d{1,3}(\.\d{3})+,\d+|\d+,(\d{1,2}|\d{4,})|\d{4,},\d{3}|0\d*,\d{3})\s*%?$`;

/** Swiss thousands apostrophes (1'234.50, 1’234.50); mirrors SWISS_APOSTROPHE in numberLocale.ts. */
const SWISS_NUMBER_SQL_PATTERN = String.raw`^[+-]?[$€£¥]?\s*\d+(['’]\d{3})+(\.\d+)?\s*%?$`;

/**
 * Turns an unambiguous European or Swiss number into plain digits (`1234.56`);
 * leaves every other cell alone. `source` is a CASE ... END expression and is
 * not parenthesised: SQL admission (sqlSecurity.ts) rejects `ELSE (` as an
 * unreviewed function call.
 */
const buildDecimalCommaAwareExpression = (source: string) =>
    `CASE WHEN (${source} LIKE '%,%') AND regexp_matches(${source}, ${quoteStringLiteral(EUROPEAN_NUMBER_SQL_PATTERN)})`
    + ` THEN REPLACE(REPLACE(${source}, '.', ''), ',', '.')`
    + ` WHEN (${source} LIKE '%''%' OR ${source} LIKE '%’%') AND regexp_matches(${source}, ${quoteStringLiteral(SWISS_NUMBER_SQL_PATTERN)})`
    + ` THEN REPLACE(REPLACE(${source}, '''', ''), '’', '')`
    + ` ELSE ${source} END`;

/**
 * A column's numeric value, or NULL when the cell is blank, a missing marker
 * (`na`, `N.A.`, `-`, ...) or not a number. Aggregates rely on that NULL: SQL
 * aggregates skip it, so a missing value is never summed, averaged or ranked
 * as 0, and a group with no reported values aggregates to NULL.
 */
export const buildNumericExpression = (column: string) => {
    const textExpression = buildEmptyAwareExpression(column);
    const normalizedNegativeExpression = `CASE WHEN ${textExpression} LIKE '(%' AND ${textExpression} LIKE '%)' THEN CONCAT('-', SUBSTRING(${textExpression}, 2, LENGTH(${textExpression}) - 2)) ELSE ${textExpression} END`;
    // The JS parser drops every space (including no-break spaces used as thousands
    // separators: 1 234,56), so the SQL expression must too or the two readings of
    // the same cell would disagree.
    const spaceFreeExpression = `REPLACE(REPLACE(REPLACE(${normalizedNegativeExpression}, ' ', ''), '\u00a0', ''), '\u202f', '')`;
    const decimalNormalizedExpression = buildDecimalCommaAwareExpression(spaceFreeExpression);
    const strippedExpression = `REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(${decimalNormalizedExpression}, ',', ''), '$', ''), '€', ''), '£', ''), '¥', ''), '%', '')`;
    return `CASE WHEN ${buildMissingCellSqlCondition(textExpression)} THEN NULL ELSE TRY_CAST(NULLIF(${strippedExpression}, '') AS DOUBLE) END`;
};
