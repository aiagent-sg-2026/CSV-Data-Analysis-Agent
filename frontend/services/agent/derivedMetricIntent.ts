const DERIVED_MARGIN_REQUEST = /\b(?:profit|gross)\s+margin\b|利润率|利潤率|利益率|粗利率|margin\s*(?:percentage|%)/i;
const DERIVED_COST_PER_RESULT_REQUEST = /\bcost\s+per\s+result\b|每(?:个|個|次)结果成本|每(?:个|個|次)結果成本|結果単価|結果あたりのコスト/i;
const SHARE_OF_TOTAL_REQUEST = /(?:\b(?:percent(?:age)?|share|proportion)\b[\s\S]{0,80}\b(?:overall|total|whole|full dataset)\b)|(?:\b(?:overall|total|whole|full dataset)\b[\s\S]{0,80}\b(?:percent(?:age)?|share|proportion|represent)\b)|(?:百分比|占比|比例|比率).{0,40}(?:总额|總額|总体|總體|全部|合计|合計)|(?:总额|總額|总体|總體|全部|合计|合計).{0,40}(?:百分比|占比|比例|比率)|(?:全体|合計).{0,40}(?:割合|比率|パーセント)|(?:割合|比率|パーセント).{0,40}(?:全体|合計)/i;

export const isDerivedMarginRequest = (message: string): boolean =>
    DERIVED_MARGIN_REQUEST.test(message);

export const isDerivedCostPerResultRequest = (message: string): boolean =>
    DERIVED_COST_PER_RESULT_REQUEST.test(message);

export const isShareOfTotalRequest = (message: string): boolean =>
    SHARE_OF_TOTAL_REQUEST.test(message);

export const requiresCompleteDerivedMetricEvidence = (message: string): boolean =>
    isDerivedMarginRequest(message) || isDerivedCostPerResultRequest(message);

export const requiresCompleteAggregateEvidence = (message: string): boolean =>
    requiresCompleteDerivedMetricEvidence(message) || isShareOfTotalRequest(message);

const NUMBER_WORDS: Record<string, number> = {
    one: 1, two: 2, three: 3, four: 4, five: 5,
    six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
};
const LOWEST = /\b(?:lowest|smallest|minimum|cheapest|bottom)\b|最低|最小|最少|低い|下位|terendah|termurah/i;
const HIGHEST = /\b(?:highest|largest|maximum|top)\b|最高|最大|最多|上位|最も高い|tertinggi|teratas/i;
const RANK_COUNT = [
    /\b(?:top|bottom|lowest|highest|smallest|largest)\s+(\d{1,2})\b/i,
    /(?:最低|最高|最小|最大|最少|最多)\s*(?:的)?\s*(\d{1,2})\s*(?:名|个|個|项|項|家)?/,
    /(?:前|上位|下位)\s*(\d{1,2})/,
    /(?:teratas|tertinggi|terendah|termurah)\s*(\d{1,2})/i,
];

/** One interpretation for all deterministic derived rankings; each metric retains its default direction. */
export const resolveDerivedRankingRequest = (message: string): {
    direction: 'asc' | 'desc' | null;
    limit: number | null;
} => {
    const direction = LOWEST.test(message) ? 'asc' : HIGHEST.test(message) ? 'desc' : null;
    for (const pattern of RANK_COUNT) {
        const matched = message.match(pattern);
        const count = matched ? Number(matched[1]) : null;
        if (count !== null && count > 0 && count <= 25) return { direction, limit: count };
    }
    const words = Object.keys(NUMBER_WORDS).join('|');
    const matched = message.match(new RegExp(`(?:\\b(?:top|bottom|lowest|highest)\\s+(${words})\\b|\\b(${words})\\s+(?:lowest|highest|smallest|largest)\\b)`, 'i'));
    return { direction, limit: matched ? NUMBER_WORDS[(matched[1] ?? matched[2]).toLowerCase()] : null };
};
