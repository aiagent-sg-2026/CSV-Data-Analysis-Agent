/**
 * Shared result/card creation helpers for analysis skill executors.
 * Split from analysisSkillExecutor.ts for reuse and cohesion.
 */

import type {
    AnalysisArtifactMetadata,
    AnalysisCardData,
    AnalysisPlan,
    AgentObservation,
    CsvRow,
    ToolExecutionResult,
} from '../../../types';
import type { StoreApi } from '../types';
import { createNewCard } from './cardCreator';
import { assessCardSeriesScope } from './cardSeriesScope';
import { resolveSeriesMeasure } from '../planning/seriesMeasureGuard';
import { resolveRowHierarchy } from '../planning/rowHierarchyGuard';
import { createChatMessage } from '../../../utils/messageState';

export const buildBlockedResult = (
    toolName: ToolExecutionResult['toolName'],
    message: string,
    retryHint?: string,
    options?: {
        code?: AgentObservation['code'];
        detail?: Record<string, unknown>;
    },
): ToolExecutionResult => ({
    status: 'blocked',
    toolName,
    message,
    shouldStop: false,
    retryHint,
    observation: {
        type: 'tool_result',
        status: 'blocked',
        summary: message,
        toolName,
        code: options?.code ?? 'validation_failed',
        retryHint,
        detail: options?.detail,
    },
});

export const appendAnalysisMessage = (
    store: StoreApi,
    text: string,
    cardId?: string,
) => {
    store.setState(prev => ({
        chatHistory: [
            ...prev.chatHistory,
            createChatMessage({
                sender: 'ai',
                text,
                timestamp: new Date(),
                type: 'ai_message',
                cardId,
            }),
        ],
    }));
};

export const createAnalysisCard = async ({
    plan,
    data,
    store,
}: {
    plan: AnalysisPlan;
    data: CsvRow[];
    store: StoreApi;
}): Promise<AnalysisCardData> => {
    // Skill results are computed before the card exists, so a melted period
    // table's series check can only caveat them: a cross-series aggregate or a
    // mixed-unit comparison is kept as a table and never verified.
    const seriesScope = assessCardSeriesScope(plan, resolveSeriesMeasure(store.getState()), resolveRowHierarchy(store.getState()));
    const evidenceValueGate = seriesScope.decision === 'reject' ? seriesScope.tableOnlyGate : seriesScope.evidenceValueGate;
    return evidenceValueGate ? createNewCard(plan, data, store, { evidenceValueGate }) : createNewCard(plan, data, store);
};

export const buildSuccessResult = ({
    toolName,
    card,
    message,
    artifactMetadata,
    detail,
}: {
    toolName: ToolExecutionResult['toolName'];
    card: AnalysisCardData;
    message: string;
    artifactMetadata: AnalysisArtifactMetadata;
    detail?: Record<string, unknown>;
}): ToolExecutionResult => ({
    status: 'success',
    toolName,
    message,
    shouldStop: true,
    artifacts: {
        cardId: card.id,
        rowCount: card.aggregatedData.length,
        ...detail,
    },
    artifactMetadata: {
        ...artifactMetadata,
        sourceArtifactIds: [card.id],
    },
    observation: {
        type: 'tool_result',
        status: 'success',
        summary: message,
        toolName,
        detail: {
            cardId: card.id,
            rowCount: card.aggregatedData.length,
            artifactMetadata: {
                ...artifactMetadata,
                sourceArtifactIds: [card.id],
            },
            ...detail,
        },
    },
});
