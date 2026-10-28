import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { chromium } from '@playwright/test';

// Deterministic provider; normal production coordinator, protected original bytes, actual
// QuickJS/host validation and existing React clarification/draft UI. No real provider calls.
const base = process.argv[2] ?? 'http://127.0.0.1:4187';
const output = process.argv[3] ?? '/tmp/pi-dual-grain-browser.json';
assert.equal(new URL(base).hostname, '127.0.0.1');
const profile = await mkdtemp('/tmp/pi-dual-grain-profile-');
const assets = await readdir(new URL('../dist/assets/', import.meta.url));
const agent = assets.find(n => /^csv_data_analysis_app-agent-.*\.js$/.test(n));
const index = assets.find(n => /^csv_data_analysis_index-.*\.js$/.test(n));
const alias = /piCandidateApprovalQualification as (\w+)/.exec(await readFile(new URL(`../dist/assets/${agent}`, import.meta.url), 'utf8'))?.[1];
assert.ok(alias && index);
const sw = await readFile(new URL('../dist/service-worker.js', import.meta.url), 'utf8');
const evidence = { build: /const BUILD_VERSION = '([^']+)'/.exec(sw)?.[1], pageErrors: [], externalAttempts: [], workers: [], scenarios: [],
    method: 'Synthetic source intake only; deterministic provider proposals. Normal Pi coordinator/public tools, real QuickJS and independent host validator. Positive state is never injected. Real React meaning choices and both draft previews. Exact human React approval, native table-scoped DuckDB, durable reload. No live provider.' };
let context;
try {
    context = await chromium.launchPersistentContext(profile, { executablePath: '/snap/chromium/current/usr/lib/chromium-browser/chrome', headless: false,
        args: ['--no-sandbox', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'], viewport: { width: 1440, height: 1000 }, serviceWorkers: 'block' });
    evidence.browser = context.browser()?.version();
    await context.route('**/*', route => { if (new URL(route.request().url()).origin === new URL(base).origin) return route.continue(); evidence.externalAttempts.push(route.request().url()); return route.abort(); });
    for (const mode of ['A42', 'A60', 'A90', 'B90', 'documents90', 'denyA90', 'neither', 'choice-tamper', 'proposal-tamper', 'guest-tamper', 'program-revision']) {
        const page = await context.newPage(), cdp = await context.newCDPSession(page);
        page.on('console', m => { if (m.type() === 'error' || m.type() === 'warning') console.log('BROWSER', m.type(), m.text()); });
        page.on('pageerror', e => evidence.pageErrors.push(e.message)); page.on('worker', w => evidence.workers.push(w.url()));
        await cdp.send('Storage.clearDataForOrigin', { origin: new URL(base).origin, storageTypes: 'all' });
        try {
            await page.goto(base); await page.getByText('Select a file', { exact: true }).waitFor();
            assert.equal(await (await page.request.get(`${base}/service-worker.js`)).text(), sw);
            await page.evaluate(async ({ index }) => { globalThis.qaRoot = (await import(`/assets/${index}`)).u; }, { index });
            await page.waitForFunction(() => !globalThis.qaRoot.getState().isAppInitializing);
            const initial = await page.evaluate(async ({ agent, alias, mode }) => {
                const root = globalThis.qaRoot, qa = (await import(`/assets/${agent}`))[alias];
                root.setState({ ensureDatasetSemanticSnapshot: async () => null }); // Unrelated external annotation only.
                const f = await qa.preparePiDualGrainSmoke(root, { width: mode === 'A42' ? 42 : mode === 'A60' ? 60 : 90,
                    ...(mode === 'documents90' ? { layout: 'document_rows' } : {}),
                    ...(mode === 'guest-tamper' ? { fault: 'value' } : {}), ...(mode === 'program-revision' ? { fault: 'program_revision' } : {}),
                    ...(mode === 'proposal-tamper' ? { confirmedProposal: p => ({ ...p, assumptions: ['Changed after semantic selection'] }) } : {}) });
                globalThis.dualQa = { root, f };
                const gl = document.createElement('canvas').getContext('webgl'), debug = gl?.getExtension('WEBGL_debug_renderer_info');
                return { result: f.result, pending: root.getState().pendingClarification, source: f.source, widths: f.fixture.raw.map(r => r.length),
                    programs: root.getState().taskInspection?.programs.length, renderer: debug && gl.getParameter(debug.UNMASKED_RENDERER_WEBGL) };
            }, { agent, alias, index, mode });
            assert.ok(initial.pending?.resumeContext?.piSpillMeaningChoice, JSON.stringify(initial));
            assert.equal(initial.programs, 0); assert.match(initial.renderer, /SwiftShader/i);
            const show = page.getByRole('button', { name: 'Show Assistant panel', exact: true }); if (await show.isVisible()) await show.click();
            if (mode === 'choice-tamper') {
                // Negative only: alter the rendered question while preserving the valid selection ID.
                // The live host capsule must refuse it; this mutation never produces positive state.
                await page.evaluate(() => {
                    const { root } = globalThis.dualQa, p = structuredClone(root.getState().pendingClarification);
                    p.question += ' Altered displayed mapping.';
                    root.setState(s => ({ pendingClarification: p, chatHistory: s.chatHistory.map(m => m.clarificationRequest?.resumeContext?.piSpillMeaningChoice?.id === p.resumeContext.piSpillMeaningChoice.id ? { ...m, text: p.question, clarificationRequest: p } : m) }));
                });
            }
            const choice = mode === 'neither' ? 'Neither' : mode === 'B90' ? 'B — Confirm alternative interpretation' : 'A — Confirm exact interpretation';
            await page.getByRole('button', { name: choice, exact: true }).click();
            await page.waitForFunction(() => !globalThis.qaRoot.getState().isBusy && !globalThis.qaRoot.getState().activeExecution, undefined, { timeout: 120000 });
            const after = await page.evaluate(() => {
                const { root, f } = globalThis.dualQa, s = root.getState();
                return { task: s.activeAgentTask, inspection: s.taskInspection, pending: s.pendingClarification, accepted: s.datasetBundle.acceptedCommit ?? null,
                    progress: JSON.parse(s.workspaceFiles['/intake/repair-task.json']), sameOriginalData: s.csvData === f.data, canonical: s.canonicalCsvData, cards: s.analysisCards.length, queries: s.queryHistory.length, trace: f.trace };
            });
            assert.equal(after.accepted, null); assert.equal(after.canonical, null); assert.equal(after.sameOriginalData, true); assert.equal(after.cards, 0); assert.equal(after.queries, 0);
            if (/^(A|B)|^documents|^deny/.test(mode)) {
                assert.ok(after.pending?.resumeContext?.piCandidateApproval);
                assert.equal(after.inspection.candidate.validation.decision, 'validated', JSON.stringify(after));
                assert.equal(after.progress.state, 'awaiting_commit_approval');
                assert.ok(after.task.budget.used.providerTurns < after.task.budget.limits.providerTurns);
                await page.getByRole('button', { name: 'Inspect task', exact: true }).click();
                const review = page.getByRole('dialog', { name: 'Task inspection', exact: true });
                await review.getByRole('button', { name: 'Review', exact: true }).click();
                await review.getByText('Decision: validated', { exact: true }).waitFor();
                await review.getByText('Exact approval publishes both tables together', { exact: false }).waitFor();
                const sections = review.getByRole('region', { name: 'Validated candidate draft', exact: true });
                assert.equal(await sections.count(), 2);
                const previews = [];
                for (let i = 0; i < 2; i++) {
                    await sections.nth(i).getByRole('button', { name: 'Read draft from start', exact: true }).click();
                    const rows = sections.nth(i).getByLabel('Draft rows', { exact: true }); await rows.waitFor();
                    previews.push(JSON.parse(await rows.innerText()));
                }
                if (mode === 'documents90') {
                    assert.deepEqual(previews[0].map(r => r['Cost [USD]']), [250, 150]);
                    assert.deepEqual(previews[1].map(r => r['Cost [USD]']), [0, -1.25, 2.5, 3]);
                } else {
                    assert.deepEqual(previews[0].map(r => r['Cost [USD]']), [250, 30, 120]);
                    assert.deepEqual(previews[1].slice(0, 3).map(r => r['Value [USD]']), [null, 0, -1.25]);
                    assert.equal(previews[1][0].Metric, mode === 'B90' ? 'Period12:Category5' : 'Period1:Category1');
                }
                assert.equal(await review.getByRole('button', { name: 'Approve', exact: true }).count(), 1);
                await page.screenshot({ path: `${output}.${mode}.png`, fullPage: true });
                after.renderedRows = previews;
                await review.getByRole('button', { name: mode === 'denyA90' ? 'Deny' : 'Approve', exact: true }).click();
                await page.waitForFunction(() => !globalThis.qaRoot.getState().isBusy && !globalThis.qaRoot.getState().activeExecution, undefined, { timeout: 120000 });
                if (mode === 'denyA90') {
                    assert.equal(await page.evaluate(() => globalThis.qaRoot.getState().datasetBundle.acceptedCommit ?? null), null);
                } else {
                    const query = async () => page.evaluate(async ({ agent, alias, mode }) => {
                        const root = globalThis.qaRoot, s = root.getState(), qa = (await import(`/assets/${agent}`))[alias];
                        if (s.datasetCommitBindingStatus !== 'ready') throw new Error(JSON.stringify({ binding: s.datasetCommitBindingStatus, pending: s.pendingClarification, messages: s.chatHistory.slice(-3) }));
                        const entity = s.datasetBundle.tables.find(t => t.name === 'entities'), metric = s.datasetBundle.tables.find(t => t.name === 'metrics');
                        const aggregate = (tableId, fn, column) => ({ tableId, aggregates: [{ function: fn, ...(column ? { column } : {}), as: 'n' }] });
                        const value = mode === 'documents90' ? 'Cost [USD]' : 'Value [USD]';
                        const questions = [
                            ['How many entities?', aggregate(entity.tableId, 'count')],
                            ['List entity identifiers.', { tableId: entity.tableId, select: ['Id'], orderBy: [{ column: 'Id', direction: 'asc' }] }],
                            ['Total entity cost?', aggregate(entity.tableId, 'sum', 'Cost [USD]')],
                            ['Total entity net?', aggregate(entity.tableId, 'sum', 'Net [USD]')],
                            ['Cost per entity?', { tableId: entity.tableId, select: ['Id', 'Cost [USD]'], orderBy: [{ column: 'Id', direction: 'asc' }] }],
                            ['How many metric rows?', aggregate(metric.tableId, 'count')],
                            ['How many reported metric values?', aggregate(metric.tableId, 'count', value)],
                            ['Total metric cost (not entity summaries)?', aggregate(metric.tableId, 'sum', value)],
                            ['Smallest metric?', aggregate(metric.tableId, 'min', value)],
                            ['Largest metric?', aggregate(metric.tableId, 'max', value)],
                        ];
                        const results = [];
                        for (const [question, plan] of questions) { const q = await qa.executeManagedDataQuery(s.csvData, plan, [], { allowNativeFallback: false, bypassCache: true });
                            results.push({ question, plan, rows: q.result.rows, engine: q.engine, sql: q.sqlPreview, loadVersion: q.loadVersion, boundary: q.result.executionBoundary,
                                table: s.datasetBundle.tables.find(t => t.tableId === plan.tableId), relationship: s.datasetBundle.relationships[0], source: s.datasetBundle.source.inspection.sha256 }); }
                        let joinError; try { await qa.executeManagedDataQuery(s.csvData, { tableId: entity.tableId, rawSql: 'SELECT * FROM entities JOIN metrics USING (Id)' }, [], {}); } catch(e) { joinError = e.message; }
                        return { commit: s.datasetBundle.acceptedCommit, results, joinError };
                    }, { agent, alias, mode });
                    const verify = actual => {
                        assert.equal(actual.results.length, 10); assert.equal(actual.joinError, 'accepted_dual_joins_sql_unsupported');
                        for (const q of actual.results) { assert.equal(q.engine, 'duckdb'); assert.ok(q.sql && q.loadVersion && q.boundary && q.source && q.table.tableId); }
                        const doc = mode === 'documents90', m = mode === 'A42' ? 12 : mode === 'A60' ? 30 : 60;
                        const rows = actual.results.map(q => q.rows);
                        assert.equal(String(rows[0][0].n), doc ? '2' : '3');
                        assert.deepEqual(rows[1].map(r => r.Id), doc ? ['D1','D2'] : ['E1','E2','E3']);
                        assert.equal(rows[2][0].n, '400.00'); assert.equal(rows[3][0].n, '-400.00');
                        assert.deepEqual(rows[4].map(r => r['Cost [USD]']), doc ? ['250.00','150.00'] : ['250.00','30.00','120.00']);
                        assert.equal(String(rows[5][0].n), String(doc ? 4 : 3*m));
                        assert.equal(String(rows[6][0].n), String(doc ? 4 : 3*(m-1)));
                        assert.equal(rows[7][0].n, doc ? '4.25' : (((m-3)*603-375)/100).toFixed(2));
                        assert.equal(rows[8][0].n, '-1.25'); assert.equal(rows[9][0].n, doc ? '3.00' : '3.01');
                    };
                    after.acceptedQueries = await query(); verify(after.acceptedQueries);
                    await page.reload();
                    await page.evaluate(async ({ index }) => { globalThis.qaRoot = (await import(`/assets/${index}`)).u; }, { index });
                    await page.waitForFunction(() => !globalThis.qaRoot.getState().isAppInitializing);
                    if (!await page.getByRole('button', { name: 'Restore local rows', exact: true }).count()) {
                        await page.getByRole('button', { name: 'History', exact: true }).click();
                        await page.getByRole('button', { name: 'Resume analysis', exact: true }).first().click();
                    }
                    await page.getByRole('button', { name: 'Restore local rows', exact: true }).click();
                    await page.waitForFunction(() => { const s = globalThis.qaRoot.getState(); return !s.isBusy && !s.activeExecution && s.csvData && s.datasetCommitBindingStatus === 'ready'; }, undefined, { timeout: 120000 });
                    after.restoredQueries = await query(); verify(after.restoredQueries);
                    assert.equal(after.restoredQueries.commit.commitId, after.acceptedQueries.commit.commitId);
                }
            } else if (mode === 'guest-tamper') {
                assert.equal(after.inspection.candidate.validation.decision, 'blocked');
                assert.ok(after.inspection.candidate.validation.reasons.includes('validation_transformed_value_mismatch'));
            } else {
                assert.ok(!after.inspection?.candidate);
                if (mode === 'neither' || mode === 'choice-tamper') assert.equal(after.inspection.programs.length, 0);
                if (mode === 'proposal-tamper') assert.ok(after.trace.join('\n').includes('meaning_dual_grain_alternatives_required'));
                if (mode === 'program-revision') assert.ok(after.trace.join('\n').includes('workspace_conflict'));
            }
            evidence.scenarios.push({ mode, initial, after }); console.log('PASS', mode);
        } finally { await page.close(); }
    }
    assert.deepEqual(evidence.pageErrors, []);
    // The unrelated default-provider UI may attempt session bootstrap. Routing aborts it
    // before dispatch; no session is created/renewed and no model request is allowed.
    assert.ok(evidence.externalAttempts.every(url => new URL(url).pathname === '/demo/session'));
    evidence.externalTraffic = 'All external requests aborted locally before dispatch; session bootstrap attempts retained above. Zero real sessions/model calls.';
} finally { await writeFile(output, JSON.stringify(evidence, null, 2)); await context?.close(); await rm(profile, { recursive: true, force: true }); }
console.log(`PASS: bounded dual-grain exact commit/ten native questions/reload and fail-closed choices: ${output}`);
