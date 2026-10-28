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
    method: 'Synthetic source intake only; deterministic provider proposals. Normal Pi coordinator/public tools, real QuickJS and independent host validator. Positive state is never injected. Real React meaning choices and both draft previews. No commit or live provider.' };
let context;
try {
    context = await chromium.launchPersistentContext(profile, { executablePath: '/snap/chromium/current/usr/lib/chromium-browser/chrome', headless: false,
        args: ['--no-sandbox', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'], viewport: { width: 1440, height: 1000 }, serviceWorkers: 'block' });
    evidence.browser = context.browser()?.version();
    await context.route('**/*', route => { if (new URL(route.request().url()).origin === new URL(base).origin) return route.continue(); evidence.externalAttempts.push(route.request().url()); return route.abort(); });
    for (const mode of ['A42', 'A60', 'A90', 'B90', 'documents90', 'neither', 'choice-tamper', 'proposal-tamper', 'guest-tamper', 'program-revision']) {
        const page = await context.newPage(), cdp = await context.newCDPSession(page);
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
            assert.ok(!after.pending?.resumeContext?.piCandidateApproval);
            if (/^(A|B)|^documents/.test(mode)) {
                assert.equal(after.inspection.candidate.validation.decision, 'validated', JSON.stringify(after));
                assert.equal(after.progress.state, 'validated_draft'); assert.equal(after.progress.reason, 'candidate_multi_table_atomic_promotion_unavailable');
                assert.ok(after.task.budget.used.providerTurns < after.task.budget.limits.providerTurns);
                await page.getByRole('button', { name: 'Inspect task', exact: true }).click();
                const review = page.getByRole('dialog', { name: 'Task inspection', exact: true });
                await review.getByRole('button', { name: 'Review', exact: true }).click();
                await review.getByText('Decision: validated', { exact: true }).waitFor();
                await review.getByText('Multi-table Draft / Uncommitted.', { exact: false }).waitFor();
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
                assert.equal(await review.getByRole('button', { name: 'Approve', exact: true }).count(), 0);
                await page.screenshot({ path: `${output}.${mode}.png`, fullPage: true });
                after.renderedRows = previews;
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
console.log(`PASS: dual-grain drafts and fail-closed choices/tampering, no accepted change: ${output}`);
