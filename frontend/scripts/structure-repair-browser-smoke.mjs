import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { chromium, expect } from '@playwright/test';

// Run against a locally served frontend/dist. No provider consent or external traffic is allowed.
const base = process.argv[2] ?? 'http://127.0.0.1:4173';
assert.equal(new URL(base).hostname, '127.0.0.1');
const artifacts = await mkdtemp('/tmp/csv-repair-browser-');
const groups = Array.from({ length: 12 }, (_, i) => `Band ${i + 1}`);
const leaves = Array.from({ length: 5 }, (_, i) => `Type ${i + 1}`);
const rows = [
    ['Fictional report'],
    [...Array.from({ length: 14 }, (_, i) => `Descriptor ${i}`), ...groups, ...groups, 'Tail 1', 'Tail 2', 'Tail 3', 'Tail 4'],
    groups.flatMap(() => leaves),
    ...Array.from({ length: 3 }, (_, i) => Array.from({ length: 90 }, (_, j) => j === 0 ? `entity-${i}` : String(i + j))),
    ['TOTAL', 'unverified'], ...Array.from({ length: 4 }, (_, i) => [`Summary ${i + 2}`]),
];
const text = rows.map(row => row.join(',')).join('\r\n');
const sourceSha = createHash('sha256').update(text).digest('hex');
const expectedSw = await readFile(new URL('../dist/service-worker.js', import.meta.url), 'utf8');
const expectedBuild = expectedSw.match(/const BUILD_VERSION = '([^']+)'/)[1];
const evidence = { expectedBuild, sourceSha, browser: '', renderer: '', scenarios: [], pageErrors: [], blockedExternalOrigins: [], profilesRemaining: 0 };
const profile = await mkdtemp('/tmp/csv-repair-profile-');
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
        evidence.blockedExternalOrigins.push(url.origin);
        return route.abort();
    });
    const page = await context.newPage();
    page.on('pageerror', error => evidence.pageErrors.push(error.message));
    page.on('dialog', dialog => dialog.accept());
    await page.goto(base);
    await page.getByText('Select a file', { exact: true }).waitFor();
    const servedSw = await (await page.request.get(`${base}/service-worker.js`)).text();
    assert.equal(servedSw, expectedSw, 'Must test this local build, not an old service worker');
    evidence.renderer = await page.evaluate(() => {
        const gl = document.createElement('canvas').getContext('webgl');
        const debug = gl?.getExtension('WEBGL_debug_renderer_info');
        return gl && debug ? gl.getParameter(debug.UNMASKED_RENDERER_WEBGL) : 'unavailable';
    });
    assert.match(evidence.renderer, /SwiftShader/i);
    await page.locator('input[type=file]').first().setInputFiles({ name: 'synthetic-report.csv', mimeType: 'text/csv', buffer: Buffer.from(text) });
    await page.getByRole('button', { name: 'Use local processing only' }).click();
    const open = () => page.getByRole('button', { name: 'Review structural interpretations', exact: true }).click({ timeout: 60000 });
    await open();
    await page.getByRole('button', { name: 'Choose A — confirm meaning' }).waitFor();
    assert.equal(await page.getByRole('button', { name: 'Confirm & Start Analysis' }).isDisabled(), true);
    await page.getByText('Source binding', { exact: true }).click();
    assert.match(await page.getByRole('dialog').innerText(), new RegExp(sourceSha));
    for (const label of ['A', 'B']) {
        if (label === 'B') await open();
        await page.getByRole('button', { name: `Choose ${label} — confirm meaning` }).click();
        await page.getByRole('button', { name: 'Resume read-only mapping draft' }).click();
        await page.getByRole('heading', { name: 'Draft / Uncommitted — not validated' }).waitFor();
        assert.equal(await page.getByRole('button', { name: `Choose ${label} — confirm meaning` }).isDisabled(), true);
        assert.equal(await page.getByRole('button', { name: 'Confirm & Start Analysis' }).isDisabled(), true);
        await page.screenshot({ path: `${artifacts}/${label}-draft.png` });
        evidence.scenarios.push(`${label}: exact choice -> read-only unvalidated draft; old boundary approval disabled`);
        await page.getByRole('button', { name: 'Cancel', exact: true }).click();
    }
    await open();
    await page.getByRole('button', { name: 'Neither / Correct mapping' }).click();
    await page.getByText(/Neither interpretation was confirmed/).waitFor();
    assert.equal(await page.getByRole('button', { name: 'Resume read-only mapping draft' }).count(), 0);
    await page.screenshot({ path: `${artifacts}/neither-blocked.png` });
    evidence.scenarios.push('Neither: stays blocked with corrected-source next action');
    await page.getByRole('button', { name: 'Cancel', exact: true }).click();
    await open();
    assert.equal(await page.getByRole('button', { name: 'Resume read-only mapping draft' }).count(), 0);
    await expect(page.getByRole('button', { name: 'Choose A — confirm meaning' })).toBeEnabled();
    evidence.scenarios.push('Cancel/reopen: prior semantic authority discarded; new confirmation required');
    await page.getByRole('button', { name: 'Cancel', exact: true }).click();
    await page.getByRole('button', { name: 'New', exact: true }).click();
    await page.getByRole('dialog', { name: 'Start a new analysis?' }).getByRole('button', { name: 'Start new analysis', exact: true }).click();
    await page.getByText('Select a file', { exact: true }).waitFor();
    await page.locator('input[type=file]').first().setInputFiles({ name: 'simple.csv', mimeType: 'text/csv', buffer: Buffer.from('A,B,C,D\n1,2,3,4\n5,6,7,8') });
    const consent = page.getByRole('button', { name: 'Use local processing only' });
    await Promise.race([consent.waitFor(), page.getByText('Local import ready (1/1)', { exact: true }).waitFor()]);
    if (await consent.isVisible()) await consent.click();
    await page.getByText('Local import ready (1/1)', { exact: true }).waitFor({ timeout: 60000 });
    assert.equal(await page.getByRole('button', { name: 'Review structural interpretations', exact: true }).count(), 0);
    assert.equal(await page.getByRole('heading', { name: 'Draft / Uncommitted — not validated' }).count(), 0);
    await page.screenshot({ path: `${artifacts}/new-simple-file.png` });
    evidence.scenarios.push('New file: old draft absent; simple four-column local import does not require semantic review');
    assert.deepEqual(evidence.pageErrors, []);
} finally {
    await context?.close();
    await rm(profile, { recursive: true });
    await writeFile(`${artifacts}/evidence.json`, JSON.stringify(evidence, null, 2));
    console.log(JSON.stringify({ artifacts, ...evidence }, null, 2));
}
