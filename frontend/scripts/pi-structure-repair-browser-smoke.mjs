import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { chromium } from '@playwright/test';

// Source-build, deterministic-provider qualification. No external application AI calls.
const base = process.argv[2] ?? 'http://127.0.0.1:4179';
assert.equal(new URL(base).hostname, '127.0.0.1');
const artifacts = await mkdtemp('/tmp/pi-source-repair-browser-');
const profile = await mkdtemp('/tmp/pi-source-repair-profile-');
const assets = await readdir(new URL('../dist/assets/', import.meta.url));
const agent = assets.find(name => /^csv_data_analysis_app-agent-.*\.js$/.test(name));
const index = assets.find(name => /^csv_data_analysis_index-.*\.js$/.test(name));
const code = await readFile(new URL(`../dist/assets/${agent}`, import.meta.url), 'utf8');
const alias = /piCandidateApprovalQualification as (\w+)/.exec(code)?.[1];
assert.ok(alias && index);
const sw = await readFile(new URL('../dist/service-worker.js', import.meta.url), 'utf8');
const evidence = { build: /const BUILD_VERSION = '([^']+)'/.exec(sw)?.[1], browser: '', renderer: '', pageErrors: [], externalAttempts: [], workers: [], scenarios: [] };
let context;
try {
    context = await chromium.launchPersistentContext(profile, {
        executablePath: '/snap/chromium/current/usr/lib/chromium-browser/chrome', headless: false,
        args: ['--no-sandbox', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
        viewport: { width: 1440, height: 1000 }, serviceWorkers: 'block',
    });
    evidence.browser = context.browser()?.version() ?? 'persistent Chromium';
    await context.route('**/*', route => {
        const url = new URL(route.request().url());
        if (url.origin === new URL(base).origin) return route.continue();
        evidence.externalAttempts.push(url.origin); return route.abort();
    });
    for (const mode of ['repair', 'retry', 'no-progress']) {
        // Fresh page/storage per scenario prevents previously approved data from contaminating evidence.
        const page = await context.newPage();
        page.on('pageerror', error => evidence.pageErrors.push(error.message));
        page.on('worker', worker => evidence.workers.push(worker.url()));
        const cdp = await context.newCDPSession(page);
        await cdp.send('Storage.clearDataForOrigin', { origin: new URL(base).origin, storageTypes: 'all' });
        await page.goto(base);
        await page.getByText('Select a file', { exact: true }).waitFor();
        assert.equal(await (await page.request.get(`${base}/service-worker.js`)).text(), sw);
        await cdp.send('Performance.enable');
        const before = await cdp.send('Performance.getMetrics');
        const result = await page.evaluate(async ({ agent, index, alias, mode }) => {
            const root = (await import(`/assets/${index}`)).u;
            const qa = (await import(`/assets/${agent}`))[alias];
            // Unrelated external semantic annotation is a local service double; repair meaning/validation are real.
            root.setState({ ensureDatasetSemanticSnapshot: async () => null });
            const f = await qa.preparePiStructureRepairSmoke(root, { mode });
            const gl = document.createElement('canvas').getContext('webgl');
            const debug = gl?.getExtension('WEBGL_debug_renderer_info');
            const renderer = gl && debug ? gl.getParameter(debug.UNMASKED_RENDERER_WEBGL) : 'unavailable';
            const state = root.getState();
            let draftQueryBlocked = false;
            try { await qa.queryPiStructureRepairSmoke(root); } catch (e) { draftQueryBlocked = e.message.includes('draft_is_not_accepted'); }
            globalThis.repairQa = { root, qa, f };
            return { result: f.result, trace: f.trace, renderer, draftQueryBlocked, sourceBytes: f.source.byteSize, sourceSha: f.source.sha256,
                pending: Boolean(state.pendingClarification?.resumeContext?.piCandidateApproval), accepted: state.datasetBundle?.acceptedCommit ?? null,
                canonical: state.canonicalCsvData, cards: state.analysisCards.length, oldRunId: f.result.runtimeRunId,
                oldBudget: state.activeAgentTask?.budget, taskId: state.activeAgentTask?.taskId, leaseReleased: !state.activeExecution };
        }, { agent, index, alias, mode });
        evidence.renderer = result.renderer; assert.match(result.renderer, /SwiftShader/i);
        assert.equal(result.result.status, 'blocked', JSON.stringify(result));
        assert.equal(result.draftQueryBlocked, true); assert.equal(result.accepted, null);
        assert.equal(result.canonical, null); assert.equal(result.cards, 0);
        assert.equal(result.leaseReleased, true);
        if (mode === 'no-progress') {
            assert.equal(result.result.structureRepair.state, 'exhausted');
            assert.equal(result.result.structureRepair.attempts, 2); assert.equal(result.pending, false);
            result.goalRevisits = await page.evaluate(async () => {
                const { root, f } = globalThis.repairQa, oldBudget = root.getState().activeAgentTask.budget;
                const different = await f.retrySameSource('Different repair goal B');
                const original = await f.retrySameSource();
                const bundle = root.getState().datasetBundle;
                root.setState({ datasetBundle: { ...bundle, source: { ...bundle.source, inspection: undefined } } });
                const unavailable = await f.retrySameSource();
                root.setState({ datasetBundle: bundle });
                const reattached = await f.retrySameSource(), state = root.getState();
                return { different, original, unavailable, reattached, oldBudget, budget: state.activeAgentTask.budget,
                    accepted: state.datasetBundle.acceptedCommit ?? null, canonical: state.canonicalCsvData, cards: state.analysisCards.length };
            });
            for (const outcome of [result.goalRevisits.different, result.goalRevisits.original, result.goalRevisits.reattached]) {
                assert.equal(outcome.structureRepair.state, 'exhausted');
                assert.equal(outcome.structureRepair.attempts, 2); assert.equal(outcome.structureRepair.validationFailures, 2);
                assert.equal(outcome.error.retryable, false);
            }
            assert.equal(result.goalRevisits.unavailable.structureRepair.state, 'unavailable');
            assert.equal(result.goalRevisits.unavailable.structureRepair.reason, 'source_required');
            assert.equal(result.goalRevisits.unavailable.error.retryable, true);
            for (const dimension of ['toolCalls', 'skillReads', 'providerTurns', 'transformationAttempts']) {
                assert.equal(result.goalRevisits.budget.used[dimension], result.goalRevisits.oldBudget.used[dimension]);
            }
            assert.ok(result.goalRevisits.budget.used.activeMs >= result.goalRevisits.oldBudget.used.activeMs);
            assert.equal(result.goalRevisits.accepted, null); assert.equal(result.goalRevisits.canonical, null); assert.equal(result.goalRevisits.cards, 0);
        } else {
            assert.equal(result.result.structureRepair.state, 'awaiting_commit_approval');
            assert.equal(result.result.structureRepair.attempts, mode === 'retry' ? 2 : 1); assert.equal(result.pending, true);
            const showAssistant = page.getByRole('button', { name: 'Show Assistant panel', exact: true });
            if (await showAssistant.isVisible()) await showAssistant.click();
            await page.getByRole('button', { name: 'Inspect task', exact: true }).click();
            const review = page.getByRole('dialog', { name: 'Task inspection', exact: true });
            await review.getByRole('button', { name: 'Review', exact: true }).click();
            await review.getByText('Decision: validated', { exact: true }).waitFor();
            await page.screenshot({ path: `${artifacts}/${mode}-validated-review.png` });
            await review.getByRole('button', { name: 'Approve', exact: true }).click();
            await page.waitForFunction(() => {
                const state = globalThis.repairQa.root.getState();
                return !state.isBusy && state.datasetCommitBindingStatus === 'ready' && state.datasetBundle?.acceptedCommit && !state.pendingClarification;
            }, undefined, { timeout: 60000 });
            const committed = await page.evaluate(async () => {
                const { root, qa, f } = globalThis.repairQa;
                const queries = await qa.queryPiStructureRepairSmoke(root), state = root.getState();
                return { queries, commit: state.datasetBundle.acceptedCommit, binding: state.datasetCommitBindingStatus,
                    rows: state.csvData.data, rawPreserved: JSON.stringify(state.rawCsvData) === JSON.stringify(f.data),
                    newRunId: state.taskInspection?.runId, taskId: state.activeAgentTask?.taskId, budget: state.activeAgentTask?.budget,
                    cards: state.analysisCards.map(c => ({ id: c.id, version: c.provenance?.datasetVersion })),
                    datasetVersion: state.datasetBundle.datasetVersion };
            });
            assert.equal(committed.queries.length, 10); assert.equal(committed.binding, 'ready');
            assert.equal(committed.rawPreserved, true); assert.equal(committed.rows.length, 3);
            assert.equal(committed.taskId, result.taskId); assert.notEqual(committed.newRunId, result.oldRunId);
            assert.ok(committed.cards.length > 0); assert.ok(committed.cards.every(c => c.version === committed.datasetVersion));
            assert.ok(committed.queries.every(q => q.engine === 'duckdb' && q.sql && q.loadVersion));
            result.committed = committed;
        }
        const after = await cdp.send('Performance.getMetrics');
        const metric = (m, name) => m.metrics.find(v => v.name === name)?.value;
        result.memory = { jsHeapBefore: metric(before, 'JSHeapUsedSize'), jsHeapAfter: metric(after, 'JSHeapUsedSize'),
            taskDurationSeconds: metric(after, 'TaskDuration') - metric(before, 'TaskDuration'), note: 'Renderer JS heap snapshots, not browser/worker total RSS or peak memory.' };
        await page.screenshot({ path: `${artifacts}/${mode}.png` }); evidence.scenarios.push({ mode, ...result });
        await page.evaluate(async () => {
            // The scenario database is intentionally isolated to this temporary profile. Reload discards host capabilities.
            globalThis.repairQa = undefined;
        });
        await page.close();
        // The next scenario clears IndexedDB/local storage before navigating its fresh page.
        await context.clearCookies();
    }
    assert.ok(evidence.workers.some(url => /javascriptGuestWorker/.test(url)), 'Real JavaScript guest worker must run');
    assert.ok(evidence.workers.some(url => /duckDbWorker/.test(url)), 'Real DuckDB worker must run');
    assert.deepEqual(evidence.pageErrors, []);
} finally {
    await context?.close(); await rm(profile, { recursive: true });
    await writeFile(`${artifacts}/evidence.json`, JSON.stringify(evidence, null, 2));
    console.log(JSON.stringify({ artifacts, ...evidence }, null, 2));
}
