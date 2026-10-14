import { useEffect, useState } from 'react';
import type { ClarificationRequest } from '../../types';
import { useAppStore } from '../../store/useAppStore';
import { inspectPiCandidateReview } from '../../services/agent/runtime/pi/piCandidateReviewState';

/** Expiry refreshes disclosure only; every click still rechecks the live host registry. */
export const useCandidateReview = (request?: ClarificationRequest | null) => {
    const [, refresh] = useState(0);
    const result = request?.resumeContext?.piCandidateApproval ? inspectPiCandidateReview(useAppStore, request) : null;
    const expiresAt = result?.review?.expiresAt;
    useEffect(() => {
        if (!expiresAt || expiresAt <= Date.now()) return;
        const timer = setTimeout(() => refresh(value => value + 1), expiresAt - Date.now() + 1);
        return () => clearTimeout(timer);
    }, [expiresAt]);
    return result;
};
