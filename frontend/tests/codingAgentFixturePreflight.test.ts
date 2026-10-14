// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, writeFile, rm, stat, symlink, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { buildFixtureSuite, writeFixtureSuite, atomicWrite } from '../scripts/coding-agent-evaluation/fixtureKit.mjs';
import { inspectFixtureSuite } from '../scripts/coding-agent-evaluation/preflight.mjs';

let temporary: string;
let suitePath: string;
beforeAll(async () => {
    temporary = await mkdtemp(path.join(tmpdir(), 'coding-agent-fixtures-'));
    suitePath = path.join(temporary, 'suite');
    await writeFixtureSuite(suitePath);
});
afterAll(async () => { await rm(temporary, { recursive: true, force: true }); });

describe('coding-agent synthetic evaluation foundation', () => {
    it('freezes 60 independent cases and a three-replicate denominator without running a provider', async () => {
        const fetch = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Network forbidden in preflight'));
        try {
            const result = await inspectFixtureSuite(suitePath);
            expect(result).toMatchObject({ status: 'fixture_ready', providerCalls: 0, evaluatedRuns: 0,
                liveRunAuthorized: false, capabilityAcceptance: 'pending',
                counts: { cases: 60, solvable: 40, ambiguous: 10, adversarial: 10, novelRepairs: 20, newMethods: 1, plannedRuns: 180 } });
            expect(result.reasons).toEqual([]);
            expect(fetch).not.toHaveBeenCalled();
            expect(buildFixtureSuite().manifestSha256).toBe(result.manifestSha256);
        } finally { fetch.mockRestore(); }
    });

    it('gives the agent raw inputs and goals while keeping canonical facts, oracle and failure schedule separate', async () => {
        const task = JSON.parse(await readFile(path.join(suitePath, 'agent/S8-2/task.json'), 'utf8'));
        expect(Object.keys(task).sort()).toEqual(['caseId', 'goal', 'inputFiles', 'outputContract', 'schemaVersion']);
        expect(task.inputFiles).toEqual(['input.csv']);
        expect(task.goal).toContain('lower weighted median');
        expect(task.goal).not.toMatch(/amount_minor.*\d{4}|expectedFacts|faultSchedule/);
        const oracle = JSON.parse(await readFile(path.join(suitePath, 'evaluator/S8-2/oracle.json'), 'utf8'));
        const scoped = oracle.expectedFacts.filter((fact: { date: string }) => fact.date.startsWith('2026-10'));
        const expanded = scoped.flatMap((fact: { amount_minor: number; quantity: number }) => Array(fact.quantity).fill(fact.amount_minor)).sort((a: number, b: number) => a - b);
        expect(oracle.answer.amount_minor).toBe(expanded[Math.ceil(expanded.length / 2) - 1]);
    });

    it('retains facts and exclusion identities across the old 5000-row batching boundary', async () => {
        const oracle = JSON.parse(await readFile(path.join(suitePath, 'evaluator/S4-5/oracle.json'), 'utf8'));
        expect(oracle.expectedFacts).toHaveLength(5006);
        expect(new Set(oracle.expectedFacts.map((fact: { fact_id: string }) => fact.fact_id)).size).toBe(5006);
        expect(oracle.sourceMap.find((record: { role: string }) => record.role === 'duplicate'))
            .toMatchObject({ record: 'input.csv:5004', fact_id: 'F000002' });
        const detailAmount = oracle.expectedFacts.reduce((sum: number, fact: { amount_minor: number }) => sum + fact.amount_minor, 0);
        expect(oracle.expectedGroups.reduce((sum: number, group: { amount_minor: number }) => sum + group.amount_minor, 0)).toBe(detailAmount);
        const summaries = JSON.parse(await readFile(path.join(suitePath, 'evaluator/S2-1/oracle.json'), 'utf8'));
        expect(summaries.expectedFacts.some((fact: { team: string }) => fact.team === 'Total Solutions')).toBe(true);
        expect(summaries.sourceMap.filter((record: { role: string }) => record.role === 'summary')).toHaveLength(4);
    });

    it('does not disclose the evaluator disposition or target clarification in ambiguous agent goals', async () => {
        const task = JSON.parse(await readFile(path.join(suitePath, 'agent/A-2/task.json'), 'utf8'));
        expect(task.goal).toBe('Investigate the export. Report the April 2026 amount total.');
        expect(task).not.toHaveProperty('disposition');
        const oracle = JSON.parse(await readFile(path.join(suitePath, 'evaluator/A-2/oracle.json'), 'utf8'));
        expect(oracle.expectedFacts).toEqual([]);
        expect(oracle.expectedBehavior).toBe('clarify_without_accepted_mutation');
    });

    it('refuses a changed artifact, missing artifact and solution leakage without exposing paths', async () => {
        const file = path.join(suitePath, 'agent/S1-1/input.csv');
        const bytes = await readFile(file);
        try {
            await writeFile(file, 'private-looking corrupted content');
            expect(await inspectFixtureSuite(suitePath)).toMatchObject({ status: 'invalid', reasons: ['artifact_hash_mismatch'] });
            await rm(file);
            const missing = await inspectFixtureSuite(suitePath);
            expect(missing.status).toBe('invalid');
            expect(JSON.stringify(missing)).not.toContain(temporary);
        } finally { await writeFile(file, bytes); }
        const extra = path.join(suitePath, 'agent/S1-1/solution.py');
        try {
            await writeFile(extra, 'do not disclose an oracle solution');
            expect(await inspectFixtureSuite(suitePath)).toMatchObject({ status: 'invalid', reasons: ['undeclared_artifact'] });
        } finally { await rm(extra); }
    });

    it('refuses manifest changes and symlink substitution against the frozen authority', async () => {
        const manifest = path.join(suitePath, 'manifest.json');
        const bytes = await readFile(manifest);
        try {
            const changed = JSON.parse(bytes.toString()); changed.cases = [];
            await writeFile(manifest, JSON.stringify(changed));
            expect(await inspectFixtureSuite(suitePath)).toMatchObject({ status: 'invalid', reasons: ['manifest_hash_mismatch'] });
        } finally { await writeFile(manifest, bytes); }
        const file = path.join(suitePath, 'agent/S1-1/input.csv');
        const original = await readFile(file);
        try {
            await rm(file); await symlink(path.join(suitePath, 'evaluator/S1-1/canonical.csv'), file);
            expect(await inspectFixtureSuite(suitePath)).toMatchObject({ status: 'invalid', reasons: ['artifact_symlink_denied'] });
        } finally { await rm(file); await writeFile(file, original); }
    });

    it('matches real CLI exit codes to the same status artifact and rejects a provider flag', async () => {
        const command = path.resolve('scripts/coding-agent-preflight.mjs');
        const report = path.join(temporary, 'preflight.json');
        const valid = spawnSync(process.execPath, [command, '--suite', suitePath, '--report', report], { encoding: 'utf8' });
        expect(valid.status).toBe(0);
        expect(JSON.parse(valid.stdout).status).toBe('fixture_ready');
        expect(JSON.parse(await readFile(report, 'utf8'))).toEqual(JSON.parse(valid.stdout));
        expect((await stat(report)).mode & 0o777).toBe(0o600);
        const invalid = spawnSync(process.execPath, [command, '--suite', path.join(temporary, 'missing'), '--report', report], { encoding: 'utf8' });
        expect(invalid.status).toBe(2);
        expect(JSON.parse(await readFile(report, 'utf8')).status).toBe('invalid');
        expect(invalid.stdout).not.toContain(temporary);
        const denied = spawnSync(process.execPath, [command, '--suite', suitePath, '--provider', 'live'], { encoding: 'utf8' });
        expect(denied.status).toBe(2);
        expect(JSON.parse(denied.stdout).providerCalls).toBe(0);
    });

    it('replaces reports atomically, rejects symlinks and preserves the target on pre-rename failure', async () => {
        const target = path.join(temporary, 'atomic.json');
        await atomicWrite(target, 'old'); await atomicWrite(target, 'new');
        expect(await readFile(target, 'utf8')).toBe('new');
        expect((await stat(target)).mode & 0o777).toBe(0o600);
        await expect(atomicWrite(target, { invalid: 'not bytes' })).rejects.toThrow();
        expect(await readFile(target, 'utf8')).toBe('new');
        const alias = path.join(temporary, 'alias'); await symlink(target, alias);
        await expect(atomicWrite(alias, 'changed')).rejects.toThrow('artifact_target_not_regular');
        expect(await readFile(target, 'utf8')).toBe('new');
        expect((await readdir(temporary)).filter(name => name.startsWith('.artifact-'))).toEqual([]);
        await expect(writeFixtureSuite(suitePath)).rejects.toThrow();
        expect((await inspectFixtureSuite(suitePath)).status).toBe('fixture_ready');
    });
});
