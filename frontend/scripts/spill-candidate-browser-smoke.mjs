import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { chromium } from '@playwright/test';
const base = process.argv[2] ?? 'http://127.0.0.1:4189';
const output = process.argv[3] ?? '/tmp/spill-candidate-browser.json';
assert.equal(new URL(base).hostname, '127.0.0.1');
const profile = await mkdtemp('/tmp/spill-candidate-profile-');
const assets = await readdir(new URL('../dist/assets/', import.meta.url));
const agent = assets.find(name => /^csv_data_analysis_app-agent-.*\.js$/.test(name));
const code = await readFile(new URL(`../dist/assets/${agent}`, import.meta.url), 'utf8');
const alias = /piCandidateApprovalQualification as (\w+)/.exec(code)?.[1]; assert.ok(alias);
const evidence = { browser: '', workerCount: 0, pageErrors: [], externalAttempts: [], scenarios: [],
    scope: 'Real browser worker/QuickJS/OPFS/tool staging and independent semantics/read-only draft. Synthetic trusted host meaning, NOT inference/coordinator/review/commit/recovery qualification.',
    memoryMethod: 'CDP Runtime.getHeapUsage every 200ms after disk File selection: renderer V8 observed high-water only, not workers/WASM/Blob/OPFS/process memory or a proven peak.' };
let context;
try {
    context = await chromium.launchPersistentContext(profile, { executablePath: '/snap/chromium/current/usr/lib/chromium-browser/chrome', headless: true,
        args: ['--no-sandbox', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'], serviceWorkers: 'block' });
    evidence.browser = context.browser()?.version() ?? 'persistent Chromium';
    await context.route('**/*', route => {
        if (new URL(route.request().url()).origin === new URL(base).origin) return route.continue();
        evidence.externalAttempts.push(route.request().url()); return route.abort();
    });
    for (const rows of [9000, 27000]) {
        const page = await context.newPage(); page.on('pageerror', e => evidence.pageErrors.push(e.message)); page.on('worker', () => evidence.workerCount++);
        const cdp = await context.newCDPSession(page);
        await cdp.send('Storage.clearDataForOrigin', { origin: new URL(base).origin, storageTypes: 'all' });
        await page.goto(base);
        const fixture = `${profile}/synthetic-${rows}.csv`;
        await writeFile(fixture, 'key,payload,value\r\n' + Array.from({ length: rows }, (_, i) =>
            `${i},"${'x'.repeat(1000)}${i === rows - 1 ? 'α\r\n末尾' : ''}",${i % 2 ? '-1' : '0'}${i === rows - 1 ? ',,' : ''}\r\n`).join(''));
        await page.evaluate(() => { const input = document.createElement('input'); input.type = 'file'; input.id = 'spill-fixture'; document.body.append(input); });
        await page.locator('#spill-fixture').setInputFiles(fixture);
        let heap = 0, samples = 0, sampling = false;
        const sample = async () => { if (sampling) return; sampling = true;
            try { heap = Math.max(heap, (await cdp.send('Runtime.getHeapUsage')).usedSize); samples++; } finally { sampling = false; } };
        const timer = setInterval(() => void sample().catch(() => {}), 200), started = Date.now();
        let result;
        try {
            result = await page.evaluate(async ({ agent, alias, rows }) => {
                const qa = (await import(`/assets/${agent}`))[alias];
                const f = await qa.qualifySpillCandidate(rows, undefined, undefined, document.querySelector('#spill-fixture').files[0]);
                try {
                    const before = JSON.stringify(f.root.getState()), r = await f.run(), c = f.port.read(r.candidateId), v = r.validation;
                    if (v?.decision !== 'validated') throw new Error(JSON.stringify(r.validated));
                    const readsBeforeDraft = f.reads.bytes;
                    const first = await f.port.previewAsync(c.candidateId, 'records', v.receiptDigest, 0, 10);
                    const second = await f.port.previewAsync(c.candidateId, 'records', v.receiptDigest, first.offset + first.rows.length, 10);
                    const tail = await f.port.previewAsync(c.candidateId, 'records', v.receiptDigest, rows - 1, 10);
                    let exactCommitBlocked = false;
                    try { qa.createCandidateCommitService(f.store).approve({}); } catch (e) { exactCommitBlocked = e.message === 'approval_invalid'; }
                    const root = await navigator.storage.getDirectory(), app = await root.getDirectoryHandle('csv-analysis-agent-temp');
                    const session = await app.getDirectoryHandle(f.root.getState().sessionId), generation = await session.getDirectoryHandle(`candidate-${c.spill.manifest.generation}`);
                    const saved = await (await (await generation.getFileHandle('manifest.json')).getFile()).text();
                    const file = await generation.getFileHandle('chunk-0.json'), original = await (await file.getFile()).text();
                    const writable = await file.createWritable(); await writable.write(original.replace('xxx', 'yyy')); await writable.close();
                    let corruptBlocked = false;
                    try { await f.port.previewAsync(c.candidateId, 'records', v.receiptDigest, 0, 10); } catch (e) { corruptBlocked = e.message === 'spill_corrupt'; }
                    return { sourceBytes: f.source.byteSize, sourceSha256: f.source.sha256, reads: f.reads, readsBeforeDraft,
                        validation: { decision: v.decision, checks: v.checks, receiptDigest: v.receiptDigest, groups: v.groups },
                        metadataOnly: c.tables[0].rows.length === 0 && c.tables[0].lineage.length === 0,
                        first: { offset: first.offset, returned: first.rows.length, label: first.label }, second: { offset: second.offset, returned: second.rows.length },
                        tail: { key: tail.rows[0].key, value: tail.rows[0].value, utf8Multiline: tail.rows[0].payload.endsWith('α\r\n末尾') },
                        structuralManifest: c.spill.manifest, savedManifestMatches: saved === JSON.stringify(c.spill.manifest),
                        acceptedUnchanged: before === JSON.stringify(f.root.getState()), exactCommitBlocked, corruptBlocked, metrics: r.receipt.sourceStream.metrics };
                } finally { f.adapter.dispose(); }
            }, { agent, alias, rows });
        } finally { clearInterval(timer); await sample(); }
        assert.ok(result.sourceBytes > (rows === 9000 ? 8 : 25) * 1024 * 1024);
        assert.equal(result.reads.bytes, result.sourceBytes * 4 + 3); assert.equal(result.readsBeforeDraft, result.reads.bytes);
        assert.equal(result.reads.fullReads, 0); assert.ok(result.reads.maxBytes <= 65536);
        assert.equal(result.validation.decision, 'validated'); assert.equal(result.metadataOnly, true);
        assert.equal(result.first.label, 'draft_uncommitted'); assert.equal(result.second.offset, result.first.returned);
        assert.equal(result.tail.key, String(rows - 1)); assert.equal(result.tail.value, -1); assert.equal(result.tail.utf8Multiline, true);
        assert.equal(result.savedManifestMatches, true); assert.equal(result.structuralManifest.semanticValidation, 'not_performed');
        assert.equal(result.structuralManifest.commitAllowed, false); assert.equal(result.acceptedUnchanged, true);
        assert.equal(result.exactCommitBlocked, true); assert.equal(result.corruptBlocked, true);
        evidence.scenarios.push({ rows, durationMs: Date.now() - started, sampledRendererHeapHighWaterBytes: heap, heapSamples: samples, ...result });
        console.log(JSON.stringify(evidence.scenarios.at(-1))); await page.close();
    }
    assert.deepEqual(evidence.pageErrors, []); assert.deepEqual(evidence.externalAttempts, []);
    assert.ok(evidence.workerCount >= evidence.scenarios.reduce((sum, r) => sum + r.metrics.batches, 0));
} finally { await writeFile(output, JSON.stringify(evidence, null, 2)); await context?.close(); await rm(profile, { recursive: true, force: true }); }
console.log(`PASS: spill candidate validation/draft only; evidence ${output}`);
