import { captureSessionScope } from '../../session/sessionOwnership';
import { assertWorkspaceOwner, canonicalTaskPath, currentTaskWorkspace } from '../taskWorkspace';
import { captureSourceRangeFence, readSourceBytesBounded, readSourceRecordsBounded, SOURCE_BYTES_PATH, SOURCE_RECORDS_PATH } from '../../data/immutableCsvSource';
import { createChatMessage } from '../../../utils/messageState';
import { createId } from '../../../utils/createId';
import type { AiAction, ToolName, WorkspaceActionHistoryEntry, WorkspaceFileAction } from '../../../types';
import { buildWorkspaceBundle } from '../buildWorkspaceBundle';
import { appendCleaningRunStep } from '../cleaningRunState';
import type { StoreApi } from '../types';
import {
    isWorkspaceDatasetWritePath,
    isWorkspaceReadablePath,
    isWorkspaceWritablePath,
    truncateWorkspaceOutput,
    WORKSPACE_ACTION_OUTPUT_LIMIT,
    WORKSPACE_DATASET_CLEAN_CSV,
    WORKSPACE_DATASET_RAW_CSV,
    WORKSPACE_HISTORY_LIMIT,
    WORKSPACE_LIST_LIMIT,
    WORKSPACE_PATH_RULES,
    WORKSPACE_READABLE_ROOTS,
    WORKSPACE_ROOT,
    WORKSPACE_SEARCH_DEFAULT_LIMIT,
    WORKSPACE_SEARCH_MAX_LIMIT,
    workspacePathDeniedError,
} from '../workspaceFileUtils';
import { buildWorkspaceTree, diffWorkspaceFiles, grepWorkspaceFiles, headWorkspaceFile } from '../workspaceRetrieval';
import { isRuntimeAbortError, throwIfAborted } from '../runtime/runtimeAbort';
import { getToolGovernanceMeta } from './executorGovernance';

const buildWorkspaceEntry = (
    action: AiAction,
    details: {
        path: string;
        success: boolean;
        message: string;
        output?: string;
        durationMs: number;
        stage?: WorkspaceActionHistoryEntry['stage'];
        toolCategory?: WorkspaceActionHistoryEntry['toolCategory'];
        policyDecision?: WorkspaceActionHistoryEntry['policyDecision'];
        policyReason?: WorkspaceActionHistoryEntry['policyReason'];
    },
): WorkspaceActionHistoryEntry => ({
    timestamp: new Date(),
    operation: action.type === 'tool_call' && action.toolName.startsWith('workspace.')
        ? action.toolName.replace('workspace.', '') as WorkspaceActionHistoryEntry['operation']
        : 'read',
    path: details.path || 'unknown',
    success: details.success,
    message: details.message,
    output: details.output ?? '',
    durationMs: details.durationMs,
    stage: details.stage,
    toolCategory: details.toolCategory,
    policyDecision: details.policyDecision,
    policyReason: details.policyReason,
});

const normalizeWorkspaceOutput = (value: unknown) => truncateWorkspaceOutput(typeof value === 'string' ? value : JSON.stringify(value));
const resolveWorkspaceSearchLimit = (requested?: number) => !Number.isFinite(requested as number) || requested == null ? WORKSPACE_SEARCH_DEFAULT_LIMIT : Math.min(WORKSPACE_SEARCH_MAX_LIMIT, Math.max(1, Math.floor(requested)));
const resolveWorkspaceListLimit = (requested?: number) => !Number.isFinite(requested as number) || requested == null ? WORKSPACE_LIST_LIMIT : Math.min(WORKSPACE_LIST_LIMIT, Math.max(1, Math.floor(requested)));

const appendWorkspaceTraceMessage = (store: StoreApi, detail: { toolName: string; path: string; kind: 'inspect' | 'edit' | 'verify' | 'commit'; status: 'done' | 'error'; diffSummary?: string; text: string; isError?: boolean }) => {
    store.setState(prev => ({
        chatHistory: [
            ...prev.chatHistory,
            createChatMessage({
                sender: 'ai',
                text: detail.text,
                timestamp: new Date(),
                type: 'ai_cleaning_step',
                isError: detail.isError,
                cleaningStep: {
                    stepId: createId(detail.toolName),
                    kind: detail.kind,
                    toolName: detail.toolName,
                    path: detail.path,
                    diffSummary: detail.diffSummary,
                    status: detail.status,
                },
            }),
        ],
        cleaningRun: prev.cleaningRun ? appendCleaningRunStep(prev.cleaningRun, { kind: detail.kind, toolName: detail.toolName, path: detail.path, diffSummary: detail.diffSummary, status: detail.status }) : prev.cleaningRun,
    }));
};

const toWorkspaceOperation = (toolName: ToolName): WorkspaceFileAction['operation'] =>
    toolName.replace('workspace.', '') as WorkspaceFileAction['operation'];

const withActionHistory = async (
    store: StoreApi,
    action: AiAction,
    path: string,
    run: () => Promise<{ successMessage: string; output?: string; diffSummary?: string; payload?: Record<string, unknown> }>,
    abortSignal?: AbortSignal,
    assertInputCurrent?: () => void,
) => {
    const scope = captureSessionScope(store);
    const assertActive = () => { throwIfAborted(abortSignal); assertWorkspaceOwner(store, scope); assertInputCurrent?.(); };
    const start = Date.now();
    const toolName = action.type === 'tool_call' ? action.toolName : 'workspace.read';
    const governance = getToolGovernanceMeta(store, toolName as ToolName);
    const kind = ['workspace.read', 'workspace.list', 'workspace.tree', 'workspace.search', 'workspace.grep', 'workspace.head', 'workspace.diff'].includes(toolName) ? 'inspect' : 'edit';
    try {
        assertActive();
        const result = await run();
        assertActive();
        const entry = buildWorkspaceEntry(action, { path, success: true, message: result.successMessage, output: result.successMessage, durationMs: Date.now() - start, stage: governance.stage, toolCategory: governance.descriptor?.category ?? 'unknown', policyDecision: governance.decision?.allowed === false ? 'blocked' : 'allowed', policyReason: governance.decision?.reason ?? null });
        const current = store.getState().workspaceActionHistory ?? [];
        store.setState({ workspaceActionHistory: [...current, entry].slice(-WORKSPACE_HISTORY_LIMIT) });
        store.getState().logAgentToolUsage({ tool: toolName, description: `workspace success: ${entry.operation} ${entry.path}`, stage: governance.stage, category: governance.descriptor?.category ?? 'unknown', risk: governance.descriptor?.risk ?? 'unknown', policyDecision: governance.decision?.allowed === false ? 'blocked' : 'allowed', policyReason: governance.decision?.reason ?? null, detail: { path: entry.path, operation: entry.operation, success: entry.success, stage: governance.stage, policyDecision: governance.decision?.allowed === false ? 'blocked' : 'allowed', policyReason: governance.decision?.reason ?? null } });
        appendWorkspaceTraceMessage(store, { toolName, path, kind, status: 'done', diffSummary: result.diffSummary, text: `**${toolName}** \`${path}\`\n${result.diffSummary ?? result.successMessage}` });
        return result;
    } catch (error) {
        if (isRuntimeAbortError(error, abortSignal)) {
            throw error;
        }
        assertActive();
        const entry = buildWorkspaceEntry(action, { path, success: false, message: error instanceof Error ? error.message : String(error), durationMs: Date.now() - start, stage: governance.stage, toolCategory: governance.descriptor?.category ?? 'unknown', policyDecision: governance.decision?.allowed === false ? 'blocked' : 'allowed', policyReason: governance.decision?.reason ?? null });
        const current = store.getState().workspaceActionHistory ?? [];
        store.setState({ workspaceActionHistory: [...current, entry].slice(-WORKSPACE_HISTORY_LIMIT) });
        store.getState().logAgentToolUsage({ tool: toolName, description: `workspace failed: ${entry.operation} ${entry.path}`, stage: governance.stage, category: governance.descriptor?.category ?? 'unknown', risk: governance.descriptor?.risk ?? 'unknown', policyDecision: governance.decision?.allowed === false ? 'blocked' : 'allowed', policyReason: governance.decision?.reason ?? entry.message, detail: { path: entry.path, operation: entry.operation, error: entry.message, stage: governance.stage, policyDecision: governance.decision?.allowed === false ? 'blocked' : 'allowed', policyReason: governance.decision?.reason ?? null } });
        appendWorkspaceTraceMessage(store, { toolName, path, kind, status: 'error', text: `**${toolName}** \`${path}\`\nFailed: ${entry.message}`, isError: true });
        throw error;
    }
};

export const executeWorkspaceFileAction = async (
    action: AiAction,
    store: StoreApi,
    options?: { abortSignal?: AbortSignal },
) => {
    const { getState, setState } = store;
    if (action.type !== 'tool_call' || !action.toolName.startsWith('workspace.')) return;
    const workspaceAction: WorkspaceFileAction = {
        ...(action.args ?? {}),
        operation: toWorkspaceOperation(action.toolName),
    };
    const operation = workspaceAction.operation;
    const defaultPath = ['list', 'tree', 'search', 'grep'].includes(operation) ? '/' : operation === 'diff' ? WORKSPACE_DATASET_CLEAN_CSV : '/workspace';
    const requestedPath = String(workspaceAction.path || defaultPath);
    const validatePath = (path: string) => {
        if (!path.startsWith('/') || /[%\\?#\x00-\x1f\x7f]/.test(path) || path.includes('//') || path.split('/').some(part => part === '..' || part === '.') || path.trim() !== path) throw workspacePathDeniedError(path);
    };
    validatePath(requestedPath);
    // Directory scopes tolerate one trailing slash ("/workspace/"); file operations keep the exact path.
    const isScopeOperation = ['list', 'tree', 'search', 'grep'].includes(operation);
    const normalizedPath = isScopeOperation && requestedPath.length > 1 && requestedPath.endsWith('/') ? requestedPath.slice(0, -1) : requestedPath;
    const currentData = getState().csvData;
    const scope = captureSessionScope(store);
    const workspace = currentTaskWorkspace(store);
    const inputBundle = getState().datasetBundle;
    const inputBinding = inputBundle ? { tableId: inputBundle.primaryTableId, datasetId: getState().currentDatasetId, datasetVersion: inputBundle.datasetVersion, relationshipSetId: inputBundle.relationshipSetId, sourceSha256: inputBundle.source.inspection?.sha256 ?? null } : null;
    // "/" is the default search scope; it means "every readable root", and results are filtered below.
    const isRootSearch = normalizedPath === '/' && ['search', 'grep'].includes(operation);
    if (!isWorkspaceReadablePath(normalizedPath) && !['list', 'tree'].includes(operation) && !isRootSearch) throw workspacePathDeniedError(normalizedPath, 'Workspace path not allowed');

    const sourceId = inputBundle?.source.inspection?.sourceId;
    const assertSourceCurrent = operation === 'read' && [SOURCE_RECORDS_PATH, SOURCE_BYTES_PATH].includes(normalizedPath) && sourceId
        ? captureSourceRangeFence(store, sourceId) : undefined;
    return withActionHistory(store, action, normalizedPath, async () => {
        throwIfAborted(options?.abortSignal);
        const bundle = buildWorkspaceBundle(getState());
        const taskFiles = workspace.list().map(artifact => ({ path: artifact.path, label: artifact.path.split('/').at(-1)!, language: 'text' as const, content: artifact.content, group: 'workspace' as const }));
        const allFiles = [...bundle.files.filter(file => !taskFiles.some(task => task.path === file.path)), ...taskFiles];
        const exactMatch = allFiles.find(file => file.path === normalizedPath);
        const readableFiles = allFiles.filter(file => isWorkspaceReadablePath(file.path));
        if (operation === 'list') {
            const base = normalizedPath === '/' || normalizedPath === '' ? '/' : normalizedPath;
            const recursive = Boolean(workspaceAction.recursive);
            const limit = resolveWorkspaceListLimit(workspaceAction.limit as number | undefined);
            const prefix = base === '/' ? '/' : `${base}/`;
            const matched = allFiles.filter(file => { if (!file.path.startsWith(prefix)) return false; if (!recursive) { const relative = file.path.slice(prefix.length); return relative.length > 0 && !relative.includes('/'); } return true; }).map(file => ({ path: file.path, pathType: 'file' }));
            // Virtual files are all nested, so a flat listing must expose directories to be navigable.
            // The root shows only readable roots (plus the writable /workspace), never other stored prefixes.
            const directories = recursive ? [] : base === '/'
                ? WORKSPACE_READABLE_ROOTS.filter(root => root === WORKSPACE_ROOT || readableFiles.some(file => file.path.startsWith(`${root}/`)))
                : [...new Set(allFiles.filter(file => file.path.startsWith(prefix)).map(file => file.path.slice(prefix.length).split('/'))
                    .filter(parts => parts.length > 1).map(parts => `${prefix}${parts[0]}`))].sort();
            // `limit` caps the combined entries, directories first. Totals and `truncated` keep a cut listing truthful.
            const limited = [...directories.map(path => ({ path, pathType: 'directory' })), ...matched].slice(0, limit);
            // Workspace output is cut at WORKSPACE_ACTION_OUTPUT_LIMIT characters. Keep the summary
            // fields ahead of `files` and return only the entries that fit, so the model sees valid
            // JSON whose counts match the entries it actually received.
            const listing = (count: number) => {
                const entries = limited.slice(0, count);
                const returnedDirectories = entries.filter(entry => entry.pathType === 'directory').length;
                return { operation, path: base, recursive, totalFiles: matched.length, totalDirectories: directories.length,
                    returnedFiles: entries.length - returnedDirectories, returnedDirectories,
                    truncated: entries.length < directories.length + matched.length,
                    ...(count < limited.length ? { outputCapped: true } : {}),
                    ...(base === '/' ? { pathRules: WORKSPACE_PATH_RULES } : {}), files: entries };
            };
            const fits = (count: number) => JSON.stringify(listing(count)).length <= WORKSPACE_ACTION_OUTPUT_LIMIT;
            let fitted = limited.length;
            if (!fits(fitted)) {
                // Serialized length grows with the entry count, so binary search the largest count that fits.
                let low = 0;
                let high = limited.length - 1;
                while (low < high) {
                    const middle = Math.ceil((low + high) / 2);
                    if (fits(middle)) low = middle; else high = middle - 1;
                }
                fitted = low;
            }
            const result = listing(fitted);
            const hint = result.outputCapped ? ' (truncated by the output size cap: list a subdirectory)' : result.truncated ? ' (truncated: raise limit or list a subdirectory)' : '';
            return { successMessage: `Listed ${result.returnedFiles} of ${matched.length} workspace file(s) and ${result.returnedDirectories} of ${directories.length} director${directories.length === 1 ? 'y' : 'ies'}${hint}.`,
                output: normalizeWorkspaceOutput(result),
                payload: { workspace: { operation, path: base, changed: false, affectsCleanedDataset: false } } };
        }
        if (operation === 'tree') {
            const base = normalizedPath === '/' || normalizedPath === '' ? '/' : normalizedPath;
            return { successMessage: `Built workspace tree for ${base}.`, output: normalizeWorkspaceOutput({ operation, path: base, tree: buildWorkspaceTree(allFiles, base) }), payload: { workspace: { operation, path: base, changed: false, affectsCleanedDataset: false } } };
        }
        if (operation === 'read' && [SOURCE_RECORDS_PATH, SOURCE_BYTES_PATH].includes(normalizedPath)) {
            const sourceId = getState().datasetBundle?.source.inspection?.sourceId;
            if (!sourceId) throw new Error('source_unavailable: reattach the original CSV.');
            const result = normalizedPath === SOURCE_RECORDS_PATH
                ? await readSourceRecordsBounded(store, sourceId, workspaceAction.startRow ?? 0, workspaceAction.rowCount ?? 20)
                : await readSourceBytesBounded(store, sourceId, workspaceAction.byteOffset ?? 0, workspaceAction.byteLength ?? 1024);
            return { successMessage: `Read bounded immutable source range`, output: normalizeWorkspaceOutput(result), payload: { sourceInspection: result, workspace: { operation, path: normalizedPath, changed: false, affectsCleanedDataset: false } } };
        }
        if (operation === 'read') {
            const revision = isWorkspaceWritablePath(normalizedPath) && !normalizedPath.startsWith('/workspace/task-artifacts/') ? workspace.revision(normalizedPath) : undefined;
            const artifact = revision ? workspace.read(normalizedPath, workspaceAction.revision) : null;
            if (workspaceAction.revision !== undefined && !artifact) throw new Error('workspace_file_unavailable');
            if (!exactMatch && normalizedPath === '/intake/meaning-confirmation.json') {
                throw new Error('meaning_confirmation_not_created: This host-owned file exists only after the user selects a complete source-bound meaning proposal. First submit supported complete original-source proposals through candidate_infer_meaning and follow the returned contract. Only if the host requests a separate human choice should you wait for that choice; an unambiguous compiled contract does not require this file. A header-group choice is not that approval. Do not poll, search for, create or fabricate this confirmation; absence is expected before approval. No Dataset Commit authority is granted.');
            }
            if (!exactMatch) throw new Error(`File not found: ${normalizedPath}`);
            const range = artifact ? workspace.readRange(normalizedPath, workspaceAction.revision, workspaceAction.startOffset ?? 0, workspaceAction.limit ?? WORKSPACE_ACTION_OUTPUT_LIMIT) : null;
            const content = range?.content ?? truncateWorkspaceOutput(exactMatch.content, WORKSPACE_ACTION_OUTPUT_LIMIT);
            return { successMessage: `Read ${normalizedPath}.`, output: normalizeWorkspaceOutput({ content, revision: artifact?.revision ?? revision,
                sha256: artifact?.sha256, complete: range?.complete ?? exactMatch.content.length <= WORKSPACE_ACTION_OUTPUT_LIMIT }),
                payload: { workspace: { operation, path: normalizedPath, changed: false, affectsCleanedDataset: false,
                    revision: artifact?.revision ?? revision, sha256: artifact?.sha256, content,
                    startOffset: range?.startOffset ?? 0, endOffset: range?.endOffset ?? content.length,
                    complete: range?.complete ?? exactMatch.content.length <= WORKSPACE_ACTION_OUTPUT_LIMIT } } };

        }
        if (operation === 'search') {
            const query = String(workspaceAction.query || '');
            if (!query) throw new Error('search requires a non-empty query.');
            const caseSensitive = Boolean(workspaceAction.caseSensitive);
            const queryNeedle = caseSensitive ? query : query.toLowerCase();
            const limit = resolveWorkspaceSearchLimit(workspaceAction.limit as number | undefined);
            const scope = normalizedPath === '/' || normalizedPath === '' ? '/' : normalizedPath;
            const matches = readableFiles.filter(file => file.path.startsWith(scope === '/' ? '/' : `${scope}/`)).map(file => ((caseSensitive ? file.content : file.content.toLowerCase()).includes(queryNeedle) ? { path: file.path, match: true, pathPreview: file.path } : null)).filter((item): item is { path: string; match: boolean; pathPreview: string } => item !== null).slice(0, limit);
            return { successMessage: `Search completed for "${query}"`, output: normalizeWorkspaceOutput(matches), payload: { workspace: { operation, path: scope, changed: false, affectsCleanedDataset: false } } };
        }
        if (operation === 'grep') {
            const query = String(workspaceAction.query || '');
            if (!query) throw new Error('grep requires a non-empty query.');
            const scope = normalizedPath === '/' || normalizedPath === '' ? '/' : normalizedPath;
            return { successMessage: `Grep completed for "${query}".`, output: normalizeWorkspaceOutput({ operation, path: scope, matches: grepWorkspaceFiles(readableFiles, scope, query, resolveWorkspaceSearchLimit(workspaceAction.limit as number | undefined), Boolean(workspaceAction.caseSensitive)) }), payload: { workspace: { operation, path: scope, changed: false, affectsCleanedDataset: false } } };
        }
        if (operation === 'head') {
            if (!exactMatch) throw new Error(`File not found: ${normalizedPath}`);
            const head = headWorkspaceFile(exactMatch, Math.min(50, Math.max(1, Number(workspaceAction.limit ?? 10))));
            return { successMessage: `Read the first ${head.lines.length} line(s) from ${normalizedPath}.`, output: normalizeWorkspaceOutput(head), payload: { workspace: { operation, path: normalizedPath, changed: false, affectsCleanedDataset: false } } };
        }
        if (operation === 'diff') {
            if (workspaceAction.revision !== undefined || workspaceAction.compareRevision !== undefined) {
                const comparePath = workspaceAction.comparePath ?? normalizedPath;
                validatePath(comparePath);
                const after = workspace.read(normalizedPath, workspaceAction.revision);
                const before = workspace.read(comparePath, workspaceAction.compareRevision);
                const diff = diffWorkspaceFiles(comparePath, before.content, normalizedPath, after.content, Math.min(40, Math.max(1, workspaceAction.limit ?? 20)));
                return { successMessage: `Compared immutable task revisions ${before.revision} and ${after.revision}.`, output: normalizeWorkspaceOutput(diff),
                    payload: { workspace: { operation, path: normalizedPath, changed: false, affectsCleanedDataset: false,
                        beforeRevision: before.revision, afterRevision: after.revision, beforeSha256: before.sha256, afterSha256: after.sha256, diff } } };
            }

            if (!exactMatch) throw new Error(`File not found: ${normalizedPath}`);
            const compareNormalizedPath = String(workspaceAction.comparePath || WORKSPACE_DATASET_RAW_CSV);
            validatePath(compareNormalizedPath);
            if (!isWorkspaceReadablePath(compareNormalizedPath)) throw workspacePathDeniedError(compareNormalizedPath, 'Workspace path not allowed');
            const compareFile = allFiles.find(file => file.path === compareNormalizedPath);
            if (!compareFile) throw new Error(`Compare file not found: ${compareNormalizedPath}`);
            const diff = diffWorkspaceFiles(compareNormalizedPath, compareFile.content, normalizedPath, exactMatch.content, Math.min(40, Math.max(1, Number(workspaceAction.limit ?? 20))));
            return { successMessage: `Diff completed between ${compareNormalizedPath} and ${normalizedPath}.`, output: normalizeWorkspaceOutput(diff), payload: { workspace: { operation, path: normalizedPath, comparePath: compareNormalizedPath, changedLines: diff.changedLines, changed: false, affectsCleanedDataset: false } } };
        }

        try { canonicalTaskPath(normalizedPath); } catch { throw workspacePathDeniedError(normalizedPath); }
        if (!isWorkspaceWritablePath(normalizedPath)) throw workspacePathDeniedError(normalizedPath, 'Write permission denied');
        if (operation === 'write' && workspaceAction.content === undefined) throw new Error('write requires content.');
        if (operation === 'append' && workspaceAction.content === undefined) throw new Error('append requires content.');
        if (operation === 'replace' && (workspaceAction.oldText == null || workspaceAction.newText == null)) throw new Error('replace requires oldText and newText.');

        const existingContent = exactMatch?.content ?? '';
        let nextContent = existingContent;
        if (operation === 'write') nextContent = String(workspaceAction.content || '');
        if (operation === 'append') nextContent = `${existingContent}${String(workspaceAction.content || '')}`;
        if (operation === 'replace') {
            const oldText = String(workspaceAction.oldText);
            const newText = String(workspaceAction.newText);
            if (!existingContent.includes(oldText)) throw new Error(`replace target not found in ${normalizedPath}`);
            nextContent = Boolean(workspaceAction.replaceAll) ? existingContent.split(oldText).join(newText) : existingContent.replace(oldText, newText);
        }

        throwIfAborted(options?.abortSignal);
        const artifact = await workspace.write(normalizedPath, nextContent, workspaceAction.expectedRevision as number, () => {
            throwIfAborted(options?.abortSignal);
            assertWorkspaceOwner(store, scope);
        }).catch((error: unknown) => {
            // The task grant (for example another task's /workspace/tasks/ directory) uses the bare code; explain it.
            throw error instanceof Error && error.message === 'workspace_path_denied' ? workspacePathDeniedError(normalizedPath) : error;
        });
        assertWorkspaceOwner(store, scope);
        throwIfAborted(options?.abortSignal);
        if (isWorkspaceDatasetWritePath(normalizedPath) && (getState().csvData !== currentData
            || getState().datasetBundle !== inputBundle)) throw new Error('input_version_changed');
        const { content: _content, ...reference } = artifact;
        const candidate = artifact.kind === 'candidate' ? { ...reference, inputBinding, status: 'staged', validation: 'pending', acceptedDataChanged: false } : null;
        const lineCountBefore = existingContent.length === 0 ? 0 : existingContent.split('\n').length;
        const lineCountAfter = nextContent.length === 0 ? 0 : nextContent.split('\n').length;
        const diffSummary = `Staged ${normalizedPath} revision ${artifact.revision}: ${lineCountBefore} -> ${lineCountAfter} lines. Accepted data is unchanged.`;
        setState(prev => ({ workspaceFiles: {
            ...(prev.workspaceFiles ?? {}),
            ...(artifact.kind === 'program' ? { [normalizedPath]: nextContent } : {}),
            [`/workspace/task-artifacts/${workspace.namespaceId}.json`]: JSON.stringify({ taskId: workspace.taskId,
                namespaceId: workspace.namespaceId, artifacts: workspace.list().map(({ content: _text, ...ref }) => ref),
                candidate, note: 'Transient task files; candidates need independent validation and exact commit approval.' }, null, 2),
        } }));

        return { successMessage: `Staged ${normalizedPath} revision ${artifact.revision}; accepted dataset unchanged`, output: normalizeWorkspaceOutput({ path: normalizedPath, artifact: reference, candidate }), diffSummary, payload: { workspace: { operation, path: normalizedPath, changed: nextContent !== existingContent, affectsCleanedDataset: false, stagedCandidate: candidate, artifact: reference, lineCountBefore, lineCountAfter } } };
    }, options?.abortSignal, assertSourceCurrent);
};
