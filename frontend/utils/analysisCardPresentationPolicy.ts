import type { AnalysisCardData, AnalysisPlan } from '../types';

/** The host's evidence verdict takes precedence over the proposed chart bindings. */
export const resolveCardPresentationPlan = (
    card: Pick<AnalysisCardData, 'plan' | 'evidenceValueGate'> & Partial<Pick<AnalysisCardData, 'provenance'>>,
): AnalysisPlan => {
    // A column that failed the numeric parse reconciliation is shown as a table only:
    // no chart or headline figure built from numbers we could not read consistently.
    const tableOnly = card.evidenceValueGate?.decision === 'table_only'
        || Boolean(card.provenance?.numericParseMismatch?.columns.length);
    if (!tableOnly) return card.plan;
    if (card.plan.presentationMode === 'table' && card.plan.defaultDataVisible === true) return card.plan;
    return { ...card.plan, presentationMode: 'table', defaultDataVisible: true };
};

export const isTableOnlyPresentation = (plan: AnalysisPlan): boolean =>
    plan.presentationMode === 'table' || plan.artifactMetadata?.tableOnlyPresentation === true;

export const shouldHideCardChart = (plan: AnalysisPlan): boolean =>
    isTableOnlyPresentation(plan) || plan.artifactMetadata?.hideChartByDefault === true;
