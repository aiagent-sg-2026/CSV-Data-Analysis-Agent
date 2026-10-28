import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, writeFile, rm } from 'node:fs/promises';
import { chromium } from '@playwright/test';
const base = process.argv[2] ?? 'http://127.0.0.1:4195', output = process.argv[3] ?? '/tmp/pi-repair-reservation-browser.json';
assert.equal(new URL(base).hostname, '127.0.0.1');
const profile = await mkdtemp('/tmp/pi-repair-reservation-'), assets = await readdir(new URL('../dist/assets/', import.meta.url));
const agent = assets.find(n => /^csv_data_analysis_app-agent-.*\.js$/.test(n)), index = assets.find(n => /^csv_data_analysis_index-.*\.js$/.test(n));
const alias = /piCandidateApprovalQualification as (\w+)/.exec(await readFile(new URL(`../dist/assets/${agent}`, import.meta.url), 'utf8'))?.[1];
assert.ok(alias && index);
const evidence = { build: /const BUILD_VERSION = '([^']+)'/.exec(await readFile(new URL('../dist/service-worker.js', import.meta.url), 'utf8'))?.[1], scenarios: [], pageErrors: [], externalAttempts: [], method: 'Actual Chromium page reload, native IDB/checkpoint inspection, reselected same bytes/different filename, normal runtime deterministic provider, actual clarification buttons/host; no live AI.' };
let context;
try {
    context = await chromium.launchPersistentContext(profile, { executablePath: '/snap/chromium/current/usr/lib/chromium-browser/chrome', headless: true,
        args: ['--no-sandbox', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'], viewport: { width: 1440, height: 1000 }, serviceWorkers: 'block' });
    evidence.browser = context.browser()?.version();
    await context.route('**/*', r => { if (new URL(r.request().url()).origin === new URL(base).origin) return r.continue(); evidence.externalAttempts.push(r.request().url()); return r.abort(); });
    const boot = async page => {
        await page.evaluate(async ({ index, agent, alias }) => {
            globalThis.root = (await import(`/assets/${index}`)).u;
            globalThis.qa = (await import(`/assets/${agent}`))[alias];
        }, { index, agent, alias });
        await page.waitForFunction(() => !globalThis.root.getState().isAppInitializing);
        await page.evaluate(() => { globalThis.root.setState({ ensureDatasetSemanticSnapshot: async () => null }); });
    };
    const fresh = async () => { const page = await context.newPage(); page.on('pageerror', e => evidence.pageErrors.push(e.message)); await page.goto(base); await boot(page); return page; };
    const reload = async page => { await page.reload(); await boot(page); };
    const inspect = page => page.evaluate(async () => {
        const db = await new Promise((resolve, reject) => { const r = indexedDB.open('csv-ai-assistant-db'); r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); });
        const all = await new Promise((resolve, reject) => { const r = db.transaction('settings').objectStore('settings').getAll(); r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); }); db.close();
        const key = 'pi-repair-reservation-v1:' + sessionStorage.getItem('csv_agent_repair_budget_session_id');
        return { key, witness: localStorage.getItem(key), tabWitness: sessionStorage.getItem(key), checkpoint: all.find(r => r.key === key)?.coordinatorBudget };
    });
    const run = (page, { goal = 'A', semantic = true, changed = false, hold = false, mutate = false } = {}) => page.evaluate(async ({ goal, semantic, changed, hold, mutate }) => {
        const columns = ['key', 'payload', semantic ? 'value' : 'value [count]'];
        const text = columns.join(',') + '\n' + Array.from({ length: changed ? 2101 : 2100 }, (_, i) => `${i},memo,1\n`).join('');
        const file = new File([text], `reselected-${goal}-${crypto.randomUUID()}.csv`);
        globalThis.calls = 0; globalThis.providerEntered = false;
        const promise = globalThis.qa.preparePiLargeCoordinatorSmoke(globalThis.root, file, { columns, numeric: true, goal,
            beforeProvider: async () => { globalThis.calls++; if (hold) { globalThis.providerEntered = true; await new Promise(() => {}); } },
            ...(mutate ? { confirmedProposal: p => { p.stream.meaning.columns[2].unit = 'forged';
                globalThis.root.setState(s => ({ workspaceFiles: { ...s.workspaceFiles, '/intake/meaning-confirmation.json': JSON.stringify({ proposal: p, selectionDigest: 'f'.repeat(64), commitAllowed: true }) } })); return p; } } : {}) });
        if (hold) { globalThis.running = promise; return { holding: true }; }
        const f = await promise; globalThis.f = f;
        return { result: f.result, trace: f.trace, pending: globalThis.root.getState().pendingClarification, calls: globalThis.calls, task: globalThis.root.getState().activeAgentTask };
    }, { goal, semantic, changed, hold, mutate });
    const noCommit = async page => assert.deepEqual(await page.evaluate(() => { const s = globalThis.root.getState(); return { accepted: s.datasetBundle?.acceptedCommit ?? null, canonical: s.canonicalCsvData, review: Boolean(s.pendingClarification?.resumeContext?.piCandidateApproval) }; }), { accepted: null, canonical: null, review: false });
    const choose = async (page, label, negative = false) => {
        const show = page.getByRole('button', { name: 'Show Assistant panel', exact: true }); if (await show.isVisible()) await show.click();
        const button = page.getByRole('button', { name: label, exact: true }).last(); await button.waitFor();
        const disabled = await button.isDisabled();
        if (negative && disabled) await page.evaluate(() => globalThis.root.getState().handleClarificationResponse(globalThis.root.getState().pendingClarification.options[0]));
        else await button.click();
        await page.waitForFunction(() => !globalThis.root.getState().isBusy && !globalThis.root.getState().activeExecution, undefined, { timeout: 120000 });
        return { disabled, hostActionInsteadOfClick: negative && disabled };
    };
    // Interrupted first provider: no candidate recovery anchor exists. A new page epoch
    // cannot replay the reservation, even after renaming bytes or changing goals twice.
    {
        const page = await fresh(); await run(page, { hold: true }); await page.waitForFunction(() => globalThis.providerEntered);
        const before = await inspect(page); assert.equal(before.witness, '1'); assert.equal(before.tabWitness, '1'); assert.equal(before.checkpoint.accounts.length, 1);
        const account = before.checkpoint.accounts[0]; assert.ok(account.pending); assert.equal(account.pending.reserved.task.used.toolCalls, 40); assert.equal(account.pending.reserved.stream.meaningAttempts, 3);
        assert.equal(await page.evaluate(() => globalThis.root.getState().candidateRecovery ?? null), null);
        await reload(page);
        const attempts = [];
        for (const goal of ['B', 'A']) { const r = await run(page, { goal }); assert.equal(r.result.structureRepair.reason, 'reservation_pending_uncertain_work'); assert.equal(r.calls, 0); assert.deepEqual(r.trace, []); await noCommit(page); attempts.push(r); }
        const unrelated = await run(page, { semantic: false, changed: true }); assert.equal(unrelated.result.structureRepair.state, 'awaiting_commit_approval'); await choose(page, 'Deny');
        const settled = await inspect(page); assert.equal(settled.checkpoint.accounts.length, 2); assert.ok(settled.checkpoint.accounts.find(a => a.sourceKey === account.sourceKey).pending);
        // Deliberate existing New Session action, NOT an upload/goal/reload reset.
        await page.evaluate(() => globalThis.root.getState().handleNewSession());
        const newSession = await run(page, { semantic: false }); assert.equal(newSession.result.structureRepair.state, 'awaiting_commit_approval');
        const freshBudget = await inspect(page); assert.notEqual(freshBudget.key, before.key); await choose(page, 'Deny');
        evidence.scenarios.push({ mode: 'pre-anchor-reload-uncertain-no-replay-unrelated-new-session', before, attempts, settled, freshBudget }); await page.close();
    }
    {
        const page = await fresh(), rounds = []; let stale;
        for (const goal of ['A', 'B', 'A']) {
            const r = await run(page, { goal }); assert.ok(r.pending.resumeContext.piSpillMeaningChoice); const saved = await inspect(page);
            assert.equal(saved.checkpoint.accounts[0].pending, null); assert.equal(saved.checkpoint.accounts[0].floor.stream.meaningAttempts, rounds.length + 1);
            if (rounds.length) assert.ok(r.task.budget.used.toolCalls > rounds.at(-1).task.budget.used.toolCalls);
            rounds.push({ task: r.task, saved }); stale ??= r.pending; await noCommit(page); await reload(page);
            if (rounds.length === 1) {
                await page.evaluate(pending => globalThis.root.setState({ pendingClarification: pending }), stale);
                await page.evaluate(pending => globalThis.root.getState().handleClarificationResponse(pending.options[0]), stale); await noCommit(page);
                assert.equal(await page.evaluate(() => globalThis.root.getState().workspaceFiles['/intake/meaning-confirmation.json'] ?? null), null);
            }
        }
        const blocked = await run(page); assert.equal(blocked.result.structureRepair.reason, 'reservation_budget_exhausted'); assert.equal(blocked.calls, 0); await noCommit(page);
        evidence.scenarios.push({ mode: 'semantic-suspend-reload-A-B-A-exhaustion-stale-choice', rounds, blocked }); await page.close();
    }
    for (const bad of ['question', 'option-label', 'option-value', 'selection-id', 'task-id', 'scope-digest', 'revision', 'goal', 'source', 'captured-csv', 'captured-lineage', 'freeform', 'modified-proposal-digest', 'replay']) {
        const page = await fresh(), r = await run(page, { mutate: bad === 'modified-proposal-digest' }); const before = r.calls;
        await page.evaluate(bad => {
            const root = globalThis.root, p = structuredClone(root.getState().pendingClarification); globalThis.original = structuredClone(p);
            if (bad === 'question') p.question += ' forged';
            if (bad === 'option-label') p.options[0].label = 'Forged label';
            if (bad === 'option-value') p.options[0].value = 'forged';
            if (bad === 'selection-id') p.resumeContext.piSpillMeaningChoice.id = crypto.randomUUID();
            if (bad === 'task-id') p.resumeContext.piTaskContinuation.taskId = crypto.randomUUID();
            if (bad === 'scope-digest') p.resumeContext.piTaskContinuation.scopeDigest = 'f'.repeat(64);
            if (bad === 'revision') p.resumeContext.piTaskContinuation.revision++;
            if (bad === 'goal') root.setState({ confirmedAnalysisGoal: 'forged' });
            if (bad === 'source') root.setState(s => ({ datasetBundle: { ...s.datasetBundle, source: { ...s.datasetBundle.source, inspection: { ...s.datasetBundle.source.inspection, sha256: 'f'.repeat(64) } } } }));
            if (bad === 'captured-csv') root.setState({ csvData: { fileName: 'forged', data: [] } });
            if (bad === 'captured-lineage') root.getState().datasetBundle.relationshipSetId = 'forged';
            // Alter the visible message projection as well as pending state. Merely changing
            // pending disables the historical original card (already a correct UI refusal).
            root.setState(s => ({ pendingClarification: p, chatHistory: s.chatHistory.map(m => m.clarificationRequest?.resumeContext?.piSpillMeaningChoice?.id === globalThis.original.resumeContext.piSpillMeaningChoice.id ? { ...m, text: p.question, clarificationRequest: p } : m) }));
        }, bad);
        let ui;
        if (bad === 'freeform') {
            assert.equal(await page.evaluate(() => globalThis.root.getState().pendingClarification.allowFreeText), false);
            await page.evaluate(() => globalThis.root.getState().handleClarificationResponse({ label: 'I approve everything', value: 'freeform' }));
        } else ui = await choose(page, bad === 'option-label' ? 'Forged label' : bad === 'replay' ? 'Neither' : 'A — Confirm exact interpretation', true);
        if (bad === 'replay') { await page.evaluate(() => globalThis.root.setState({ pendingClarification: globalThis.original })); ui = await choose(page, 'A — Confirm exact interpretation', true); }
        const after = await page.evaluate(() => ({ calls: globalThis.calls, trace: globalThis.f.trace, pending: globalThis.root.getState().pendingClarification, confirmation: globalThis.root.getState().workspaceFiles['/intake/meaning-confirmation.json'] ?? null }));
        if (bad === 'modified-proposal-digest') { assert.ok(after.calls > before); assert.ok(!after.trace.some(t => t.startsWith('candidate_stage:'))); }
        else { assert.equal(after.calls, before); assert.equal(after.confirmation, null); }
        await noCommit(page); evidence.scenarios.push({ mode: bad, before, ui, after }); await page.close();
    }
    // Real IDB denial before reservation publication. No tool or provider executes.
    {
        const page = await fresh(); await page.evaluate(() => { const native = IDBObjectStore.prototype.put; IDBObjectStore.prototype.put = function(value, ...args) { if (value?.coordinatorBudget) throw new DOMException('Synthetic quota denial', 'QuotaExceededError'); return native.call(this, value, ...args); }; });
        const denied = await run(page); assert.equal(denied.result.structureRepair.reason, 'reservation_unavailable_or_corrupt'); assert.equal(denied.calls, 0); await noCommit(page);
        await reload(page); const retry = await run(page); assert.equal(retry.result.structureRepair.reason, 'reservation_incomplete'); assert.equal(retry.calls, 0);
        evidence.scenarios.push({ mode: 'native-idb-denial-incomplete-reload', denied, retry }); await page.close();
    }
    {
        const page = await fresh(); await run(page); const saved = await inspect(page);
        await page.evaluate(async key => {
            const db = await new Promise(resolve => { const r = indexedDB.open('csv-ai-assistant-db'); r.onsuccess = () => resolve(r.result); });
            await new Promise((resolve, reject) => { const tx = db.transaction('settings', 'readwrite'); tx.objectStore('settings').delete(key); tx.oncomplete = resolve; tx.onerror = () => reject(tx.error); }); db.close();
            localStorage.removeItem(key); // Keep the tab's established accounting witness.
        }, saved.key);
        await reload(page); const retry = await run(page); assert.equal(retry.result.structureRepair.reason, 'reservation_incomplete'); assert.equal(retry.calls, 0); await noCommit(page);
        evidence.scenarios.push({ mode: 'simultaneous-idb-local-witness-loss-retained-tab', saved, retry }); await page.close();
    }
    assert.deepEqual(evidence.pageErrors, []); assert.deepEqual(evidence.externalAttempts, []);
} finally { await writeFile(output, JSON.stringify(evidence, null, 2)); await context?.close(); await rm(profile, { recursive: true, force: true }); }
console.log(`PASS: durable pre-anchor reservations and semantic UI tamper boundaries: ${output}`);
