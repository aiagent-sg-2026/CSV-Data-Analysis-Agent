import type { ReportIntakeIr } from '../../types/intake';
import type {
    HeaderAlignmentCandidateV1, HeaderAlignmentCell, HeaderAlignmentResult, HeaderAlignmentValidation,
} from '../../types/headerAlignment';
import { sha256Bytes } from '../data/sourceDigest';

// Refuse oversized inputs rather than sample the fingerprint or silently truncate evidence.
const MAX_ROWS = 100_000;
const MAX_COLUMNS = 1024;
const MAX_CELLS = 2_000_000;
const MAX_CHARACTERS = 16_000_000;
const MAX_HEADER_SCAN = 128;
const MAX_CANDIDATES = 32;
const MAX_PERIOD = 128;

interface Cell { columnIndex: number; value: string }
const occupied = (row: string[]): Cell[] => {
    const cells: Cell[] = [];
    row.forEach((value, columnIndex) => {
        if (value.trim()) cells.push({ columnIndex, value: value.trim() });
    });
    return cells;
};

/** Find exact repetitions, not a semantic classification of the labels. */
const repeatedPeriod = (cells: Cell[]): number | null => {
    for (let period = 2; period <= Math.min(MAX_PERIOD, cells.length / 2); period += 1) {
        if (cells.length % period !== 0 || new Set(cells.slice(0, period).map(cell => cell.value)).size !== period) continue;
        if (cells.every((cell, index) => cell.value === cells[index % period].value)) return period;
    }
    return null;
};

const ref = (rowIndex: number, cell: Cell): HeaderAlignmentCell => ({ rowIndex, columnIndex: cell.columnIndex });

/**
 * Proposes alignments from exact repeated patterns and observed row widths alone.
 * Paths are references into rawRows, not reconstructed names. A reviewer must resolve
 * and interpret them; even an exact structural match is never an approval.
 */
export const solveHeaderAlignment = async (intake: ReportIntakeIr): Promise<HeaderAlignmentResult> => {
    const unsupported = (reason: string): HeaderAlignmentResult => ({ status: 'unsupported', candidates: [], ambiguities: [reason] });
    try {
        if (!intake || !Array.isArray(intake.rawRows) || !Number.isSafeInteger(intake.columnCount)
            || intake.columnCount < 0 || intake.columnCount > MAX_COLUMNS || intake.rawRows.length > MAX_ROWS) return unsupported('invalid_or_oversized_input');
        const rows = intake.rawRows;
        let cellCount = 0;
        let characters = 0;
        for (const row of rows) {
            if (!Array.isArray(row) || row.length > MAX_COLUMNS) return unsupported('invalid_or_oversized_input');
            cellCount += row.length;
            if (cellCount > MAX_CELLS) return unsupported('input_limit_exceeded');
            for (const cell of row) {
                if (typeof cell !== 'string') return unsupported('invalid_or_oversized_input');
                characters += cell.length;
                if (characters > MAX_CHARACTERS) return unsupported('input_limit_exceeded');
            }
        }
        // JSON encodes row lengths, cell boundaries, escaping and declared width unambiguously.
        const fingerprint = await sha256Bytes(new TextEncoder().encode(JSON.stringify([intake.columnCount, rows])));
        const sourceWidths = rows.map(row => row.length);
        const candidates: HeaderAlignmentCandidateV1[] = [];
        let truncated = false;
        const scanEnd = Math.min(rows.length, MAX_HEADER_SCAN);
        for (let leafIndex = 1; leafIndex < scanEnd; leafIndex += 1) {
            const leaf = occupied(rows[leafIndex]);
            if (leaf.length !== rows[leafIndex].length) continue;
            const leafPeriod = repeatedPeriod(leaf);
            if (leafPeriod === null) continue;
            const groupCount = leaf.length / leafPeriod;
            if (groupCount < 2 || groupCount > MAX_PERIOD) continue;
            // Adjacent non-empty header bands, allowing intervening blank rows only.
            let upperIndex = leafIndex - 1;
            while (upperIndex >= 0 && occupied(rows[upperIndex]).length === 0) upperIndex -= 1;
            if (upperIndex < 0) continue;
            const upper = occupied(rows[upperIndex]);
            if (upper.length !== rows[upperIndex].length || upper.length < groupCount * 2) continue;
            // The body must be a contiguous run of at least two equal-width rows.
            // No provisional boundary is trusted over this raw structural evidence.
            let bodyStart = leafIndex + 1;
            while (bodyStart < rows.length && rows[bodyStart].every(cell => !cell.trim())) bodyStart += 1;
            if (bodyStart + 1 >= rows.length) continue;
            const bodyWidth = rows[bodyStart].length;
            if (bodyWidth !== upper.length + groupCount * (leafPeriod - 1) || bodyWidth > MAX_COLUMNS
                || rows[bodyStart + 1].length !== bodyWidth
                || !rows[bodyStart].some(cell => cell.trim())
                || !rows[bodyStart + 1].some(cell => cell.trim())) continue;
            let bodyEnd = bodyStart + 2;
            while (bodyEnd < rows.length && rows[bodyEnd].length === bodyWidth
                && rows[bodyEnd].some(cell => cell.trim())) bodyEnd += 1;
            for (let prefix = 0; prefix + 2 * groupCount <= upper.length; prefix += 1) {
                // Avoid rotated starts inside a longer repeated run.
                if (prefix > 0 && upper[prefix - 1].value === upper[prefix + groupCount - 1].value) continue;
                const first = upper.slice(prefix, prefix + groupCount);
                if (new Set(first.map(cell => cell.value)).size !== groupCount) continue;
                let repetitions = 1;
                while (prefix + (repetitions + 1) * groupCount <= upper.length
                    && first.every((cell, index) => cell.value === upper[prefix + repetitions * groupCount + index].value)) repetitions += 1;
                if (repetitions < 2) continue;
                for (let selectedGroup = 0; selectedGroup < repetitions; selectedGroup += 1) {
                    const mainStartColumn = prefix + selectedGroup * groupCount;
                    const groupWidth = leafPeriod;
                    const mainEndColumn = mainStartColumn + groupCount * groupWidth;
                    if (candidates.length >= MAX_CANDIDATES) { truncated = true; continue; }
                    const mappings = Array.from({ length: bodyWidth }, (_, targetColumn) => {
                        const headerCells: HeaderAlignmentCell[] = [];
                        if (targetColumn < mainStartColumn) {
                            headerCells.push(ref(upperIndex, upper[targetColumn]));
                        } else if (targetColumn >= mainEndColumn) {
                            headerCells.push(ref(upperIndex, upper[targetColumn - groupCount * (leafPeriod - 1)]));
                        } else {
                            const offset = targetColumn - mainStartColumn;
                            const group = Math.floor(offset / groupWidth);
                            const position = offset % groupWidth;
                            headerCells.push(ref(upperIndex, upper[mainStartColumn + group]));
                            headerCells.push(ref(leafIndex, leaf[group * leafPeriod + position]));
                        }
                        return { targetColumn, headerPath: headerCells };
                    });
                    candidates.push({
                        version: 1, sourceFingerprint: fingerprint, status: 'semantic_review_required', confidence: 'structural',
                        sourceWidths, headerSourceRows: [upperIndex, leafIndex],
                        headerEvidence: { upperRowIndex: upperIndex, leafRowIndex: leafIndex, repeatedGroupCount: repetitions, leafPeriod },
                        bodySourceRows: { start: bodyStart, endExclusive: bodyEnd },
                        summarySourceRows: { start: bodyEnd, endExclusive: rows.length },
                        dataWidth: bodyWidth, shape: 'repeated_groups', grain: 'one_row_per_source_row',
                        mainStartColumn, mainEndColumn, groupCount, groupWidth, mappings,
                        ambiguities: ['semantic_review_required', 'body_boundary_structural_only'],
                    });
                }
            }
        }
        return candidates.length
            ? { status: 'semantic_review_required', candidates, ambiguities: ['semantic_review_required', ...(candidates.length > 1 ? ['multiple_alignments'] : []), ...(truncated ? ['candidate_limit_reached'] : []), ...(rows.length > scanEnd ? ['header_scan_limited'] : [])] }
            : { status: 'no_candidates', candidates: [], ambiguities: rows.length > scanEnd ? ['header_scan_limited'] : [] };
    } catch {
        return unsupported('input_or_fingerprint_unavailable');
    }
};

// Limit untrusted proposals before recursive comparison. Recalculation below
// supplies the actual bounds and coverage proof, not these superficial checks.
const boundedCandidate = (value: unknown): value is HeaderAlignmentCandidateV1 => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    const item = value as HeaderAlignmentCandidateV1;
    const keys = ['version', 'sourceFingerprint', 'status', 'confidence', 'sourceWidths', 'headerSourceRows', 'headerEvidence',
        'bodySourceRows', 'summarySourceRows', 'dataWidth', 'shape', 'grain', 'mainStartColumn',
        'mainEndColumn', 'groupCount', 'groupWidth', 'mappings', 'ambiguities'];
    const scalarKeys = ['version', 'dataWidth', 'mainStartColumn',
        'mainEndColumn', 'groupCount', 'groupWidth'] as const;
    if (Object.keys(value).length !== keys.length || Object.keys(value).some(key => !keys.includes(key))
        || scalarKeys.some(key => !Number.isSafeInteger(item[key]))
        || typeof item.sourceFingerprint !== 'string' || item.sourceFingerprint.length !== 64
        || item.status !== 'semantic_review_required' || item.confidence !== 'structural'
        || item.shape !== 'repeated_groups' || item.grain !== 'one_row_per_source_row'
        || !Array.isArray(item.sourceWidths) || item.sourceWidths.length > MAX_ROWS
        || item.sourceWidths.some(width => !Number.isSafeInteger(width))
        || !Array.isArray(item.headerSourceRows) || item.headerSourceRows.length !== 2
        || item.headerSourceRows.some(index => !Number.isSafeInteger(index))
        || ![item.bodySourceRows, item.summarySourceRows].every(range => range && typeof range === 'object'
            && Object.keys(range).length === 2 && Number.isSafeInteger(range.start) && Number.isSafeInteger(range.endExclusive))
        || !item.headerEvidence || typeof item.headerEvidence !== 'object'
        || Object.keys(item.headerEvidence).length !== 4
        || !['upperRowIndex', 'leafRowIndex', 'repeatedGroupCount', 'leafPeriod']
            .every(key => Number.isSafeInteger(item.headerEvidence[key as keyof typeof item.headerEvidence]))
        || !Array.isArray(item.ambiguities) || item.ambiguities.length > 8
        || item.ambiguities.some(code => typeof code !== 'string' || code.length > 80)
        || !Array.isArray(item.mappings) || item.mappings.length > MAX_COLUMNS) return false;
    return item.mappings.every(mapping => mapping && typeof mapping === 'object'
        && Object.keys(mapping).length === 2 && Number.isSafeInteger(mapping.targetColumn)
        && Array.isArray(mapping.headerPath) && mapping.headerPath.length <= 2
        && mapping.headerPath.every(cell => cell && typeof cell === 'object'
            && Object.keys(cell).length === 2 && Number.isSafeInteger(cell.rowIndex)
            && Number.isSafeInteger(cell.columnIndex)));
};

// Canonical comparison rejects extra, omitted, or changed fields independently of key order.
const canonical = (value: unknown): string => {
    if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'undefined';
    if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
    const object = value as Record<string, unknown>;
    return `{${Object.keys(object).sort().map(key => `${JSON.stringify(key)}:${canonical(object[key])}`).join(',')}}`;
};

/** Recompute from authoritative raw evidence; supplied alternatives cannot grant authority. */
export const validateHeaderAlignment = async (
    intake: ReportIntakeIr,
    candidate: HeaderAlignmentCandidateV1,
    alternatives?: HeaderAlignmentCandidateV1[],
): Promise<HeaderAlignmentValidation> => {
    try {
        if (!boundedCandidate(candidate) || (alternatives !== undefined
            && (!Array.isArray(alternatives) || alternatives.length > MAX_CANDIDATES || !alternatives.every(boundedCandidate)))) {
            return { valid: false, status: 'invalid', issues: ['invalid_input'] };
        }
        const result = await solveHeaderAlignment(intake);
        if (result.status !== 'semantic_review_required') return { valid: false, status: 'invalid', issues: ['no_authoritative_candidate'] };
        const encoded = canonical(candidate);
        if (!result.candidates.some(item => canonical(item) === encoded)) return { valid: false, status: 'invalid', issues: ['candidate_mismatch'] };
        if (alternatives !== undefined) {
            if (!Array.isArray(alternatives) || alternatives.length > MAX_CANDIDATES) return { valid: false, status: 'invalid', issues: ['alternatives_mismatch'] };
            const expected = result.candidates.filter(item => canonical(item) !== encoded).map(canonical).sort();
            const received = alternatives.map(canonical).sort();
            if (canonical(received) !== canonical(expected)) return { valid: false, status: 'invalid', issues: ['alternatives_mismatch'] };
        }
        return { valid: true, status: 'semantic_review_required', issues: ['semantic_review_required'] };
    } catch {
        return { valid: false, status: 'invalid', issues: ['invalid_input'] };
    }
};
