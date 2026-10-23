import type { IntakeSetAsideSection, ReportBoundary } from '../types';
import { getTranslation } from './localization';

/** Row counts of the stacked tables that were set aside, in file order. */
export const getSetAsideRowCounts = (
    sections: readonly Pick<IntakeSetAsideSection, 'rowCount'>[] | null | undefined,
): number[] => (sections ?? []).map(section => section.rowCount);

/**
 * The stacked tables that are still set aside. The stored intake keeps every table it
 * found; a boundary the user confirmed with a later summary start (or none) has taken
 * the rows of the tables above that start back as data, so they are no longer set aside.
 */
export const getActiveSetAsideSections = (
    sections: readonly IntakeSetAsideSection[] | null | undefined,
    humanBoundary: Pick<ReportBoundary, 'summaryStartIndex'> | null | undefined,
): IntakeSetAsideSection[] => {
    if (!sections?.length) return [];
    if (!humanBoundary) return [...sections];
    const summaryStart = humanBoundary.summaryStartIndex;
    return summaryStart === null ? [] : sections.filter(section => section.rowStart >= summaryStart);
};

const usesIdeographicList = (language: string) => language === 'Mandarin' || language === 'Japanese';

/** "700 and 900 rows", "700, 800 and 900 rows" or "1 row", in the user's language. */
export const formatSetAsideRowCounts = (counts: readonly number[], language: string): string => {
    const numbers = counts.map(count => count.toLocaleString());
    const and = getTranslation('review_list_and', language);
    const ideographic = usesIdeographicList(language);
    const head = numbers.slice(0, -1).join(ideographic ? '、' : ', ');
    const last = numbers[numbers.length - 1] ?? '0';
    const rows = numbers.length <= 1
        ? last
        : ideographic ? `${head}${and}${last}` : `${head} ${and} ${last}`;
    const isSingleRow = counts.length === 1 && counts[0] === 1;
    return getTranslation(isSingleRow ? 'review_set_aside_rows_one' : 'review_set_aside_rows_many', language, { rows });
};

/** The persistent report line: "2 other tables in the file were set aside (700 and 900 rows)". */
export const describeSetAsideTables = (counts: readonly number[], language: string): string | null => {
    if (counts.length === 0) return null;
    return getTranslation(
        counts.length === 1 ? 'report_set_aside_note_one' : 'report_set_aside_note_many',
        language,
        { count: counts.length, rows: formatSetAsideRowCounts(counts, language) },
    );
};
