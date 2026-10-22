import { contentText, type Api, type Model, type Models } from '@earendil-works/pi-ai';
import {
    convertToLlm, estimateContextTokens, estimateTokens, serializeConversation,
    type AgentMessage,
} from '@earendil-works/pi-agent-core';
import {
    PI_CONTEXT_COMPACTION_KEEP_RECENT_TOKENS,
    PI_CONTEXT_COMPACTION_TRIGGER_RATIO,
} from '../../../../config/agentDefaults';

type SummarizeHistory = (messages: AgentMessage[], signal?: AbortSignal) => Promise<string>;

/** Reported when compaction was needed but could not shrink the history. */
export interface PiCompactionDegradation {
    /** `summary_truncated`: the summary was cut to the byte cap and the compaction was kept. */
    reason: 'summary_failed' | 'summary_unusable' | 'summary_truncated' | 'compaction_ineffective';
    error: unknown;
    estimatedTokens: number;
    /** Estimated serialized request bytes; present only when a request byte budget applies. */
    estimatedBytes?: number;
}

type OnCompactionDegraded = (degradation: PiCompactionDegradation) => void;

/**
 * Serialized-size limit for providers whose gateway rejects large request bodies regardless of
 * the model context window (the Default demo gateway). All values are UTF-8 bytes.
 */
export interface PiRequestByteBudget {
    /** Largest request body to send, including the tool declarations. */
    maxRequestBytes: number;
    /** Request fields outside the transcript that the estimate cannot see. */
    overheadBytes: number;
    /** Recent history kept verbatim after compaction. */
    keepRecentBytes: number;
    /** Largest accepted summary, JSON-escaped as it is sent. */
    summaryMaxBytes: number;
}

export interface PiContextCompactorOptions {
    requestByteBudget?: PiRequestByteBudget;
}

const SUMMARY_MAX_CHARS = 20_000;
// After a failed or ineffective attempt, wait for this fraction of the budget in growth.
const RETRY_GROWTH_RATIO = 0.05;
const SUMMARY_SYSTEM_PROMPT = 'Summarize earlier Pi agent history for continuation. Preserve the user goal, dataset identity, completed tool results, decisions, and outstanding work. Never invent evidence or include credentials. Keep the summary concise.';

const utf8 = new TextEncoder();
const utf8Bytes = (text: string): number => utf8.encode(text).length;
// Text travels as a JSON string inside the request body, so measure it escaped.
const jsonStringBytes = (text: string): number => utf8Bytes(JSON.stringify(text));

/**
 * The summarizer instruction. Under a byte budget it also asks for a summary that fits the
 * byte cap; one character per three bytes is safe for CJK text, which is 3 bytes per character.
 */
export const piSummarySystemPrompt = (byteBudget?: PiRequestByteBudget): string => byteBudget
    ? `${SUMMARY_SYSTEM_PROMPT} Keep the summary under ${Math.floor(byteBudget.summaryMaxBytes / 3).toLocaleString('en-US')} characters.`
    : SUMMARY_SYSTEM_PROMPT;

const summaryTooLarge = (summary: string, byteBudget?: PiRequestByteBudget): boolean =>
    summary.length > SUMMARY_MAX_CHARS
    || (byteBudget !== undefined && jsonStringBytes(summary) > byteBudget.summaryMaxBytes);

// Tells the model that the tail (where decisions and outstanding work usually sit) is missing.
export const SUMMARY_TRUNCATED_MARKER = '\n[Summary truncated: later details were omitted. Re-check facts with tools before citing them.]';
// Full-width terminators end a sentence on their own; ASCII ones only before whitespace,
// so a decimal point ("61.5") or a dotted name is not mistaken for a sentence end.
const CJK_SENTENCE_ENDS = new Set(['。', '！', '？']);
const ASCII_SENTENCE_ENDS = new Set(['.', '!', '?']);
const WHITESPACE = /\s/u;

/**
 * Cut a summary so it plus the truncation marker fits `maxBytes` (JSON-escaped UTF-8, as sent).
 * Iterating the string yields whole code points, so a surrogate pair is never split.
 * The cut prefers the last line break or sentence end, so a number or word is not left half
 * written; it falls back to the code-point cut when that boundary would discard more than half
 * of the allowed bytes.
 */
export const truncatePiSummary = (summary: string, maxBytes: number): string => {
    // jsonStringBytes counts the two quotes once for the whole string.
    const available = maxBytes - jsonStringBytes(SUMMARY_TRUNCATED_MARKER);
    let used = 0;
    let kept = '';
    let previous = '';
    let cutShort = false;
    let boundaryLength = 0;
    let boundaryBytes = 0;
    for (const codePoint of summary) {
        const cost = jsonStringBytes(codePoint) - 2;
        if (cost > available - used) {
            cutShort = true;
            break;
        }
        if (codePoint === '\n' || (ASCII_SENTENCE_ENDS.has(previous) && WHITESPACE.test(codePoint))) {
            // End before the separator; the marker supplies its own line break.
            boundaryLength = kept.length;
            boundaryBytes = used;
        }
        kept += codePoint;
        used += cost;
        if (CJK_SENTENCE_ENDS.has(codePoint)) {
            boundaryLength = kept.length;
            boundaryBytes = used;
        }
        previous = codePoint;
    }
    // An ASCII terminator that is the last kept code point counts when the source ends there
    // or continues with whitespace.
    if (cutShort && ASCII_SENTENCE_ENDS.has(previous)) {
        const next = summary.slice(kept.length, kept.length + 1);
        if (WHITESPACE.test(next)) {
            boundaryLength = kept.length;
            boundaryBytes = used;
        }
    }
    const atBoundary = cutShort && boundaryLength > 0 && boundaryBytes * 2 >= available;
    return (atBoundary ? kept.slice(0, boundaryLength) : kept) + SUMMARY_TRUNCATED_MARKER;
};

/**
 * Bytes of the transcript as JSON. The tool declarations travel on system messages
 * (`toolsAdded`), so this counts the tools that the provider adapter sends on every request.
 * Message metadata (usage, timestamps) is not sent, so this slightly overestimates the wire body.
 */
export const estimatePiRequestBytes = (messages: AgentMessage[]): number => utf8Bytes(JSON.stringify(messages));

const estimateVisibleTokens = (value: unknown): number => {
    const serialized = JSON.stringify(value);
    let nonAsciiUnits = 0;
    for (let index = 0; index < serialized.length; index += 1) {
        if (serialized.charCodeAt(index) > 127) nonAsciiUnits += 1;
    }
    return Math.ceil((serialized.length - nonAsciiUnits) / 3 + nonAsciiUnits * 2);
};

const projectedTokens = (messages: AgentMessage[], hasSummary: boolean): number => {
    const visibleTokens = estimateVisibleTokens(messages);
    return hasSummary ? visibleTokens : Math.max(visibleTokens, estimateContextTokens(messages).tokens);
};

/** Compact only completed history; keep the system instruction and recent tool-call pairs. */
export const createPiContextCompactor = (
    contextWindow: number,
    summarize: SummarizeHistory,
    onDegraded?: OnCompactionDegraded,
    options: PiContextCompactorOptions = {},
) => {
    if (!Number.isFinite(contextWindow) || contextWindow <= 0) {
        throw new Error('Pi requires a known context window for automatic compaction.');
    }
    const byteBudget = options.requestByteBudget;
    const triggerTokens = Math.floor(contextWindow * PI_CONTEXT_COMPACTION_TRIGGER_RATIO);
    const triggerBytes = byteBudget ? byteBudget.maxRequestBytes - byteBudget.overheadBytes : Infinity;
    let summary = '';
    let summarizedThrough = 1;
    let summaryTimestamp = 0;
    // After a failed or ineffective attempt, retrying on every provider turn only
    // repeats a slow summary call. Wait until the history has grown noticeably.
    let retryAboveTokens = 0;
    let retryAboveBytes = 0;
    const retryGrowthTokens = Math.floor(contextWindow * RETRY_GROWTH_RATIO);
    const retryGrowthBytes = byteBudget ? Math.floor(byteBudget.maxRequestBytes * RETRY_GROWTH_RATIO) : 0;
    const sizeOf = (messages: AgentMessage[], hasSummary: boolean) => ({
        tokens: projectedTokens(messages, hasSummary),
        bytes: byteBudget ? estimatePiRequestBytes(messages) : 0,
    });
    const overTrigger = (size: { tokens: number; bytes: number }) =>
        size.tokens >= triggerTokens || size.bytes > triggerBytes;
    const report = (
        reason: PiCompactionDegradation['reason'],
        error: unknown,
        size: { tokens: number; bytes: number },
    ) => {
        try {
            onDegraded?.({
                reason, error, estimatedTokens: size.tokens,
                ...(byteBudget ? { estimatedBytes: size.bytes } : {}),
            });
        } catch {
            // Telemetry must never break the Pi turn.
        }
    };
    const degrade = (
        reason: PiCompactionDegradation['reason'],
        error: unknown,
        size: { tokens: number; bytes: number },
    ) => {
        retryAboveTokens = size.tokens + retryGrowthTokens;
        retryAboveBytes = size.bytes + retryGrowthBytes;
        report(reason, error, size);
    };

    return async (messages: AgentMessage[], signal?: AbortSignal): Promise<AgentMessage[]> => {
        if (messages[0]?.role !== 'system') return messages;
        // Agent's default convertToLlm retains user messages but drops custom summary roles.
        const summaryMessage = (text: string, timestamp: number): AgentMessage => ({
            role: 'user', content: [{ type: 'text', text: `Earlier conversation summary:\n${text}` }], timestamp,
        });
        // Later system messages carry tool-set and prompt deltas (pi-agent-core declares tools
        // added after construction this way). The provider derives the request `tools` from
        // them, so they must survive compaction instead of being summarized away.
        // This fix applies to every provider, not only to the Default gateway byte budget.
        const headThrough = (through: number): AgentMessage[] => [
            messages[0],
            ...messages.slice(1, through).filter(message => message.role === 'system'),
        ];
        const head = headThrough(summarizedThrough);
        const summaryCount = summary ? 1 : 0;
        const projected = [
            ...head,
            ...(summary ? [summaryMessage(summary, summaryTimestamp)] : []),
            ...messages.slice(summarizedThrough),
        ];
        const size = sizeOf(projected, Boolean(summary));
        if (!overTrigger(size)) return projected;
        const grownSinceFailure = size.tokens > retryAboveTokens || (byteBudget !== undefined && size.bytes > retryAboveBytes);
        if (!grownSinceFailure) return projected;

        let cut = projected.length;
        let recentTokens = 0;
        let recentBytes = 0;
        while (cut > head.length && recentTokens < PI_CONTEXT_COMPACTION_KEEP_RECENT_TOKENS) {
            const nextTokens = Math.max(
                estimateTokens(projected[cut - 1]),
                estimateVisibleTokens(projected[cut - 1]),
            );
            const nextBytes = byteBudget ? estimatePiRequestBytes([projected[cut - 1]]) : 0;
            const exceedsRecent = recentTokens + nextTokens > PI_CONTEXT_COMPACTION_KEEP_RECENT_TOKENS
                || (byteBudget !== undefined && recentBytes + nextBytes > byteBudget.keepRecentBytes);
            if (recentTokens > 0 && exceedsRecent) break;
            cut -= 1;
            recentTokens += nextTokens;
            recentBytes += nextBytes;
        }
        // Never start the kept history with a tool result: its function_call must stay with it.
        while (cut > head.length && projected[cut].role === 'toolResult') cut -= 1;
        if (cut <= head.length + summaryCount) {
            // Nothing older than the protected recent turn remains. Under a gateway byte bound,
            // report it once so an oversized request is visible before the gateway rejects it.
            if (byteBudget) degrade('compaction_ineffective', new Error('No completed history is left to summarize.'), size);
            return projected;
        }

        try {
            const toSummarize = projected.slice(head.length, cut).filter(message => message.role !== 'system');
            const rawSummary = (await summarize(toSummarize, signal)).trim();
            if (signal?.aborted) return projected;
            if (!rawSummary) {
                degrade('summary_unusable', new Error('Pi summary was empty.'), size);
                return projected;
            }
            const truncated = summaryTooLarge(rawSummary, byteBudget);
            if (truncated && !byteBudget) {
                degrade('summary_unusable', new Error('Pi summary exceeded the size limit.'), size);
                return projected;
            }
            // Under a gateway byte bound, rejecting the summary would leave the history growing
            // until the gateway rejects it, so a shortened summary is kept instead.
            const nextSummary = truncated && byteBudget ? truncatePiSummary(rawSummary, byteBudget.summaryMaxBytes) : rawSummary;
            const reportTruncation = (size: { tokens: number; bytes: number }) => {
                if (truncated) report('summary_truncated', new Error('Pi summary exceeded the byte cap and was truncated.'), size);
            };
            const nextSummarizedThrough = summarizedThrough + cut - head.length - summaryCount;
            const nextTimestamp = Date.now();
            const compacted: AgentMessage[] = [
                ...headThrough(nextSummarizedThrough),
                summaryMessage(nextSummary, nextTimestamp),
                ...messages.slice(nextSummarizedThrough),
            ];
            const compactedSize = sizeOf(compacted, true);
            const commit = () => {
                summary = nextSummary;
                summarizedThrough = nextSummarizedThrough;
                summaryTimestamp = nextTimestamp;
            };
            if (overTrigger(compactedSize)) {
                const error = new Error('Compaction did not bring the history under the trigger.');
                // Under a gateway byte bound a smaller request is still safer than the full one;
                // keep it and report, rather than resending history the gateway may reject.
                if (byteBudget && compactedSize.bytes < size.bytes) {
                    commit();
                    degrade('compaction_ineffective', error, compactedSize);
                    reportTruncation(compactedSize);
                    return compacted;
                }
                degrade('compaction_ineffective', error, size);
                return projected;
            }
            retryAboveTokens = 0;
            retryAboveBytes = 0;
            commit();
            reportTruncation(compactedSize);
            return compacted;
        } catch (error) {
            // Pi's transformContext contract requires a safe fallback on summary failure.
            if (!signal?.aborted) degrade('summary_failed', error, size);
            return projected;
        }
    };
};

const OMITTED_HISTORY_MARKER = '\n\n[... earlier history omitted to fit the summary request size limit ...]\n\n';

/**
 * Trim the serialized history so the summary request fits the byte bound. The start holds the
 * user goal and any earlier summary; the end holds the latest work. The middle is dropped.
 */
export const fitSummaryHistory = (history: string, maxBytes: number): string => {
    const bytes = jsonStringBytes;
    if (bytes(history) <= maxBytes) return history;
    let keepChars = Math.min(history.length, maxBytes);
    let fitted = '';
    do {
        keepChars = Math.floor(keepChars * 0.9);
        const headChars = Math.floor(keepChars * 0.3);
        fitted = history.slice(0, headChars) + OMITTED_HISTORY_MARKER + history.slice(history.length - (keepChars - headChars));
    } while (keepChars > 0 && bytes(fitted) > maxBytes);
    return fitted;
};

export const createPiProviderContextCompactor = (
    model: Model<Api>,
    models: Models,
    apiKey: string,
    providerFetch: typeof fetch | undefined,
    onDegraded?: OnCompactionDegraded,
    options: PiContextCompactorOptions = {},
) => {
    const byteBudget = options.requestByteBudget;
    // The summary request goes to the same gateway, so it must fit the same bound.
    const systemPrompt = piSummarySystemPrompt(byteBudget);
    const maxHistoryBytes = byteBudget
        ? byteBudget.maxRequestBytes - byteBudget.overheadBytes - jsonStringBytes(systemPrompt)
        : Infinity;
    return createPiContextCompactor(model.contextWindow, async (messages, signal) => {
        const serialized = serializeConversation(convertToLlm(messages));
        const history = byteBudget ? fitSummaryHistory(serialized, maxHistoryBytes) : serialized;
        const response = await models.completeSimple(model, {
            systemPrompt,
            messages: [{
                role: 'user',
                content: [{ type: 'text', text: history }],
                timestamp: Date.now(),
            }],
        }, {
            apiKey,
            fetch: providerFetch,
            signal,
            timeoutMs: 45_000,
            maxRetries: 0,
        });
        if (response.stopReason === 'error' || response.stopReason === 'aborted') {
            throw new Error('Pi context summarization failed.');
        }
        return contentText(response.content);
    }, onDegraded, options);
};
