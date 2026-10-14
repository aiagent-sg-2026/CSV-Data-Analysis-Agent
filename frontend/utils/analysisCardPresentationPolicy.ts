import type { AnalysisCardData, AnalysisPlan } from '../types';

/** The host's evidence verdict takes precedence over the proposed chart bindings. */
export const resolveCardPresentationPlan = (
    card: Pick<AnalysisCardData, 'plan' | 'evidenceValueGate'>,
): AnalysisPlan => {
    if (card.evidenceValueGate?.decision !== 'table_only') return card.plan;
    if (card.plan.presentationMode === 'table' && card.plan.defaultDataVisible === true) return card.plan;
    return { ...card.plan, presentationMode: 'table', defaultDataVisible: true };
};

export const isTableOnlyPresentation = (plan: AnalysisPlan): boolean =>
    plan.presentationMode === 'table' || plan.artifactMetadata?.tableOnlyPresentation === true;

export const shouldHideCardChart = (plan: AnalysisPlan): boolean =>
    isTableOnlyPresentation(plan) || plan.artifactMetadata?.hideChartByDefault === true;
