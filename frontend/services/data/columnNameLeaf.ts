import type { ColumnAdditivity } from '../../types';

/**
 * Column-name priors for report-style tables whose headers are folded from
 * several layers ("Amount :: Balance Amount", "Quantity :: Balance").
 *
 * Only the leaf after the layer separator names the measure; the layers say
 * what kind of number it is (a quantity, an amount). Reading the whole string
 * as one phrase lets a layer label ("Amount") make two different columns look
 * alike: a unit price and an open order value are both "Amount ::" columns.
 * These rules never override a person's choice; they only correct the model's
 * judgement where the leaf plus the table's shape is unambiguous.
 */

const LAYER_SEPARATOR = '::';

const normalizeWords = (value: string): string =>
    value.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

export const splitColumnLayers = (columnName: string): { layers: string[]; leaf: string } => {
    const parts = columnName.split(LAYER_SEPARATOR).map(part => part.trim()).filter(Boolean);
    const leaf = parts.length > 0 ? parts[parts.length - 1] : columnName.trim();
    return { layers: parts.slice(0, -1), leaf };
};

// A row serial number ("S/N", "No.", "Sr No") labels the line, it does not measure anything.
const SERIAL_LEAF = /^(s n|sn|sr|sr no|sr number|serial|serial no|serial number|no|row|row no|row number|line|line no|line number|item no)$/;
// The state of a document line: how much was ordered, shipped or is still open.
const LINE_STATE = '(ordered|order|balance|outstanding|open|shipped|delivered|received|invoiced|pending|backorder|backordered|supplied|requested|remaining)';
const QUANTITY_LAYER = /^(qty|quantity|units?)$/;
const AMOUNT_LAYER = /^(amount|amt|value)$/;
const OPEN_AMOUNT_LEAF = /^(balance|outstanding|open|unpaid|due|pending|overdue|remaining) (amount|amt|value|total)$|^(amount|amt|value) (balance|outstanding|due|open|unpaid|pending|overdue)$/;
const QUANTITY_STATE_LEAF = new RegExp(`^(qty|quantity) ${LINE_STATE}$|^${LINE_STATE} (qty|quantity)$`);
const LINE_STATE_ONLY_LEAF = new RegExp(`^${LINE_STATE}$`);
const UNIT_PRICE_LEAF = /^unit (price|cost|value|rate)$/;
const BARE_PRICE_LEAF = /^(selling |list |sale |sales |standard |std )?price$/;
// A money amount people add up: totals, open balances of lines, revenue, cost.
const MONEY_LEAF = /(^| )(amount|amt|revenue|sales|turnover|income|profit|expense|spend|value|cost)( |$)/;

const DOCUMENT_ID_COLUMN = /(^| )(so|po|inv|invoice|order|bill|document|doc|delivery|do|dn|grn|ref|reference|voucher) ?(no|number|nbr|num|id)( |$)/;
const QUANTITY_COLUMN = /(^| )(qty|quantity)( |$)/;

/** A table of document lines (orders, invoices) has quantity or document-number columns next to its amounts. */
const hasLineItemContext = (siblingNames: readonly string[]): boolean =>
    siblingNames.some(name => {
        const words = normalizeWords(name);
        return DOCUMENT_ID_COLUMN.test(words) || QUANTITY_COLUMN.test(words);
    });

const hasQuantitySibling = (siblingNames: readonly string[]): boolean =>
    siblingNames.some(name => QUANTITY_COLUMN.test(normalizeWords(name)));

export type LeafMeasureKind = 'serial_number' | 'open_amount' | 'line_quantity' | 'unit_price';

/**
 * Classifies a numeric column from the leaf of its name and the shape of the
 * table it sits in. Returns null when the name alone does not settle it.
 */
export const classifyMeasureLeaf = (
    columnName: string,
    siblingNames: readonly string[] = [],
): LeafMeasureKind | null => {
    const { layers, leaf } = splitColumnLayers(columnName);
    const leafWords = normalizeWords(leaf);
    const layerWords = layers.map(normalizeWords);
    if (!leafWords) return null;
    if (layers.length === 0 && SERIAL_LEAF.test(leafWords)) return 'serial_number';
    if (UNIT_PRICE_LEAF.test(leafWords)) return 'unit_price';
    // A bare "Price" is a per-unit value only next to a quantity it multiplies.
    if (BARE_PRICE_LEAF.test(leafWords) && hasQuantitySibling(siblingNames)) return 'unit_price';
    const lineContext = layers.length > 0 || hasLineItemContext(siblingNames);
    if (lineContext && OPEN_AMOUNT_LEAF.test(leafWords)) return 'open_amount';
    if (layerWords.some(word => AMOUNT_LAYER.test(word)) && LINE_STATE_ONLY_LEAF.test(leafWords) && leafWords !== 'order') {
        return 'open_amount';
    }
    if (QUANTITY_STATE_LEAF.test(leafWords)) return 'line_quantity';
    if (layerWords.some(word => QUANTITY_LAYER.test(word)) && LINE_STATE_ONLY_LEAF.test(leafWords)) return 'line_quantity';
    return null;
};

/** The additivity the column name settles, or null when the name leaves it to the model. */
export const inferLeafAdditivity = (
    columnName: string,
    siblingNames: readonly string[] = [],
): ColumnAdditivity | null => {
    switch (classifyMeasureLeaf(columnName, siblingNames)) {
        case 'serial_number':
            return { kind: 'non_additive', nature: 'identifier', rationale: 'A row serial number labels the line; it is not a quantity.' };
        case 'unit_price':
            return { kind: 'non_additive', nature: 'unit_value', rationale: 'A price per unit; summing prices across rows is not meaningful.' };
        case 'open_amount':
            return { kind: 'additive', nature: 'flow', rationale: 'The open value of each document line; lines add up across customers.' };
        case 'line_quantity':
            return { kind: 'additive', nature: 'flow', rationale: 'A quantity on each document line; lines add up.' };
        default:
            return null;
    }
};

/** Leaf priors for every column of a table, keyed by column name; columns without a prior are absent. */
export const inferLeafAdditivityForColumns = (columnNames: readonly string[]): Record<string, ColumnAdditivity> => {
    const result: Record<string, ColumnAdditivity> = {};
    for (const name of columnNames) {
        const prior = inferLeafAdditivity(name, columnNames);
        if (prior) result[name] = prior;
    }
    return result;
};

/** Whether the leaf names a money amount (rather than a count or a quantity). Unit prices are not money totals. */
export const isMoneyMeasureName = (columnName: string, siblingNames: readonly string[] = []): boolean => {
    const kind = classifyMeasureLeaf(columnName, siblingNames);
    if (kind === 'open_amount') return true;
    if (kind !== null) return false;
    const { layers, leaf } = splitColumnLayers(columnName);
    const words = normalizeWords(leaf);
    if (/(^| )(per|rate|ratio|avg|average|margin|pct|percent|index|score)( |$)/.test(words)) return false;
    if (QUANTITY_LAYER.test(normalizeWords(layers[0] ?? ''))) return false;
    return MONEY_LEAF.test(words);
};

// The parties and things a business compares: who owes, who buys, what sells.
const BUSINESS_ENTITY_LEAF = /(^| )(customer|client|debtor|creditor|supplier|vendor|buyer|seller|party|account|company|branch|region|department|salesperson|sales rep|agent|product|item|category|segment|channel|project)s?( |$)/;

/** Whether the leaf names a business entity a reader would rank (a customer, a supplier, a product). */
export const isBusinessEntityName = (columnName: string): boolean =>
    BUSINESS_ENTITY_LEAF.test(normalizeWords(splitColumnLayers(columnName).leaf));
