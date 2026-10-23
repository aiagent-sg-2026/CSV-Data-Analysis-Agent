/**
 * Maps output of defaultGatewayDataPreparationSchema back to the canonical
 * data-preparation contract. On the gateway every operation shares one field
 * set and strict mode fills unused fields with [] or "", so each operation keeps
 * only the fields its type uses, under their canonical names. The result still
 * goes through normalizeDataPreparationPlan, which validates every operation.
 */

type GatewayRecord = Record<string, unknown>;

const isRecord = (value: unknown): value is GatewayRecord =>
    Boolean(value) && typeof value === 'object' && !Array.isArray(value);

const strings = (value: unknown): string[] =>
    Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0) : [];

const text = (value: unknown): string => (typeof value === 'string' ? value : '');

const predicates = (value: unknown) =>
    (Array.isArray(value) ? value.filter(isRecord) : []).map(predicate => {
        const operator = text(predicate.operator);
        return operator === 'is_null' || operator === 'not_null'
            ? { column: text(predicate.column), operator }
            : { column: text(predicate.column), operator, value: predicate.value };
    });

const mappings = (value: unknown) =>
    (Array.isArray(value) ? value.filter(isRecord) : []).map(mapping => ({ from: text(mapping.from), to: text(mapping.to) }));

/** Canonical `columns` for trim/normalize: "*" when the model asked for all columns or named none. */
const columnsOrAll = (value: unknown): string[] | '*' => {
    const columns = strings(value);
    return columns.length === 0 || (columns.length === 1 && columns[0] === '*') ? '*' : columns;
};

const liftOperation = (operation: unknown): unknown => {
    if (!isRecord(operation)) return operation;
    const type = text(operation.type);
    const base = { id: operation.id, type, reason: operation.reason };
    switch (type) {
        case 'drop_rows_by_index':
            return { ...base, indices: operation.indices };
        case 'drop_blank_rows':
            return base;
        case 'drop_rows_by_condition':
        case 'filter_rows':
            return { ...base, predicates: predicates(operation.predicates) };
        case 'promote_header_row':
            return { ...base, rowIndex: Array.isArray(operation.indices) ? operation.indices[0] : undefined };
        case 'rename_columns':
            return { ...base, mappings: mappings(operation.mappings) };
        case 'drop_columns':
            return { ...base, columns: strings(operation.columns) };
        case 'trim_whitespace':
            return { ...base, columns: columnsOrAll(operation.columns) };
        case 'normalize_empty_values': {
            const emptyMarkers = strings(operation.emptyMarkers);
            return { ...base, columns: columnsOrAll(operation.columns), ...(emptyMarkers.length > 0 ? { emptyMarkers } : {}) };
        }
        case 'replace_values':
            return { ...base, column: text(operation.column), replacements: mappings(operation.mappings) };
        case 'cast_column':
            return { ...base, column: text(operation.column), targetType: operation.targetType };
        case 'dedupe_rows':
            return { ...base, keyColumns: strings(operation.columns), keep: 'first' };
        case 'unpivot_columns':
            return {
                ...base,
                sourceColumns: strings(operation.columns),
                keyColumn: text(operation.keyColumn),
                valueColumn: text(operation.valueColumn),
                keepColumns: strings(operation.keepColumns),
            };
        default:
            // Unknown types reach normalization unchanged so it reports them.
            return operation;
    }
};

export const liftGatewayDataPreparationOutput = (output: unknown): unknown => {
    if (!isRecord(output) || !Array.isArray(output.operations)) return output;
    return { ...output, operations: output.operations.map(liftOperation) };
};
