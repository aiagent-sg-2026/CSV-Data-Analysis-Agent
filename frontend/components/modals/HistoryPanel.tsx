
import React, { useState, useRef, useEffect, useId, useMemo, useCallback } from 'react';
import { shallow } from 'zustand/shallow';
import { useAppStore, AppStore } from '../../store/useAppStore';
import { CURRENT_SESSION_KEY, getStorageBreakdown } from '../../services/storageService';
import { IconClose } from '../../icons/IconClose';
import { getTranslation } from '../../utils/localization';
import { HistoryReportRow, ReportGroup } from './HistoryReportRow';
import { StorageBreakdown } from './StorageBreakdown';
import type { ReportListItem } from '../../types';
import { useDialogAccessibility } from '../../hooks/useDialogAccessibility';

// ── Helpers ───────────────────────────────────────────────────────────

const formatBytes = (bytes: number): string => {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
};

// ── Sorting ────────────────────────────────────────────────────────────

type SortField = 'updatedAt' | 'createdAt' | 'filename';
type SortDirection = 'asc' | 'desc';
type PendingHistoryDeletion =
    | { kind: 'purge'; count: number }
    | { kind: 'report'; id: string; filename: string };
type ReportAction = 'open' | 'pdf';

// ── Grouping logic ─────────────────────────────────────────────────────

function groupReportsByFilename(
    reports: ReportListItem[],
    currentSessionId: string | null,
    sortField: SortField,
    sortDirection: SortDirection,
): ReportGroup[] {
    const groups = new Map<string, ReportListItem[]>();
    for (const report of reports) {
        const key = report.filename;
        const list = groups.get(key) ?? [];
        list.push(report);
        groups.set(key, list);
    }

    return Array.from(groups.values())
        .map(entries => {
            const sorted = entries.sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());
            // If current session is in this group, make it the "latest"
            const currentIdx = sorted.findIndex(r => r.id === currentSessionId);
            const latest = currentIdx >= 0 ? sorted[currentIdx] : sorted[0];
            const older = sorted.filter(r => r.id !== latest.id);
            return {
                filename: latest.filename,
                latest,
                older,
                isCurrent: latest.id === currentSessionId,
            };
        })
        .sort((a, b) => {
            // Current session always first
            if (a.isCurrent) return -1;
            if (b.isCurrent) return 1;
            const dir = sortDirection === 'asc' ? 1 : -1;
            if (sortField === 'filename') {
                return dir * a.filename.localeCompare(b.filename);
            }
            const aDate = new Date(a.latest[sortField]).getTime();
            const bDate = new Date(b.latest[sortField]).getTime();
            return dir * (aDate - bDate);
        });
}

// ── Main component ─────────────────────────────────────────────────────

export const HistoryPanel: React.FC = () => {
    const {
        isOpen, onClose, reports, onLoadReport, onDeleteReport, onPurgeStorage, onOpenReport, onExportPdf,
        onLoadReportsIfNeeded, onReloadReports, currentSessionId, language, hasCsvData,
    } = useAppStore((state: AppStore) => ({
        isOpen: state.isHistoryPanelOpen,
        onClose: () => state.setIsHistoryPanelOpen(false),
        reports: state.reportsList,
        onLoadReportsIfNeeded: state.loadReportsListIfNeeded,
        onReloadReports: state.loadReportsList,
        onLoadReport: state.handleLoadReport,
        onDeleteReport: state.handleDeleteReport,
        onPurgeStorage: state.handlePurgeStorage,
        onOpenReport: state.openPersistedReportArtifact,
        onExportPdf: state.exportPersistedReportPdf,
        currentSessionId: state.sessionId,
        language: state.settings.language,
        hasCsvData: Boolean(state.csvData),
    }), shallow);

    const [search, setSearch] = useState('');
    const [overflowMenuId, setOverflowMenuId] = useState<string | null>(null);
    const [expandedGroup, setExpandedGroup] = useState<string | null>(null);
    const [collapsedSearchGroups, setCollapsedSearchGroups] = useState<Set<string>>(() => new Set());
    const [loadingId, setLoadingId] = useState<string | null>(null);
    const [loadErrorId, setLoadErrorId] = useState<string | null>(null);
    const [reportActionError, setReportActionError] = useState<{ id: string; action: ReportAction } | null>(null);
    const [reportActionBusy, setReportActionBusy] = useState(false);
    const [reportsLoadState, setReportsLoadState] = useState<'idle' | 'loading' | 'ready' | 'error'>('idle');
    const [confirmLoadId, setConfirmLoadId] = useState<string | null>(null);
    const [sortField, setSortField] = useState<SortField>('updatedAt');
    const [sortDirection, setSortDirection] = useState<SortDirection>('desc');
    const [storageInfo, setStorageInfo] = useState<{ idbLabel: string; idbBytes: number } | null>(null);
    const [storageError, setStorageError] = useState(false);
    const [isPurging, setIsPurging] = useState(false);
    const [deletingReportId, setDeletingReportId] = useState<string | null>(null);
    const [pendingDeletion, setPendingDeletion] = useState<PendingHistoryDeletion | null>(null);
    const [deletionError, setDeletionError] = useState<string | null>(null);
    const [showStorageInspector, setShowStorageInspector] = useState(false);
    const overflowRef = useRef<HTMLDivElement>(null);
    const purgeTriggerRef = useRef<HTMLButtonElement>(null);
    const cancelDeletionRef = useRef<HTMLButtonElement>(null);
    const confirmDeletionRef = useRef<HTMLButtonElement>(null);
    const reportsRequestIdRef = useRef(0);
    const deletionTitleId = useId();
    const deletionDescriptionId = useId();
    const dialogRef = useDialogAccessibility<HTMLDivElement>(
        isOpen,
        onClose,
        { restoreFocusSelector: '[data-history-trigger="true"]' },
    );

    const refreshReportsList = useCallback(async (force = false) => {
        const load = force ? onReloadReports : onLoadReportsIfNeeded;
        const requestId = ++reportsRequestIdRef.current;
        if (!load) {
            setReportsLoadState('ready');
            return;
        }
        setReportsLoadState('loading');
        try {
            await load();
            if (requestId === reportsRequestIdRef.current) setReportsLoadState('ready');
        } catch {
            if (requestId === reportsRequestIdRef.current) setReportsLoadState('error');
        }
    }, [onLoadReportsIfNeeded, onReloadReports]);

    useEffect(() => {
        if (isOpen) void refreshReportsList();
        else {
            reportsRequestIdRef.current += 1;
            setReportsLoadState('idle');
        }
    }, [isOpen, refreshReportsList]);

    useEffect(() => {
        if (pendingDeletion) cancelDeletionRef.current?.focus();
    }, [pendingDeletion]);

    useEffect(() => {
        if (!isOpen) {
            setPendingDeletion(null);
            setDeletionError(null);
            setLoadErrorId(null);
            setReportActionError(null);
        }
    }, [isOpen]);

    // Fetch actual IDB storage breakdown when modal opens
    const refreshStorageInfo = async () => {
        setStorageError(false);
        try {
            const breakdown = await getStorageBreakdown();
            setStorageInfo({
                idbLabel: formatBytes(breakdown.totalIdbBytes),
                idbBytes: breakdown.totalIdbBytes,
            });
        } catch {
            setStorageInfo(null);
            setStorageError(true);
        }
    };
    useEffect(() => {
        if (!isOpen) return;
        void refreshStorageInfo();
    }, [isOpen]);

    const dismissDeletion = () => {
        const reportButtons: HTMLButtonElement[] = dialogRef.current
            ? Array.from(dialogRef.current.querySelectorAll<HTMLButtonElement>('[data-history-more-id]'))
            : [];
        const target = pendingDeletion?.kind === 'purge'
            ? purgeTriggerRef.current
            : reportButtons.find(button => button.dataset.historyMoreId === pendingDeletion?.id);
        setPendingDeletion(null);
        setDeletionError(null);
        requestAnimationFrame(() => {
            if (target?.isConnected) target.focus();
            else dialogRef.current?.querySelector<HTMLElement>('[data-dialog-initial-focus]')?.focus();
        });
    };

    const confirmDeletion = async () => {
        if (!pendingDeletion || isPurging || deletingReportId) return;
        const deletion = pendingDeletion;
        setDeletionError(null);
        if (deletion.kind === 'purge') setIsPurging(true);
        else setDeletingReportId(deletion.id);
        try {
            if (deletion.kind === 'purge') {
                await onPurgeStorage();
                await refreshStorageInfo();
            } else {
                await onDeleteReport(deletion.id);
            }
            dismissDeletion();
        } catch {
            setDeletionError(getTranslation('history_delete_failed', language));
        } finally {
            setIsPurging(false);
            setDeletingReportId(null);
        }
    };

    const toggleSort = (field: SortField) => {
        if (sortField === field) {
            setSortDirection(prev => prev === 'desc' ? 'asc' : 'desc');
        } else {
            setSortField(field);
            setSortDirection('desc');
        }
    };

    const handleLoad = (id: string) => {
        if (hasCsvData) {
            setConfirmLoadId(id);
            return;
        }
        void doLoad(id);
    };

    const doLoad = async (id: string) => {
        setConfirmLoadId(null);
        setLoadErrorId(null);
        setLoadingId(id);
        try {
            await onLoadReport(id);
        } catch {
            setLoadErrorId(id);
        } finally {
            setLoadingId(null);
        }
    };

    const runReportAction = async (action: ReportAction, id: string) => {
        if (reportActionBusy) return;
        setReportActionError(null);
        setReportActionBusy(true);
        try {
            const succeeded = action === 'open'
                ? await onOpenReport(id)
                : await onExportPdf(id);
            if (succeeded === false) setReportActionError({ id, action });
        } catch {
            setReportActionError({ id, action });
        } finally {
            setReportActionBusy(false);
        }
    };

    useEffect(() => {
        if (!overflowMenuId) return;
        const handler = (e: MouseEvent) => {
            if (overflowRef.current && !overflowRef.current.contains(e.target as Node)
                && !(e.target instanceof Element && e.target.closest('[data-history-menu]'))) {
                setOverflowMenuId(null);
            }
        };
        document.addEventListener('mousedown', handler);
        return () => document.removeEventListener('mousedown', handler);
    }, [overflowMenuId]);

    const groups = useMemo(
        () => groupReportsByFilename(reports, currentSessionId, sortField, sortDirection),
        [reports, currentSessionId, sortField, sortDirection],
    );

    const searchQuery = search.trim().toLowerCase();
    useEffect(() => {
        setCollapsedSearchGroups(new Set());
    }, [searchQuery]);
    const filteredGroups = useMemo(
        () => groups.filter(g => {
            if (!searchQuery) return true;
            return g.filename.toLowerCase().includes(searchQuery)
                || g.latest.reportTitle?.toLowerCase().includes(searchQuery)
                || g.older.some(entry => entry.reportTitle?.toLowerCase().includes(searchQuery));
        }),
        [groups, searchQuery],
    );

    if (!isOpen) return null;

    const handleDelete = (id: string, filename: string) => {
        setOverflowMenuId(null);
        setPendingDeletion({ kind: 'report', id, filename });
        setDeletionError(null);
    };

    const pad = (n: number) => String(n).padStart(2, '0');
    const fmtStd = (date: Date | string): string => {
        const d = new Date(date);
        return `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
    };
    const formatDate = fmtStd;
    const formatDateFull = fmtStd;

    const isProtectedReport = (reportId: string) =>
        reportId === currentSessionId || reportId === CURRENT_SESSION_KEY;

    return (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 p-4" onClick={onClose}>
            <div
                ref={dialogRef}
                role="dialog"
                aria-modal="true"
                aria-labelledby="history-dialog-title"
                tabIndex={-1}
                className="relative flex h-full max-h-[calc(100dvh-2rem)] w-full max-w-3xl flex-col rounded-2xl border border-slate-200 bg-white shadow-2xl sm:max-h-[80vh]"
                onClick={e => e.stopPropagation()}
            >
                {/* Header */}
                <div className="flex items-center justify-between border-b border-slate-100 px-5 py-4">
                    <div>
                        <h2 id="history-dialog-title" className="text-lg font-semibold text-slate-900">
                            {getTranslation('history_title', language)}
                        </h2>
                        <p className="mt-0.5 text-xs text-slate-500">
                            {getTranslation('history_footer', language)}
                        </p>
                    </div>
                    <button
                        data-dialog-initial-focus
                        onClick={onClose}
                        className="flex h-[44px] w-[44px] items-center justify-center rounded-full text-slate-600 transition-colors hover:bg-slate-100 hover:text-slate-900"
                        title={getTranslation('history_close', language)}
                        aria-label={getTranslation('history_close', language)}
                    >
                        <IconClose />
                    </button>
                </div>

                {/* Search */}
                {reports.length > 2 && (
                    <div className="border-b border-slate-100 px-5 py-3">
                        <input
                            type="text"
                            value={search}
                            onChange={e => setSearch(e.target.value)}
                            placeholder={getTranslation('history_search_placeholder', language)}
                            className="min-h-[44px] w-full rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-sm text-slate-800 placeholder-slate-400 focus:border-blue-300 focus:bg-white focus:outline-none focus:ring-1 focus:ring-blue-300"
                        />
                    </div>
                )}

                {/* Sort controls + storage bar */}
                <div className="flex flex-col gap-1 border-b border-slate-100 px-5 py-2 sm:flex-row sm:items-center sm:justify-between sm:gap-3">
                        {reports.length > 2 ? (
                            <div role="group" aria-label={getTranslation('history_sort', language)} className="flex w-full items-center gap-1 text-xs sm:w-auto">
                                <span className="mr-1 hidden text-slate-400 sm:inline">{getTranslation('history_sort', language)}</span>
                                {([
                                    ['updatedAt', getTranslation('history_sort_modified', language)],
                                    ['createdAt', getTranslation('history_sort_created', language)],
                                    ['filename', getTranslation('history_sort_name', language)],
                                ] as [SortField, string][]).map(([field, label]) => (
                                    <button
                                        key={field}
                                        onClick={() => toggleSort(field)}
                                        className={`min-h-[44px] flex-1 whitespace-nowrap rounded px-2 transition-colors sm:flex-none ${sortField === field ? 'bg-blue-100 text-blue-700 font-medium' : 'text-slate-500 hover:bg-slate-100'}`}
                                    >
                                        {label}
                                        {sortField === field && (
                                            <span className="ml-0.5">{sortDirection === 'desc' ? '↓' : '↑'}</span>
                                        )}
                                    </button>
                                ))}
                            </div>
                        ) : <div />}
                        <div className="flex w-full items-center justify-between gap-2 border-t border-slate-100 pt-1 sm:w-auto sm:border-0 sm:pt-0">
                            {storageError ? (
                                <div role="alert" className="flex items-center gap-2 text-xs text-amber-800">
                                    <span>{getTranslation('history_storage_unavailable', language)}</span>
                                    <button
                                        type="button"
                                        onClick={() => void refreshStorageInfo()}
                                        className="min-h-[44px] rounded px-2 font-semibold text-blue-700 hover:bg-blue-50"
                                    >
                                        {getTranslation('history_storage_retry', language)}
                                    </button>
                                </div>
                            ) : (
                                <button
                                    onClick={() => setShowStorageInspector(prev => !prev)}
                                    className="flex min-h-[44px] items-center gap-1.5 rounded-md px-2 text-xs font-medium text-slate-600 transition-colors hover:bg-slate-100 hover:text-slate-900"
                                    title={storageInfo
                                        ? getTranslation('history_storage_inspect_title', language, { size: storageInfo.idbLabel })
                                        : getTranslation('history_storage_loading', language)}
                                    disabled={!storageInfo}
                                >
                                    {storageInfo ? (
                                        <>
                                            <span>{getTranslation('history_storage_label', language)}</span>
                                            <span aria-hidden="true">·</span>
                                            <span>{storageInfo.idbLabel}</span>
                                        </>
                                    ) : <span>{getTranslation('history_storage_loading', language)}</span>}
                                    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.75" className={`h-3 w-3 transition-transform ${showStorageInspector ? '' : '-rotate-90'}`}>
                                        <path strokeLinecap="round" strokeLinejoin="round" d="M6 8l4 4 4-4" />
                                    </svg>
                                </button>
                            )}
                            <button
                                ref={purgeTriggerRef}
                                onClick={() => {
                                    setPendingDeletion({ kind: 'purge', count: reports.filter(report => report.id !== CURRENT_SESSION_KEY).length });
                                    setDeletionError(null);
                                }}
                                disabled={isPurging}
                                className="min-h-[44px] rounded-md px-2 text-xs font-medium text-red-600 transition-colors hover:bg-red-50 hover:text-red-700 disabled:cursor-wait disabled:opacity-50"
                                title={getTranslation('history_clear_all_title', language)}
                            >
                                {isPurging
                                    ? getTranslation('history_clearing', language)
                                    : getTranslation('history_clear_all', language)}
                            </button>
                        </div>
                </div>

                {loadErrorId && (
                    <div role="alert" className="flex flex-wrap items-center justify-between gap-2 border-b border-red-100 bg-red-50 px-5 py-2 text-sm text-red-800">
                        <span>{getTranslation('history_load_failed', language)}</span>
                        <button
                            type="button"
                            onClick={() => void doLoad(loadErrorId)}
                            disabled={loadingId !== null}
                            className="min-h-[44px] rounded-lg px-3 font-semibold text-red-800 hover:bg-red-100 disabled:opacity-50"
                        >
                            {getTranslation('history_load_retry', language)}
                        </button>
                    </div>
                )}

                {reportsLoadState === 'error' && (
                    <div role="alert" className="flex flex-wrap items-center justify-between gap-2 border-b border-amber-200 bg-amber-50 px-5 py-2 text-sm text-amber-900">
                        <span>{getTranslation('history_list_unavailable', language)}</span>
                        <button
                            type="button"
                            onClick={() => void refreshReportsList(true)}
                            className="min-h-[44px] rounded-lg px-3 font-semibold text-blue-700 hover:bg-amber-100"
                        >
                            {getTranslation('history_list_retry', language)}
                        </button>
                    </div>
                )}

                {reportActionError && (
                    <div role="alert" className="flex flex-wrap items-center justify-between gap-2 border-b border-red-100 bg-red-50 px-5 py-2 text-sm text-red-800">
                        <span>{getTranslation(reportActionError.action === 'open' ? 'history_open_failed' : 'history_pdf_failed', language)}</span>
                        <button
                            type="button"
                            onClick={() => void runReportAction(reportActionError.action, reportActionError.id)}
                            disabled={reportActionBusy}
                            className="min-h-[44px] rounded-lg px-3 font-semibold text-red-800 hover:bg-red-100 disabled:opacity-50"
                        >
                            {getTranslation(reportActionError.action === 'open' ? 'history_open_retry' : 'history_pdf_retry', language)}
                        </button>
                    </div>
                )}

                <div data-history-scroll-region className="min-h-0 flex-1 overflow-y-auto">
                    {/* Storage Inspector (expandable) */}
                    {showStorageInspector && (
                        <div className="border-b border-slate-100 bg-slate-50/50 px-5 py-3">
                            <StorageBreakdown
                                activeSessionId={currentSessionId}
                                onStorageChanged={() => void refreshStorageInfo()}
                            />
                        </div>
                    )}

                    {/* Report list */}
                    {filteredGroups.length === 0 ? (
                        <div className="flex min-h-[180px] items-center justify-center px-5">
                            <p className="text-sm text-slate-500">
                                {reportsLoadState === 'idle' || reportsLoadState === 'loading'
                                    ? getTranslation('history_loading', language)
                                    : reportsLoadState === 'error'
                                        ? getTranslation('history_list_unavailable', language)
                                        : getTranslation(search ? 'history_no_results' : 'history_empty', language)}
                            </p>
                        </div>
                    ) : (
                        <ul className="divide-y divide-slate-100">
                            {filteredGroups.map(group => {
                                const olderTitleMatchOnly = Boolean(searchQuery
                                    && !group.filename.toLowerCase().includes(searchQuery)
                                    && !group.latest.reportTitle?.toLowerCase().includes(searchQuery)
                                    && group.older.some(entry => entry.reportTitle?.toLowerCase().includes(searchQuery)));
                                return <HistoryReportRow
                                    key={group.latest.id}
                                    group={group}
                                    language={language}
                                    loadingId={loadingId}
                                    isGroupExpanded={expandedGroup === group.filename
                                        || (olderTitleMatchOnly && !collapsedSearchGroups.has(group.filename))}
                                    overflowMenuId={overflowMenuId}
                                    overflowRef={overflowRef}
                                    onToggleExpand={fn => {
                                        if (olderTitleMatchOnly) {
                                            setExpandedGroup(null);
                                            setCollapsedSearchGroups(prev => {
                                                const next = new Set(prev);
                                                if (next.has(fn)) next.delete(fn);
                                                else next.add(fn);
                                                return next;
                                            });
                                        } else {
                                            setExpandedGroup(prev => prev === fn ? null : fn);
                                        }
                                    }}
                                    onLoad={handleLoad}
                                    onOpenReport={id => void runReportAction('open', id)}
                                    onDelete={handleDelete}
                                    onExportPdf={id => void runReportAction('pdf', id)}
                                    onOverflowToggle={setOverflowMenuId}
                                    isProtectedReport={isProtectedReport}
                                    formatDate={formatDate}
                                    formatDateFull={formatDateFull}
                                />;
                            })}
                        </ul>
                    )}
                </div>

                {/* Inline confirmation overlay */}
                {confirmLoadId && (
                    <div className="absolute inset-0 z-30 flex items-center justify-center rounded-2xl bg-slate-900/40 backdrop-blur-[2px]">
                        <div className="mx-6 w-full max-w-sm rounded-xl border border-slate-200 bg-white p-5 shadow-2xl">
                            <h3 className="text-sm font-semibold text-slate-800">
                                {getTranslation('history_switch_session', language)}
                            </h3>
                            <p className="mt-2 text-xs leading-relaxed text-slate-500">
                                {getTranslation('history_switch_session_desc', language)}
                            </p>
                            <div className="mt-4 flex justify-end gap-2">
                                <button
                                    onClick={() => setConfirmLoadId(null)}
                                    className="min-h-[44px] rounded-lg border border-slate-200 px-3 text-xs font-medium text-slate-600 transition-colors hover:bg-slate-50"
                                >
                                    {getTranslation('history_switch_cancel', language)}
                                </button>
                                <button
                                    onClick={() => void doLoad(confirmLoadId)}
                                    className="min-h-[44px] rounded-lg bg-blue-600 px-3 text-xs font-medium text-white transition-colors hover:bg-blue-700"
                                >
                                    {getTranslation('history_switch_confirm', language)}
                                </button>
                            </div>
                        </div>
                    </div>
                )}
                {pendingDeletion && (
                    <div className="absolute inset-0 z-30 flex items-center justify-center rounded-2xl bg-slate-900/40 p-4 backdrop-blur-[2px]">
                        <div
                            role="alertdialog"
                            aria-modal="true"
                            aria-labelledby={deletionTitleId}
                            aria-describedby={deletionDescriptionId}
                            className="max-h-full w-full max-w-sm overflow-y-auto rounded-xl border border-red-200 bg-white p-5 shadow-2xl"
                            onKeyDown={event => {
                                if (event.key === 'Tab') {
                                    if (event.shiftKey && document.activeElement === cancelDeletionRef.current) {
                                        event.preventDefault();
                                        event.stopPropagation();
                                        confirmDeletionRef.current?.focus();
                                    } else if (!event.shiftKey && document.activeElement === confirmDeletionRef.current) {
                                        event.preventDefault();
                                        event.stopPropagation();
                                        cancelDeletionRef.current?.focus();
                                    }
                                    return;
                                }
                                if (event.key !== 'Escape' || isPurging || deletingReportId) return;
                                event.preventDefault();
                                event.stopPropagation();
                                dismissDeletion();
                            }}
                        >
                            <h3 id={deletionTitleId} className="text-sm font-semibold text-red-800">
                                {getTranslation(pendingDeletion.kind === 'purge' ? 'history_purge_confirm_title' : 'history_delete_confirm_title', language)}
                            </h3>
                            <p id={deletionDescriptionId} className="mt-2 break-words text-xs leading-relaxed text-slate-600">
                                {pendingDeletion.kind === 'purge'
                                    ? getTranslation('history_purge_confirm_desc', language, { count: pendingDeletion.count })
                                    : getTranslation('history_delete_confirm_desc', language, { filename: pendingDeletion.filename })}
                            </p>
                            {deletionError && <p role="alert" className="mt-2 text-xs text-red-700">{deletionError}</p>}
                            <div className="mt-4 flex flex-wrap justify-end gap-2">
                                <button
                                    ref={cancelDeletionRef}
                                    type="button"
                                    onClick={dismissDeletion}
                                    disabled={isPurging || deletingReportId !== null}
                                    className="min-h-[44px] rounded-lg border border-slate-300 bg-white px-3 text-xs font-medium text-slate-700 disabled:opacity-50"
                                >
                                    {getTranslation('history_switch_cancel', language)}
                                </button>
                                <button
                                    ref={confirmDeletionRef}
                                    type="button"
                                    onClick={() => void confirmDeletion()}
                                    disabled={isPurging || deletingReportId !== null}
                                    className="min-h-[44px] rounded-lg bg-red-600 px-3 text-xs font-medium text-white disabled:opacity-50"
                                >
                                    {getTranslation(pendingDeletion.kind === 'purge' ? 'history_purge_confirm_action' : 'history_delete_confirm_action', language)}
                                </button>
                            </div>
                        </div>
                    </div>
                )}
            </div>
        </div>
    );
};
