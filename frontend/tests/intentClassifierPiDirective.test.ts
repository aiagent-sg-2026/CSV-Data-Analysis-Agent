// @vitest-environment node

import { describe, expect, it, vi } from 'vitest';

const { streamTextMock } = vi.hoisted(() => ({
    streamTextMock: vi.fn(() => ({
        fullStream: (async function* () {})(),
        text: Promise.resolve('batch_analysis'),
        finishReason: Promise.resolve('stop'),
    })),
}));

vi.mock('ai', () => ({ streamText: streamTextMock, generateText: vi.fn() }));
vi.mock('../services/ai/providerConfig', () => ({
    isProviderConfigured: () => true,
    createProviderModel: () => ({ model: {}, modelId: 'test-model' }),
    createFallbackProviderModel: () => null,
}));

import { classifyChatIntent } from '../services/agent/runtime/intentClassifier';

describe('Pi follow-up intent directive', () => {
    it.each(['lower_weighted_median','weighted_mean'])('retains an explicit repair output alongside %s',async method=>{
        const artifact={intent:'precise_card',confidence:'high',taskSignal:'statistical',expectedOutput:'scalar_answer',
            referencedColumns:['Amount','Quantity'],aggregationFunctions:[],groupingColumns:[],filterDescription:null,
            requestedDataPreparation:'canonical_fact_table',requestedComputationScope:{method,value:'Amount',weight:'Quantity',
                missingPolicy:'pairwise_complete',weightPolicy:'nonnegative_integer_frequency',seed:'none'},
            subjectRefs:[],timeScope:{kind:'none'},comparisonScope:{kind:'none'},unresolvedReferences:[],reason:'Repair then compute.'};
        streamTextMock.mockReturnValueOnce({fullStream:(async function*(){})(),text:Promise.resolve(JSON.stringify(artifact)),finishReason:Promise.resolve('stop')});
        const directive=await classifyChatIntent(`Publish the canonical fact table, then calculate its ${method}.`,{provider:'default'} as never,true);
        expect(directive.artifact).toMatchObject({requestedDataPreparation:'canonical_fact_table',requestedComputationScope:artifact.requestedComputationScope,unresolvedReferences:[]});
        streamTextMock.mockClear();
    });
    it('keeps batch intent without choosing a separate runner', async () => {
        const directive = await classifyChatIntent(
            'Analyze this dataset from several angles.',
            { provider: 'openai' } as never,
            true,
        );

        expect(directive.findings.intent).toBe('batch_analysis');
        expect(directive).not.toHaveProperty('target');
        expect(streamTextMock).toHaveBeenCalledOnce();
    });

    it('retains conversation findings when no dataset is loaded', async () => {
        const directive = await classifyChatIntent(
            'Hello',
            { provider: 'openai' } as never,
            false,
        );

        expect(directive.findings.intent).toBe('conversation');
        expect(directive).not.toHaveProperty('target');
    });
});
