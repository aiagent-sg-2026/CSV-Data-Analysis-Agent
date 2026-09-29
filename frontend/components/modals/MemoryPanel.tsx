
import React, { useState, useEffect, useCallback, useId, useMemo, useRef } from 'react';
import { vectorStore } from '../../services/vectorStore';
import { VectorStoreDocument } from '../../types';
import { useAppStore } from '../../store/useAppStore';
import { flushPendingVectorMemoryDocs } from '../../services/agent/memory/vectorMemorySync';
import { IconClose } from '../../icons/IconClose';
import { IconMemory } from '../../icons/IconMemory';
import { IconDelete } from '../../icons/IconDelete';
import { resolveReportMemoryScope } from '../../services/agent/memory/memoryScope';
import { useDialogAccessibility } from '../../hooks/useDialogAccessibility';

type SearchResult = {
    id: string;
    text: string;
    origin?: string;
} & ({ kind: 'semantic'; score: number } | { kind: 'keyword' });

const keywordTokens = (text: string): string[] =>
    (text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [])
        .map(token => /^[a-z]+$/.test(token) && token.length > 3 && token.endsWith('s')
            ? token.slice(0, -1)
            : token);

const findKeywordMatches = (query: string, documents: VectorStoreDocument[]): SearchResult[] => {
    const terms = [...new Set(keywordTokens(query).filter(token => token.length > 1))];
    if (terms.length === 0) return [];

    return documents.flatMap(document => {
        const tokens = keywordTokens(document.text);
        const positions = terms.map(term => tokens.indexOf(term));
        if (positions.some(position => position < 0)) return [];
        return [{
            id: document.id,
            text: document.text,
            origin: document.metadata?.origin?.label,
            kind: 'keyword' as const,
            position: (Math.max(...positions) - Math.min(...positions)) * 2 + Math.min(...positions),
        }];
    }).sort((a, b) => a.position - b.position).slice(0, 5);
};

const getSearchResultTitle = (result: SearchResult): string => {
    const sourceTitle = result.origin?.replace(/^(Analysis card|Dataset import):\s*/i, '').trim();
    const firstLine = result.text.replace(/^\[Analysis Card\]\s*/, '').split(/\n| Description:|\. Keywords:/)[0].trim();
    const title = sourceTitle || firstLine || 'Saved memory';
    return title.length > 100 ? `${title.slice(0, 97)}...` : title;
};

const getSearchResultPreview = (result: SearchResult): string => {
    if (!result.text.startsWith('[Analysis Card]')) return result.text;
    const description = /\bDescription:\s*/.exec(result.text);
    return description
        ? result.text.slice(description.index + description[0].length).trim()
        : result.text;
};

type PendingMemoryDeletion =
    | { kind: 'item'; id: string; label: string }
    | { kind: 'report'; count: number };

// Soft capacity limit for the visual progress bar (in KB)
const MEMORY_CAPACITY_KB = 5 * 1024; // 5 MB

export const MemoryPanel: React.FC = () => {
    const isOpen = useAppStore(state => state.isMemoryPanelOpen);
    const onClose = () => useAppStore.getState().setIsMemoryPanelOpen(false);

    const [documents, setDocuments] = useState<VectorStoreDocument[]>([]);
    const [documentsError, setDocumentsError] = useState(false);
    const [isLoadingDocuments, setIsLoadingDocuments] = useState(false);
    const [searchQuery, setSearchQuery] = useState('');
    const [searchResults, setSearchResults] = useState<SearchResult[]>([]);
    const [searchFeedback, setSearchFeedback] = useState<'none' | 'empty' | 'error'>('none');
    const [isSearching, setIsSearching] = useState(false);
    const [highlightedDocId, setHighlightedDocId] = useState<string | null>(null);
    const [modelStatus, setModelStatus] = useState(vectorStore.getStatus());
    const [modelError, setModelError] = useState(vectorStore.getLastError());
    const [pendingDeletion, setPendingDeletion] = useState<PendingMemoryDeletion | null>(null);
    const [deletionError, setDeletionError] = useState<string | null>(null);
    const [isDeleting, setIsDeleting] = useState(false);
    const [showScopeIds, setShowScopeIds] = useState(false);
    const deletionTriggerRef = useRef<HTMLButtonElement>(null);
    const cancelDeletionRef = useRef<HTMLButtonElement>(null);
    const confirmDeletionRef = useRef<HTMLButtonElement>(null);
    const refreshSequenceRef = useRef(0);
    const searchSequenceRef = useRef(0);
    const deletionTitleId = useId();
    const deletionDescriptionId = useId();
    const dialogRef = useDialogAccessibility<HTMLDivElement>(isOpen, onClose);

    useEffect(() => {
        if (pendingDeletion) cancelDeletionRef.current?.focus();
    }, [pendingDeletion]);

    const isModelReady = modelStatus === 'ready';
    const activeMemoryScope = resolveReportMemoryScope(useAppStore.getState());
    const canSearch = Boolean(activeMemoryScope && documents.length > 0);

    const refreshDocuments = useCallback(async () => {
        const requestId = ++refreshSequenceRef.current;
        setIsLoadingDocuments(true);
        try {
            const scope = resolveReportMemoryScope(useAppStore.getState());
            const docs = await vectorStore.getDocumentsForScope(scope);
            if (requestId === refreshSequenceRef.current) {
                setDocuments(docs);
                setDocumentsError(false);
            }
            return docs;
        } catch {
            if (requestId === refreshSequenceRef.current) setDocumentsError(true);
            return null;
        } finally {
            if (requestId === refreshSequenceRef.current) setIsLoadingDocuments(false);
        }
    }, []);

    const syncModelState = useCallback(() => {
        setModelStatus(vectorStore.getStatus());
        setModelError(vectorStore.getLastError());
    }, []);

    const memoryUsage = useMemo(() => {
        if (documents.length === 0) return 0;
        // Estimate the size of the stored documents
        // Size of text (assuming average 2 bytes per char for UTF-16)
        const textSize = documents.reduce((acc, doc) => acc + (doc.text.length * 2), 0);
        // Size of embeddings (384 dimensions * 4 bytes per float32)
        const embeddingSize = documents.length * 384 * 4;
        return (textSize + embeddingSize) / 1024; // in KB
    }, [documents]);

    // Track whether we've already triggered activation for this panel open.
    const activationTriggered = useRef(false);

    useEffect(() => {
        let cancelled = false;
        if (isOpen) {
            void refreshDocuments();
            syncModelState();

            // Trigger on-demand vector memory activation when the panel opens (PERF-103).
            if (activeMemoryScope && !activationTriggered.current) {
                activationTriggered.current = true;
                const store = { getState: useAppStore.getState, setState: useAppStore.setState };
                void vectorStore.ensureVectorMemoryReady(
                    'memory_panel',
                    store as never,
                    async (s) => {
                        await flushPendingVectorMemoryDocs(s as never);
                        if (cancelled) return;
                        void refreshDocuments();
                        syncModelState();
                    },
                ).then(() => {
                    if (cancelled) return;
                    syncModelState();
                    void refreshDocuments();
                }).catch(() => {
                    if (cancelled) return;
                    syncModelState();
                });
            }
        } else {
            // Reset state on close
            refreshSequenceRef.current += 1;
            searchSequenceRef.current += 1;
            activationTriggered.current = false;
            setDocuments([]);
            setDocumentsError(false);
            setIsLoadingDocuments(false);
            setShowScopeIds(false);
            setSearchQuery('');
            setSearchResults([]);
            setSearchFeedback('none');
            setIsSearching(false);
            setHighlightedDocId(null);
            setPendingDeletion(null);
            setDeletionError(null);
        }
        return () => {
            cancelled = true;
            refreshSequenceRef.current += 1;
            searchSequenceRef.current += 1;
        };
    }, [isOpen, refreshDocuments, syncModelState]);

    const handleSearch = async (e: React.FormEvent) => {
        e.preventDefault();
        if (!canSearch || !searchQuery.trim() || modelStatus === 'loading') return;
        const requestId = ++searchSequenceRef.current;
        setIsSearching(true);
        setHighlightedDocId(null);
        setSearchFeedback('none');
        syncModelState();
        try {
            const results = await vectorStore.search(searchQuery, 5, activeMemoryScope!, { propagateError: true });
            if (requestId !== searchSequenceRef.current) return;
            const semanticResults: SearchResult[] = results.map(item => ({
                id: item.id,
                text: item.text,
                score: item.score,
                origin: item.metadata?.origin?.label,
                kind: 'semantic',
            }));
            // The vector worker applies a fixed similarity threshold. Keep scoped
            // text matches discoverable even when another result passes that gate.
            const keywordResults = findKeywordMatches(searchQuery, documents);
            const semanticById = new Map(semanticResults.map(result => [result.id, result]));
            const keywordIds = new Set(keywordResults.map(result => result.id));
            const visibleResults = [
                ...keywordResults.map(result => semanticById.get(result.id) ?? result),
                ...semanticResults.filter(result => !keywordIds.has(result.id)),
            ].slice(0, 5);
            setSearchResults(visibleResults);
            setSearchFeedback(visibleResults.length === 0 ? 'empty' : 'none');
        } catch {
            if (requestId === searchSequenceRef.current) {
                setSearchResults([]);
                setSearchFeedback('error');
            }
        } finally {
            if (requestId === searchSequenceRef.current) {
                syncModelState();
                setIsSearching(false);
            }
        }
    };

    const dismissDeletion = () => {
        setPendingDeletion(null);
        setDeletionError(null);
        requestAnimationFrame(() => deletionTriggerRef.current?.focus());
    };

    const confirmDeletion = async () => {
        if (!pendingDeletion || isDeleting) return;
        const ids = pendingDeletion.kind === 'item'
            ? [pendingDeletion.id]
            : documents.map(document => document.id);
        setIsDeleting(true);
        setDeletionError(null);
        try {
            const results = await Promise.allSettled(ids.map(id => vectorStore.deleteDocument(id)));
            vectorStore.schedulePersist();
            useAppStore.setState({
                vectorStoreDocuments: await vectorStore.getDocuments(),
            });
            const remaining = await refreshDocuments();
            if (!remaining) throw new Error('Report memory list unavailable after deletion');
            setSearchResults([]);
            setSearchFeedback('none');
            if (results.some(result => result.status === 'rejected')) {
                if (pendingDeletion.kind === 'report') {
                    setPendingDeletion({ kind: 'report', count: remaining.length });
                }
                setDeletionError('Some memory items could not be deleted. Review the list and retry.');
                return;
            }
            dismissDeletion();
        } catch {
            setDeletionError('Could not refresh report memory after deletion. Review the list and retry.');
        } finally {
            setIsDeleting(false);
        }
    };

    const handleSearchResultClick = (id: string) => {
        setHighlightedDocId(id);
        const element = document.getElementById(`memory-doc-${id}`);
        element?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }

    if (!isOpen) return null;

    const memoryUsagePercentage = Math.min((memoryUsage / MEMORY_CAPACITY_KB) * 100, 100);

    return (
        <div
            className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900 bg-opacity-50 p-4 transition-opacity"
            onClick={onClose}
        >
            <div
                ref={dialogRef}
                role="dialog"
                aria-modal="true"
                aria-labelledby="memory-dialog-title"
                tabIndex={-1}
                className="flex h-full max-h-[85vh] w-full max-w-4xl flex-col rounded-card border border-slate-200 bg-white p-4 shadow-xl"
                onClick={e => e.stopPropagation()}
            >
                <header className="mb-3 flex shrink-0 items-start justify-between">
                    <div>
                        <div className="flex items-center gap-2">
                            <span className="flex h-10 w-10 items-center justify-center rounded-full bg-blue-100 text-blue-700" aria-hidden="true">
                                <IconMemory />
                            </span>
                            <h2 id="memory-dialog-title" className="text-2xl font-bold text-slate-900">AI Long-Term Memory</h2>
                        </div>
                        <div className="mt-1 pl-12">
                            <div className="flex flex-wrap items-center gap-x-3 text-sm text-slate-500">
                                <span>{documents.length} items · Using ~{memoryUsage.toFixed(2)} KB</span>
                                {activeMemoryScope && (
                                    <button
                                        type="button"
                                        aria-expanded={showScopeIds}
                                        onClick={() => setShowScopeIds(value => !value)}
                                        className="min-h-[44px] rounded-md px-1 text-xs font-medium text-blue-700 hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-blue-600"
                                    >
                                        {showScopeIds ? 'Hide scope IDs' : 'View scope IDs'}
                                    </button>
                                )}
                            </div>
                            {activeMemoryScope && showScopeIds && (
                                <p className="mt-1 max-w-2xl break-all rounded-md bg-slate-50 p-2 text-[11px] text-slate-600">
                                    Active scope: Report {activeMemoryScope.reportId} · Dataset {activeMemoryScope.datasetId} · Version {activeMemoryScope.datasetVersion}
                                </p>
                            )}
                            <div className="mt-1 h-1.5 w-full rounded-full bg-slate-200">
                                <div className="bg-blue-600 h-1.5 rounded-full" style={{ width: `${memoryUsagePercentage}%` }}></div>
                            </div>
                        </div>
                    </div>
                    <button
                        data-dialog-initial-focus
                        onClick={onClose}
                        className="flex min-h-[44px] min-w-[44px] items-center justify-center rounded-full p-1 text-slate-600 transition-colors hover:bg-slate-100 hover:text-slate-900"
                        title="Close"
                        aria-label="Close memory"
                    >
                        <IconClose />
                    </button>
                </header>

                {pendingDeletion && (
                    <div
                        role="alertdialog"
                        aria-modal="true"
                        aria-labelledby={deletionTitleId}
                        aria-describedby={deletionDescriptionId}
                        className="mb-3 max-h-[45vh] shrink-0 overflow-y-auto rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-slate-700"
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
                            if (event.key !== 'Escape' || isDeleting) return;
                            event.preventDefault();
                            event.stopPropagation();
                            dismissDeletion();
                        }}
                    >
                        <h3 id={deletionTitleId} className="font-semibold text-red-800">
                            {pendingDeletion.kind === 'item' ? 'Delete memory item?' : 'Clear report memory?'}
                        </h3>
                        <p id={deletionDescriptionId} className="mt-1 break-words leading-relaxed">
                            {pendingDeletion.kind === 'item'
                                ? `Delete “${pendingDeletion.label}” from this report?`
                                : `${pendingDeletion.count} saved memory item${pendingDeletion.count === 1 ? '' : 's'} for this report and dataset version will be deleted.`}
                            {' '}This cannot be undone.
                        </p>
                        {deletionError && <p role="alert" className="mt-2 text-red-700">{deletionError}</p>}
                        <div className="mt-3 flex flex-wrap justify-end gap-2">
                            <button ref={cancelDeletionRef} type="button" onClick={dismissDeletion} disabled={isDeleting} className="min-h-[44px] rounded-lg border border-slate-300 bg-white px-3 font-medium text-slate-700 disabled:opacity-50">
                                Cancel
                            </button>
                            <button ref={confirmDeletionRef} type="button" onClick={() => void confirmDeletion()} disabled={isDeleting} className="min-h-[44px] rounded-lg bg-red-600 px-3 font-medium text-white disabled:opacity-50">
                                {pendingDeletion.kind === 'item' ? 'Delete memory' : 'Clear report memory'}
                            </button>
                        </div>
                    </div>
                )}

                <div className="grid min-h-0 flex-grow gap-4 md:grid-cols-2">
                    {/* Left Column: Search */}
                    <div className="flex flex-col min-h-0">
                        <div className="mb-4 shrink-0 rounded-card border border-slate-200 bg-slate-50 p-4">
                            <h3 className="mb-2 font-semibold text-slate-800">Test Similarity Search</h3>
                            <p className="mb-2 text-xs text-slate-500">
                                {!activeMemoryScope
                                    ? 'Upload and analyze a CSV to create searchable memory.'
                                    : documents.length === 0
                                        ? 'No saved memory items are available for this report yet.'
                                        : modelStatus === 'idle'
                                            ? 'The local memory model will load the first time semantic search runs.'
                                            : modelStatus === 'loading'
                                                ? 'Loading the local memory model and WASM assets.'
                                                : modelStatus === 'ready'
                                                    ? 'Local memory model is ready.'
                                                    : `Local memory model failed to load. ${modelError ?? ''}`.trim()}
                            </p>
                            <form onSubmit={handleSearch} className="flex items-center gap-2">
                                <input
                                    type="text"
                                    value={searchQuery}
                                    onChange={(e) => {
                                        setSearchQuery(e.target.value);
                                        setSearchResults([]);
                                        setSearchFeedback('none');
                                    }}
                                    aria-label="Search saved memories"
                                    placeholder={!canSearch ? "No saved memories to search" : isModelReady ? "Enter query to find memories..." : modelStatus === 'loading' ? "Memory model is loading..." : "Run a search to load the memory model"}
                                    disabled={!canSearch || modelStatus === 'loading' || isSearching}
                                    className="min-h-[44px] min-w-0 flex-grow bg-white border border-slate-300 rounded-md py-1.5 px-3 text-slate-900 placeholder-slate-400 focus:outline-none focus:ring-1 focus:ring-blue-500 disabled:opacity-50"
                                />
                                <button type="submit" disabled={!canSearch || modelStatus === 'loading' || isSearching || !searchQuery.trim()} className="min-h-[44px] px-4 py-1.5 bg-blue-600 text-white font-semibold rounded-md hover:bg-blue-700 transition-colors disabled:bg-blue-300 disabled:cursor-not-allowed">
                                    {isSearching ? '...' : 'Search'}
                                </button>
                            </form>
                        </div>
                        <div className="flex-grow overflow-y-auto pr-2">
                            {searchResults.length > 0 && (
                                <div className="space-y-2">
                                    <h4 className="text-sm font-medium text-slate-600">Top Results:</h4>
                                    {searchResults.map((result) => {
                                        const title = getSearchResultTitle(result);
                                        const matchLabel = result.kind === 'semantic'
                                            ? `Vector similarity · ${(result.score * 100).toFixed(1)}%`
                                            : 'Keyword match · fallback';
                                        return (
                                            <button
                                                key={result.id}
                                                type="button"
                                                aria-label={`Show full memory: ${title}. ${matchLabel}`}
                                                aria-current={highlightedDocId === result.id ? 'true' : undefined}
                                                onClick={() => handleSearchResultClick(result.id)}
                                                className={`min-h-[44px] w-full rounded-card border bg-white p-2.5 text-left text-xs transition-colors hover:border-blue-500 focus-visible:outline focus-visible:outline-2 focus-visible:outline-blue-600 ${highlightedDocId === result.id ? 'border-blue-500 ring-1 ring-blue-500' : 'border-slate-200'}`}
                                            >
                                                <p className="line-clamp-1 font-semibold text-slate-800">{title}</p>
                                                <p className="mt-1 font-medium text-blue-700">{matchLabel}</p>
                                                <p className="mt-1 line-clamp-2 leading-relaxed text-slate-600">{getSearchResultPreview(result)}</p>
                                                {result.origin && <p className="mt-1 line-clamp-1 text-[11px] text-slate-500">Origin: {result.origin}</p>}
                                            </button>
                                        );
                                    })}
                                </div>
                            )}
                            {searchFeedback === 'empty' && <p role="status" className="text-sm text-slate-500">No matching memories found for this query.</p>}
                            {searchFeedback === 'error' && <p role="alert" className="text-sm text-red-700">Memory search failed. Try again.</p>}
                        </div>
                    </div>

                    {/* Right Column: All Documents */}
                    <div className="flex flex-col min-h-0">
                        <div className="mb-2 flex shrink-0 flex-wrap items-center justify-between gap-2">
                            <h3 className="font-semibold text-slate-800">All Stored Memories ({documentsError && documents.length === 0 ? 'unavailable' : documents.length})</h3>
                            {documents.length > 0 && (
                                <button onClick={event => {
                                    deletionTriggerRef.current = event.currentTarget;
                                    setPendingDeletion({ kind: 'report', count: documents.length });
                                    setDeletionError(null);
                                }} className="min-h-[44px] rounded-md px-2 text-xs text-red-600 hover:bg-red-50 hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-red-600">
                                    Clear Report Memory
                                </button>
                            )}
                        </div>
                        {documentsError && (
                            <div role="alert" className="mb-2 rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">
                                <p>Could not load report memory.{documents.length > 0 ? ' Showing previously loaded items.' : ''}</p>
                                <button type="button" onClick={() => void refreshDocuments()} disabled={isLoadingDocuments} className="mt-2 min-h-[44px] rounded-lg border border-amber-300 bg-white px-3 font-medium disabled:opacity-50">
                                    Retry memory list
                                </button>
                            </div>
                        )}
                        <div className="flex-grow overflow-y-auto pr-2 border-t border-slate-200 pt-2">
                            {documents.length === 0 ? (
                                <div className="flex items-center justify-center h-full text-slate-500 text-sm">
                                    <p>{documentsError ? 'Memory list unavailable.' : isLoadingDocuments ? 'Loading report memory...' : "The AI's memory is currently empty."}</p>
                                </div>
                            ) : (
                                <ul className="space-y-2">
                                    {documents.map(doc => (
                                        <li
                                            key={doc.id}
                                            id={`memory-doc-${doc.id}`}
                                            className={`p-3 bg-slate-50 rounded-card text-sm text-slate-800 border border-slate-200 flex justify-between items-start group transition-all duration-300 ${highlightedDocId === doc.id ? 'border-blue-500 ring-2 ring-blue-500' : ''}`}>
                                            <div className="flex-grow pr-4 break-words">
                                                <p>{doc.text}</p>
                                                <p className="mt-2 text-xs text-slate-500">
                                                    Origin: {doc.metadata?.origin?.label ?? 'Legacy memory (unverified origin)'}
                                                </p>
                                                {doc.metadata?.scope && (
                                                    <details className="group mt-2 text-[11px] text-slate-500">
                                                        <summary className="flex min-h-[44px] w-full cursor-pointer items-center justify-between rounded-md border border-slate-200 bg-white px-3 font-medium text-blue-700 hover:border-blue-300 focus-visible:outline focus-visible:outline-2 focus-visible:outline-blue-600">
                                                            Exact provenance
                                                            <span className="ml-2 text-base transition-transform group-open:rotate-180" aria-hidden="true">⌄</span>
                                                        </summary>
                                                        <p className="mt-1 break-all rounded-md bg-white p-2 leading-relaxed">
                                                            Origin: {doc.metadata?.origin?.label ?? 'Legacy memory (unverified origin)'}<br />
                                                            Report {doc.metadata.scope.reportId} · Dataset {doc.metadata.scope.datasetId} · Version {doc.metadata.scope.datasetVersion}
                                                        </p>
                                                    </details>
                                                )}
                                            </div>
                                            <button
                                                onClick={event => {
                                                    deletionTriggerRef.current = event.currentTarget;
                                                    setPendingDeletion({ kind: 'item', id: doc.id, label: doc.text.slice(0, 60) });
                                                    setDeletionError(null);
                                                }}
                                                className="flex min-h-[44px] min-w-[44px] flex-shrink-0 items-center justify-center rounded-full text-slate-600 transition-colors hover:bg-red-100 hover:text-red-600 focus-visible:outline focus-visible:outline-2 focus-visible:outline-red-600"
                                                title="Delete Memory"
                                                aria-label={`Delete memory item: ${doc.text.slice(0, 60)}`}
                                            >
                                                <IconDelete />
                                            </button>
                                        </li>
                                    ))}
                                </ul>
                            )}
                        </div>
                    </div>
                </div>
            </div>
        </div>
    );
};
