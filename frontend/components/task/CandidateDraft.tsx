import React, { useState } from 'react';
import { useAppStore } from '../../store/useAppStore';
import { readTaskCandidateDraft } from '../../services/agent/runtime/pi/piTaskInspection';

/** An explicit local read. No network, accepted query, mutation or approval API is available here. */
export const CandidateDraft: React.FC<{ taskId: string; candidateId: string; table: string; digest: string }> = props => {
    const [page, setPage] = useState<Awaited<ReturnType<typeof readTaskCandidateDraft>> | null>(null);
    const [error, setError] = useState(''), [busy, setBusy] = useState(false);
    const load = async (offset: number) => {
        setBusy(true); setError(''); setPage(null);
        try { setPage(await readTaskCandidateDraft(useAppStore, props.taskId, props.candidateId, props.table, props.digest, offset)); }
        catch (error) { setError(error instanceof Error ? error.message : 'candidate_draft_unavailable'); }
        finally { setBusy(false); }
    };
    return <section aria-label="Validated candidate draft" className="space-y-2">
        <h4 className="font-medium">Validated Draft / Uncommitted — {props.table}</h4>
        <p>Read-only local preview. Not accepted data or answer evidence. Reload requires fresh host validation.</p>
        <button type="button" disabled={busy} onClick={() => void load(0)} className="min-h-[44px] rounded border px-3">Read draft from start</button>
        {error && <p role="alert">Draft unavailable: {error}</p>}
        {page && <><p>Rows {page.offset + 1}–{page.offset + page.rows.length} / {page.totalRows}</p>
            <pre className="max-w-full whitespace-pre-wrap break-all text-xs" aria-label="Draft rows">{JSON.stringify(page.rows, null, 2)}</pre>
            <button type="button" disabled={busy || !page.truncated} onClick={() => void load(page.offset + page.rows.length)} className="min-h-[44px] rounded border px-3">Next draft rows</button></>}
    </section>;
};
