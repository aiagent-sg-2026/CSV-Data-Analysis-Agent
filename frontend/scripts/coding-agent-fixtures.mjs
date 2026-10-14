import { assertFixtureRuntime, writeFixtureSuite } from './coding-agent-evaluation/fixtureKit.mjs';

const args = process.argv.slice(2);
try {
  assertFixtureRuntime();
  if (args.length !== 2 || args[0] !== '--output') throw new Error('usage_invalid');
  const manifestSha256 = await writeFixtureSuite(args[1]);
  process.stdout.write(`${JSON.stringify({ status: 'generated', manifestSha256, providerCalls: 0, evaluatedRuns: 0 })}\n`);
} catch {
  process.stdout.write(`${JSON.stringify({ status: 'invalid', reasons: ['fixture_generation_failed'], providerCalls: 0, evaluatedRuns: 0 })}\n`);
  process.exitCode = 2;
}
