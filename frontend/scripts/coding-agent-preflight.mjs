import path from 'node:path';
import { inspectFixtureSuite } from './coding-agent-evaluation/preflight.mjs';
import { assertFixtureRuntime, atomicWrite, json } from './coding-agent-evaluation/fixtureKit.mjs';

const args = process.argv.slice(2);
try {
  assertFixtureRuntime();
  if (![2, 4].includes(args.length) || args[0] !== '--suite' || args.length === 4 && args[2] !== '--report') throw new Error('usage_invalid');
  const result = await inspectFixtureSuite(path.resolve(args[1]));
  if (args.length === 4) await atomicWrite(path.resolve(args[3]), json(result));
  process.stdout.write(json(result));
  process.exitCode = result.status === 'fixture_ready' ? 0 : 2;
} catch {
  process.stdout.write(json({ schemaVersion: 1, status: 'invalid', reasons: ['preflight_input_or_report_invalid'],
    providerCalls: 0, evaluatedRuns: 0, capabilityAcceptance: 'pending', liveRunAuthorized: false }));
  process.exitCode = 2;
}
