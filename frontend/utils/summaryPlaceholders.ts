/**
 * Status texts the summary generators return when no AI summary exists. They
 * report that nothing was generated, so they are not findings and must never
 * be presented under an evidence badge.
 */
export const SUMMARY_PLACEHOLDER_TEXTS = {
    disabled: 'AI Summaries are disabled. No API Key provided.',
    emptyCard: 'No summary generated.',
    emptyFinal: 'No final summary generated.',
    failedFinal: 'Failed to generate the final AI summary.',
} as const;

const PLACEHOLDER_SET = new Set<string>(Object.values(SUMMARY_PLACEHOLDER_TEXTS));

/** True for an empty summary or one of the status texts above, including ones restored from saved sessions. */
export const isPlaceholderSummaryText = (text: string | null | undefined): boolean => {
    const trimmed = (text ?? '').trim();
    return trimmed === '' || PLACEHOLDER_SET.has(trimmed);
};
