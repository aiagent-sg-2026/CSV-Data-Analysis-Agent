import type { AnalysisPlan, CardContext } from '../../types';
import {
    resolveColumnDisplayLabel,
    resolveDisplayPlanDescription,
    resolveDisplayPlanTitle,
    resolvePlanGroupLabel,
    resolvePlanMetricLabel,
} from './businessLabelResolver';

export type DisplayPlanSource = Pick<AnalysisPlan, 'title' | 'description' | 'groupByColumn' | 'valueColumn' | 'aggregation' | 'periodSeries'>;

export const resolveDisplayPlanLabels = <T extends DisplayPlanSource>(
    plan: T,
    plans: DisplayPlanSource[] = [plan],
): T => ({
    ...plan,
    title: resolveDisplayPlanTitle(plan),
    description: resolveDisplayPlanDescription(plan),
    // Labels of a period-series card come from its own series and grain, not from other cards' columns.
    groupByColumn: plan.groupByColumn
        ? plan.periodSeries ? resolvePlanGroupLabel(plan) : resolveColumnDisplayLabel(plan.groupByColumn, plans)
        : plan.groupByColumn,
    valueColumn: plan.valueColumn
        ? (plan.periodSeries ? resolvePlanMetricLabel(plan) : null) ?? resolveColumnDisplayLabel(plan.valueColumn, plans)
        : plan.valueColumn,
});

export const buildDisplayCardContext = (cardContext: CardContext[]): CardContext[] => {
    const plans = cardContext.map(card => ({
        title: card.title,
        description: card.description ?? '',
        groupByColumn: card.groupByColumn,
        valueColumn: card.valueColumn,
    }));

    return cardContext.map(card => {
        const displayPlan = resolveDisplayPlanLabels({
            title: card.title,
            description: card.description ?? '',
            groupByColumn: card.groupByColumn,
            valueColumn: card.valueColumn,
            aggregation: card.aggregation,
            periodSeries: card.periodSeries,
        }, plans);

        return {
            ...card,
            title: displayPlan.title,
            description: displayPlan.description,
            groupByColumn: displayPlan.groupByColumn,
            valueColumn: displayPlan.valueColumn,
        };
    });
};
