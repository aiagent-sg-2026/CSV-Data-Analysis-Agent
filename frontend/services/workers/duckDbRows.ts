import type { CsvRow, CsvCellValue } from '../../types';
import { toJsonCompatible } from '../../utils/serializable';

// Arrow's stable Decimal type ID is 7. SUM(BIGINT) uses Decimal128 words;
// their custom BigNum prototype is lost by postMessage/JSON serialization.
const ARROW_DECIMAL_TYPE_ID = 7;
const decimalCell = (value: unknown, type?: {typeId?: number; scale?: number}): unknown => {
    if (value === null || type?.typeId !== ARROW_DECIMAL_TYPE_ID) return value;
    if (!(value instanceof Uint32Array)) throw new Error('sql_decimal_invalid');
    const scale = type.scale;
    if (typeof scale !== 'number' || !Number.isInteger(scale) || Math.abs(scale) > 76 || ![4, 8].includes(value.length)) throw new Error('sql_decimal_invalid');
    let unscaled = 0n;
    for (let i = value.length - 1; i >= 0; i--) unscaled = (unscaled << 32n) | BigInt(value[i]);
    unscaled = BigInt.asIntN(value.length * 32, unscaled);
    if (scale <= 0) {
        const integer = unscaled * (10n ** BigInt(-scale));
        const number = Number(integer);
        return Number.isSafeInteger(number) ? number : integer.toString();
    }
    // Keep scaled decimals exact rather than introduce binary rounding.
    const digits = (unscaled < 0n ? -unscaled : unscaled).toString().padStart(scale + 1, '0');
    return `${unscaled < 0n ? '-' : ''}${digits.slice(0, -scale)}.${digits.slice(-scale)}`;
};

export const tableToRows = (table: any): CsvRow[] => {
    // Prefer column-based extraction to avoid Apache Arrow's toJSON() type
    // inference, which silently converts VARCHAR date strings ("02-12-2010")
    // into numeric date representations (just the day number).
    if (table && typeof table.numRows === 'number' && typeof table.numCols === 'number' && table.numRows > 0 && table.schema) {
        try {
            const fields: Array<{ name: string; type?: {typeId?: number; scale?: number} }> = table.schema.fields ?? [];
            const rows: CsvRow[] = [];
            for (let r = 0; r < table.numRows; r++) {
                const row: CsvRow = {};
                for (let c = 0; c < table.numCols; c++) {
                    const col = table.getChildAt(c);
                    if (!col) continue;
                    let value = decimalCell(col.get(r), fields[c]?.type);
                    // Arrow date/timestamp types → ISO date string
                    if (value instanceof Date) {
                        value = value.toISOString().split('T')[0];
                    }
                    // BigInt → Number
                    if (typeof value === 'bigint') {
                        const num = Number(value);
                        value = Number.isSafeInteger(num) ? num : value.toString();
                    }
                    row[fields[c]?.name ?? `col_${c}`] = value as CsvCellValue;
                }
                rows.push(row);
            }
            return rows;
        } catch (error) {
            if (error instanceof Error && error.message === 'sql_decimal_invalid') throw error;
            // Fall through to legacy toArray path
        }
    }
    // Legacy fallback: use toArray().toJSON() (may have Arrow type inference issues)
    if (!table || typeof table.toArray !== 'function') {
        return [];
    }
    return table.toArray().map((row: any) => {
        if (row && typeof row.toJSON === 'function') {
            return toJsonCompatible(row.toJSON()) as CsvRow;
        }
        return toJsonCompatible(row) as CsvRow;
    });
};

