import { readFile, lstat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { atomicWrite, json, assertFixtureRuntime } from './coding-agent-evaluation/fixtureKit.mjs';
import { freezeQualification, inspectQualification, LIVE_LAUNCH_BLOCKERS } from './coding-agent-evaluation/qualificationPreflight.mjs';

const repository = fileURLToPath(new URL('../../', import.meta.url));
const args = process.argv.slice(2);
let acceptedReport;
try {
  assertFixtureRuntime();
  if (args.length !== 6 || args[0] !== '--suite' || !['--freeze', '--manifest'].includes(args[2]) || args[4] !== '--report')
    throw new Error('usage_invalid');
  const suite = path.resolve(args[1]), target = path.resolve(args[3]), report = path.resolve(args[5]);
  if (target === report || target.startsWith(`${suite}${path.sep}`) || report.startsWith(`${suite}${path.sep}`)
    || target === suite || report === suite) throw new Error('artifact_destination_invalid');
  acceptedReport = report;
  let manifest;
  if (args[2] === '--freeze') {
    try { await lstat(target); throw new Error('qualification_target_exists'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    manifest = await freezeQualification(repository, suite);
    await atomicWrite(target, json(manifest));
  } else {
    const stat = await lstat(target);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 2 * 1024 * 1024) throw new Error('qualification_target_invalid');
    manifest = JSON.parse(await readFile(target, 'utf8'));
  }
  const result = await inspectQualification(repository, suite, manifest);
  await atomicWrite(report, json(result));
  process.stdout.write(json(result));
  process.exitCode = result.status === 'preflight_complete' ? 0 : 2;
} catch {
  const result = { schemaVersion: 1, status: 'invalid', mode: 'zero_call',
    reasons: ['qualification_input_or_report_invalid'], providerCalls: 0, paidSpendUsd: 0, evaluatedRuns: 0,
    capabilityAcceptance: 'pending', liveRunAuthorized: false, launchReady: false,
    launchBlockers: ['preflight_invalid', ...LIVE_LAUNCH_BLOCKERS] };
  // A failed input must replace a writable previous report, rather than leaving a stale successful verdict.
  if (acceptedReport) {
    try { await atomicWrite(acceptedReport, json(result)); }
    catch { result.reportPublicationFailed = true; }
  }
  process.stdout.write(json(result));
  process.exitCode = 2;
}
