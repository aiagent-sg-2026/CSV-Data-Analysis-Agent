import type {
    AnalysisCardData,
    CardTrustDecision,
    CardTrustReasonCode,
} from '../../types';
import { resolveAnalysisArtifactFreshness } from './artifactProvenance';

const formatNumber = (value: number | null) => (value === null ? 'n/a' : String(Math.round(value * 100) / 100));

const describeNumericParseMismatch = (provenance: NonNullable<AnalysisCardData['provenance']>): string =>
    (provenance.numericParseMismatch?.findings ?? [])
        .map(finding => `${finding.column} (${finding.kind}): original text ${formatNumber(finding.kind === 'sum' ? finding.sourceSum : finding.sourceMedian)}, loaded ${formatNumber(finding.kind === 'sum' ? finding.loadedSum : finding.loadedMedian)}${finding.ratio === null ? '' : `, ratio ${finding.ratio.toPrecision(4)}`}`)
        .join('; ');

const buildDetail = (reasonCodes: CardTrustReasonCode[], extra?: string | null): string => {
    const base = reasonCodes.length > 0 ? reasonCodes.join(' | ') : 'verified';
    return extra ? `${base} — ${extra}` : base;
};

export const resolveCardTrustDecision = (
    card: Pick<AnalysisCardData, 'autoAnalysisEvaluation' | 'provenance'>,
    currentDatasetVersion: string | null | undefined,
): CardTrustDecision => {
    const reasonCodes: CardTrustReasonCode[] = [];
    const provenance = card.provenance;
    const autoVerdict = card.autoAnalysisEvaluation?.verdict ?? null;

    if (autoVerdict === 'weak') {
        reasonCodes.push('quality_weak');
        return {
            status: 'weak',
            reasonCodes,
            detail: buildDetail(reasonCodes),
        };
    }

    if (!provenance) {
        reasonCodes.push('provenance_missing');
    } else {
        const freshness = resolveAnalysisArtifactFreshness(provenance, currentDatasetVersion);
        if (freshness === 'stale') {
            reasonCodes.push('dataset_stale');
            return {
                status: 'stale',
                reasonCodes,
                detail: buildDetail(reasonCodes),
            };
        }
        if (freshness === 'unverified') {
            reasonCodes.push('dataset_version_missing');
        }
        if (provenance.numericParseMismatch?.columns.length) {
            // Two independent readings of a column this card aggregates disagree.
            reasonCodes.push('numeric_parse_mismatch');
        } else if (provenance.evidenceStatus === 'hypothesis') {
            reasonCodes.push('evidence_hypothesis');
        }
        if (provenance.queryEvidenceRequired === true && !provenance.queryEvidence?.traceId) {
            reasonCodes.push('query_trace_missing');
        }
    }

    if (!autoVerdict) {
        reasonCodes.push('quality_evaluation_missing');
    }

    if (reasonCodes.length > 0) {
        return {
            status: 'unverified',
            reasonCodes,
            detail: buildDetail(reasonCodes, provenance && reasonCodes.includes('numeric_parse_mismatch') ? describeNumericParseMismatch(provenance) : null),
        };
    }

    if (provenance?.evidenceStatus === 'degraded' || autoVerdict === 'caveated') {
        if (provenance.evidenceStatus === 'degraded') {
            reasonCodes.push('evidence_degraded');
        }
        if (autoVerdict === 'caveated') {
            reasonCodes.push('quality_caveat');
        }
        return {
            status: 'caveated',
            reasonCodes,
            detail: buildDetail(reasonCodes),
        };
    }

    return {
        status: 'verified',
        reasonCodes: [],
        detail: 'verified',
    };
};
