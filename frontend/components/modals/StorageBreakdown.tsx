
import React, { useState, useEffect, useCallback, useId, useRef } from 'react';
import {
    getStorageBreakdown,
    clearStore,
    clearAllCacheStorage,
    CURRENT_SESSION_KEY,
    type StorageBreakdownResult,
} from '../../services/storageService';

// ── Helpers ──────────────────────────────────────────────────────────────

const formatBytes = (bytes: number): string => {
    if (bytes === 0) return '0 B';
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
};

const STORE_COLORS: Record<string, string> = {
    reports: 'bg-blue-400',
    report_artifacts: 'bg-indigo-400',
    original_data: 'bg-amber-400',
    agent_memory_runs: 'bg-emerald-400',
    vector_memory: 'bg-purple-400',
    ai_consents: 'bg-cyan-400',
    settings: 'bg-slate-300',
    cache: 'bg-orange-400',
};

const STORE_DOT_COLORS: Record<string, string> = {
    reports: 'bg-blue-400',
    report_artifacts: 'bg-indigo-400',
    original_data: 'bg-amber-400',
    agent_memory_runs: 'bg-emerald-400',
    vector_memory: 'bg-purple-400',
    ai_consents: 'bg-cyan-400',
    settings: 'bg-slate-300',
    cache: 'bg-orange-400',
};

// ── Icons ────────────────────────────────────────────────────────────────

const TrashIcon: React.FC<{ className?: string }> = ({ className = 'h-3.5 w-3.5' }) => (
    <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor" className={className}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M14.74 9l-.346 9m-4.788 0L9.26 9m9.968-3.21c.342.052.682.107 1.022.166m-1.022-.165L18.16 19.673a2.25 2.25 0 01-2.244 2.077H8.084a2.25 2.25 0 01-2.244-2.077L4.772 5.79m14.456 0a48.108 48.108 0 00-3.478-.397m-12 .562c.34-.059.68-.114 1.022-.165m0 0a48.11 48.11 0 013.478-.397m7.5 0v-.916c0-1.18-.91-2.164-2.09-2.201a51.964 51.964 0 00-3.32 0c-1.18.037-2.09 1.022-2.09 2.201v.916m7.5 0a48.667 48.667 0 00-7.5 0" />
    </svg>
);

const RefreshIcon: React.FC<{ className?: string }> = ({ className = 'h-3.5 w-3.5' }) => (
    <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor" className={className}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M16.023 9.348h4.992v-.001M2.985 19.644v-4.992m0 0h4.992m-4.993 0l3.181 3.183a8.25 8.25 0 0013.803-3.7M4.031 9.865a8.25 8.25 0 0113.803-3.7l3.181 3.182" />
    </svg>
);

// ── Protected store names (cannot be fully cleared) ──────────────────────

const UNCLEARABLE_STORES = new Set(['settings']);

// ── Component ────────────────────────────────────────────────────────────

interface StorageBreakdownProps {
    activeSessionId: string | null;
    onStorageChanged?: () => void;
}

export const StorageBreakdown: React.FC<StorageBreakdownProps> = ({ activeSessionId, onStorageChanged }) => {
    const [data, setData] = useState<StorageBreakdownResult | null>(null);
    const [loading, setLoading] = useState(true);
    const [clearing, setClearing] = useState<string | null>(null);
    const [pendingClear, setPendingClear] = useState<{ key: string; label: string; count: number; isCache: boolean } | null>(null);
    const clearTriggerRef = useRef<HTMLButtonElement>(null);
    const cancelClearRef = useRef<HTMLButtonElement>(null);
    const confirmationTitleId = useId();
    const confirmationDescriptionId = useId();

    useEffect(() => {
        if (pendingClear) cancelClearRef.current?.focus();
    }, [pendingClear]);

    const refresh = useCallback(async () => {
        setLoading(true);
        try {
            const result = await getStorageBreakdown();
            setData(result);
        } finally {
            setLoading(false);
        }
    }, []);

    useEffect(() => { void refresh(); }, [refresh]);

    const handleClearStore = async (storeName: string) => {
        if (UNCLEARABLE_STORES.has(storeName)) return;
        const protectKeys = new Set<string>();
        if (storeName === 'reports') {
            protectKeys.add(CURRENT_SESSION_KEY);
            if (activeSessionId) protectKeys.add(activeSessionId);
        }
        if (storeName === 'original_data') {
            if (activeSessionId) protectKeys.add(activeSessionId);
            try {
                const tabId = sessionStorage.getItem('csv_agent_tab_session_id');
                if (tabId) protectKeys.add(tabId);
            } catch { /* ok */ }
        }

        setClearing(storeName);
        try {
            await clearStore(storeName, protectKeys.size > 0 ? protectKeys : undefined);
            await refresh();
            onStorageChanged?.();
        } finally {
            setClearing(null);
        }
    };

    const handleClearCache = async () => {
        setClearing('cache');
        try {
            await clearAllCacheStorage();
            await refresh();
            onStorageChanged?.();
        } finally {
            setClearing(null);
        }
    };

    const dismissClear = () => {
        setPendingClear(null);
        requestAnimationFrame(() => clearTriggerRef.current?.focus());
    };

    const confirmClear = () => {
        if (!pendingClear) return;
        const { key, isCache } = pendingClear;
        setPendingClear(null);
        void (isCache ? handleClearCache() : handleClearStore(key));
    };

    if (loading && !data) {
        return (
            <div className="px-4 py-3 text-xs text-slate-400 text-center">
                Scanning storage...
            </div>
        );
    }

    if (!data) return null;

    // Build unified list for the bar chart
    const allSegments = [
        ...data.stores.map(s => ({
            key: s.storeName,
            label: s.label,
            bytes: s.estimatedBytes,
            count: s.recordCount,
            color: STORE_COLORS[s.storeName] ?? 'bg-slate-300',
            dotColor: STORE_DOT_COLORS[s.storeName] ?? 'bg-slate-300',
            clearable: !UNCLEARABLE_STORES.has(s.storeName) && s.recordCount > 0,
            isCache: false,
        })),
        {
            key: 'cache',
            label: 'Cache Storage',
            bytes: data.cacheStorage.estimatedBytes,
            count: data.cacheStorage.cacheCount,
            color: STORE_COLORS.cache,
            dotColor: STORE_DOT_COLORS.cache,
            clearable: data.cacheStorage.cacheCount > 0,
            isCache: true,
        },
    ];

    const maxBytes = Math.max(...allSegments.map(s => s.bytes), 1);
    const scannedTotalBytes = Math.max(data.totalWithCacheBytes, 1);

    return (
        <div className="space-y-2">
            {/* Header */}
            <div className="flex items-center justify-between">
                <span className="text-[11px] font-semibold text-slate-600 uppercase tracking-wider">
                    Storage Inspector
                </span>
                <button
                    onClick={() => void refresh()}
                    disabled={loading}
                    className="flex min-h-[44px] items-center gap-1 rounded px-2 text-[10px] text-slate-500 hover:bg-slate-100 hover:text-slate-700 disabled:opacity-50"
                    title="Refresh"
                >
                    <RefreshIcon className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} />
                    Refresh
                </button>
            </div>

            {/* Stacked bar */}
            <div className="h-3 w-full rounded-full bg-slate-100 overflow-hidden flex">
                {allSegments.filter(s => s.bytes > 0).map(seg => (
                    <div
                        key={seg.key}
                        className={`${seg.color} transition-all`}
                        style={{ width: `${(seg.bytes / scannedTotalBytes) * 100}%` }}
                        title={`${seg.label}: ${formatBytes(seg.bytes)}`}
                    />
                ))}
            </div>

            {/* Totals */}
            <div className="flex flex-wrap items-center justify-between gap-x-3 text-[10px] text-slate-500">
                <span>IndexedDB estimate: {formatBytes(data.totalIdbBytes)}</span>
                <span>Scanned total: {formatBytes(data.totalWithCacheBytes)}</span>
            </div>
            {data.rawOriginBytes > 0 && (
                <p className="text-[10px] text-slate-400">
                    Browser origin estimate: {formatBytes(data.rawOriginBytes)}. This uses a separate measurement and may differ from the scanned total.
                </p>
            )}

            {/* Per-store rows */}
            <div className="space-y-0.5">
                {allSegments.map(seg => (
                    <div
                        key={seg.key}
                        className="flex items-center gap-2 rounded-md px-2 py-1.5 hover:bg-slate-50 group/row"
                    >
                        {/* Color dot */}
                        <div className={`h-2.5 w-2.5 rounded-full flex-shrink-0 ${seg.dotColor}`} />

                        {/* Label + count */}
                        <div className="flex-1 min-w-0">
                            <p className="text-xs text-slate-700 truncate" title={seg.isCache ? 'Cached app assets and models' : undefined}>{seg.label}</p>
                            <p className="text-[10px] text-slate-400">
                                {seg.isCache
                                    ? `${seg.count} cache${seg.count !== 1 ? 's' : ''}`
                                    : `${seg.count} record${seg.count !== 1 ? 's' : ''}`}
                            </p>
                        </div>

                        {/* Size bar + value */}
                        <div className="flex items-center gap-2 flex-shrink-0">
                            <div className="hidden w-20 h-1.5 rounded-full bg-slate-100 overflow-hidden sm:block">
                                <div
                                    className={`h-full rounded-full ${seg.color}`}
                                    style={{ width: `${Math.max(1, (seg.bytes / maxBytes) * 100)}%` }}
                                />
                            </div>
                            <span className="text-[10px] font-mono text-slate-500 w-16 text-right">
                                {formatBytes(seg.bytes)}
                            </span>

                            {/* Clear button */}
                            {seg.clearable ? (
                                <button
                                    onClick={event => {
                                        clearTriggerRef.current = event.currentTarget;
                                        setPendingClear({ key: seg.key, label: seg.label, count: seg.count, isCache: seg.isCache });
                                    }}
                                    disabled={clearing !== null}
                                    className="flex h-[44px] w-[44px] items-center justify-center rounded text-slate-600 transition-opacity hover:bg-red-50 hover:text-red-600 focus-visible:opacity-100 disabled:cursor-wait disabled:opacity-50 sm:opacity-0 sm:group-hover/row:opacity-100"
                                    title={`Clear ${seg.label}`}
                                >
                                    {clearing === seg.key ? (
                                        <span className="h-3 w-3 border-2 border-slate-300 border-t-transparent rounded-full animate-spin" />
                                    ) : (
                                        <TrashIcon className="h-4 w-4" />
                                    )}
                                </button>
                            ) : (
                                <div className="w-[44px]" />
                            )}
                        </div>
                    </div>
                ))}
            </div>
            {pendingClear && (
                <div
                    role="alertdialog"
                    aria-labelledby={confirmationTitleId}
                    aria-describedby={confirmationDescriptionId}
                    className="rounded-lg border border-red-200 bg-red-50 p-3 text-xs text-slate-700"
                    onKeyDown={event => {
                        if (event.key !== 'Escape') return;
                        event.preventDefault();
                        event.stopPropagation();
                        dismissClear();
                    }}
                >
                    <h3 id={confirmationTitleId} className="font-semibold text-red-800">
                        Clear {pendingClear.label}?
                    </h3>
                    <p id={confirmationDescriptionId} className="mt-1 leading-relaxed">
                        {pendingClear.isCache
                            ? `${pendingClear.count} browser cache${pendingClear.count === 1 ? '' : 's'} will be removed. Offline app assets and models may need to be downloaded again.`
                            : `${pendingClear.count} saved record${pendingClear.count === 1 ? '' : 's'} will be removed. Current-session records remain protected where applicable.`}
                        {' '}This cannot be undone.
                    </p>
                    <div className="mt-3 flex flex-wrap justify-end gap-2">
                        <button
                            ref={cancelClearRef}
                            type="button"
                            onClick={dismissClear}
                            className="min-h-[44px] rounded-lg border border-slate-300 bg-white px-3 font-medium text-slate-700 hover:bg-slate-50"
                        >
                            Cancel
                        </button>
                        <button
                            type="button"
                            onClick={confirmClear}
                            className="min-h-[44px] rounded-lg bg-red-600 px-3 font-medium text-white hover:bg-red-700"
                        >
                            Clear now
                        </button>
                    </div>
                </div>
            )}
        </div>
    );
};
