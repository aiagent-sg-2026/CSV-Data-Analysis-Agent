import { readFile, lstat, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { FAMILIES, FACT_COLUMNS, sha256 } from './fixtureKit.mjs';

export const DEFAULT_LOCK_PATH = fileURLToPath(new URL('../../tests/fixtures/coding-agent-suite.lock.json', import.meta.url));
const hashPattern = /^[a-f0-9]{64}$/;
const exactKeys = (value, keys) => value && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).sort().join('|') === [...keys].sort().join('|');
const validPath = value => typeof value === 'string' && value.length <= 160
  && !value.includes('\\') && !path.posix.isAbsolute(value) && path.posix.normalize(value) === value
  && !value.split('/').some(part => !part || part === '..' || part === '.');

export const readFixtureArtifact = async (root, relative) => {
  if (!validPath(relative)) throw new Error('artifact_path_invalid');
  let target = root;
  for (const part of relative.split('/')) {
    target = path.join(target, part);
    if ((await lstat(target)).isSymbolicLink()) throw new Error('artifact_symlink_denied');
  }
  const stat = await lstat(target);
  if (!stat.isFile() || stat.size > 16 * 1024 * 1024) throw new Error('artifact_size_or_type_invalid');
  return readFile(target);
};
const listFiles = async (root, prefix = '') => {
  if (prefix.split('/').length > 2) throw new Error('artifact_directory_depth_invalid');
  const result = [];
  for (const entry of await readdir(path.join(root, prefix), { withFileTypes: true })) {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isSymbolicLink()) throw new Error('artifact_symlink_denied');
    if (entry.isDirectory()) result.push(...await listFiles(root, relative));
    else if (entry.isFile()) result.push(relative);
    else throw new Error('artifact_size_or_type_invalid');
    if (result.length > 512) throw new Error('artifact_count_limit');
  }
  return result.sort();
};

/** Offline integrity/coverage admission only. This module has no provider, app runtime or transport imports. */
export const inspectFixtureSuite = async (root, lockPath = DEFAULT_LOCK_PATH) => {
  const reasons = [];
  let manifestHash = null;
  let counts = { solvable: 0, ambiguous: 0, adversarial: 0, novelRepairs: 0, newMethods: 0, cases: 0, plannedRuns: 0 };
  try {
    const rootStat = await lstat(root);
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw new Error('suite_root_invalid');
    const lock = JSON.parse(await readFile(lockPath, 'utf8'));
    if (!exactKeys(lock, ['schemaVersion', 'suiteId', 'manifestSha256', 'caseCount', 'replicateCount'])
      || lock.schemaVersion !== 1 || lock.suiteId !== 'coding-agent-synthetic-v1'
      || !hashPattern.test(lock.manifestSha256) || lock.caseCount !== 60 || lock.replicateCount !== 3) throw new Error('suite_lock_invalid');
    const raw = await readFixtureArtifact(root, 'manifest.json');
    manifestHash = sha256(raw);
    if (manifestHash !== lock.manifestSha256) throw new Error('manifest_hash_mismatch');
    const manifest = JSON.parse(raw.toString('utf8'));
    if (!exactKeys(manifest, ['schemaVersion', 'suiteId', 'syntheticOnly', 'families', 'replicateSeeds', 'cases'])
      || manifest.schemaVersion !== 1 || manifest.suiteId !== lock.suiteId || manifest.syntheticOnly !== true
      || JSON.stringify(manifest.families) !== JSON.stringify(FAMILIES) || !Array.isArray(manifest.cases)
      || manifest.cases.length !== 60 || !Array.isArray(manifest.replicateSeeds) || manifest.replicateSeeds.length !== 3
      || new Set(manifest.replicateSeeds).size !== 3 || manifest.replicateSeeds.some(seed => !Number.isSafeInteger(seed))) throw new Error('manifest_contract_invalid');
    const ids = new Set();
    const declared = new Set(['manifest.json']);
    const perFamily = new Map(FAMILIES.map(family => [family, 0]));
    for (const item of manifest.cases) {
      if (!exactKeys(item, ['id', 'family', 'disposition', 'novelRepair', 'method', 'agentFiles', 'evaluatorFiles'])
        || !/^(S[1-8]-[1-5]|[AX]-(?:[1-9]|10))$/.test(item.id) || ids.has(item.id)
        || !['solvable', 'ambiguous', 'adversarial'].includes(item.disposition) || typeof item.novelRepair !== 'boolean'
        || !(item.method === null || item.method === 'lower_weighted_median')
        || !Array.isArray(item.agentFiles) || !item.agentFiles.length || !Array.isArray(item.evaluatorFiles) || !item.evaluatorFiles.length) throw new Error('case_contract_invalid');
      ids.add(item.id);
      if (item.disposition === 'solvable') {
        if (!perFamily.has(item.family)) throw new Error('family_coverage_invalid');
        perFamily.set(item.family, perFamily.get(item.family) + 1);
      } else if (item.family !== item.disposition) throw new Error('case_contract_invalid');
      counts[item.disposition] += 1;
      if (item.novelRepair) counts.novelRepairs += 1;
      if (item.method) counts.newMethods += 1;
      const loaded = new Map();
      for (const [audience, artifacts] of [['agent', item.agentFiles], ['evaluator', item.evaluatorFiles]]) {
        for (const artifact of artifacts) {
          if (!exactKeys(artifact, ['path', 'sha256']) || !validPath(artifact.path)
            || !artifact.path.startsWith(`${audience}/${item.id}/`) || !hashPattern.test(artifact.sha256)
            || declared.has(artifact.path)) throw new Error('artifact_contract_invalid');
          declared.add(artifact.path);
          const bytes = await readFixtureArtifact(root, artifact.path);
          if (sha256(bytes) !== artifact.sha256) throw new Error('artifact_hash_mismatch');
          loaded.set(artifact.path, bytes);
        }
      }
      const task = JSON.parse(loaded.get(`agent/${item.id}/task.json`).toString('utf8'));
      if (!exactKeys(task, ['schemaVersion', 'caseId', 'goal', 'inputFiles', 'outputContract']) || task.schemaVersion !== 1
        || task.caseId !== item.id || typeof task.goal !== 'string' || !task.goal.trim()
        || !Array.isArray(task.inputFiles) || !task.inputFiles.length || new Set(task.inputFiles).size !== task.inputFiles.length
        || !exactKeys(task.outputContract, ['factColumns', 'preserveOriginal', 'unitPolicy', 'evidence'])
        || JSON.stringify(task.outputContract.factColumns) !== JSON.stringify(FACT_COLUMNS) || task.outputContract.preserveOriginal !== true
        || task.inputFiles.some(name => !validPath(name) || name.includes('/') || !loaded.has(`agent/${item.id}/${name}`))
        || item.agentFiles.length !== task.inputFiles.length + 1) throw new Error('agent_input_contract_invalid');
      const oracle = JSON.parse(loaded.get(`evaluator/${item.id}/oracle.json`).toString('utf8'));
      if (!exactKeys(oracle, ['schemaVersion', 'caseId', 'disposition', 'expectedFacts', 'sourceMap', 'expectedGroups', 'answer', 'faultSchedule', 'expectedBehavior'])
        || oracle.schemaVersion !== 1 || oracle.caseId !== item.id || oracle.disposition !== item.disposition
        || !Array.isArray(oracle.expectedFacts) || !Array.isArray(oracle.sourceMap) || !Array.isArray(oracle.expectedGroups)
        || !Array.isArray(oracle.faultSchedule)) throw new Error('oracle_contract_invalid');
      if (item.disposition === 'ambiguous' && oracle.expectedFacts.length) throw new Error('ambiguous_oracle_invalid');
      if (item.disposition !== 'ambiguous' && !oracle.expectedFacts.length) throw new Error('oracle_empty');
      const factIds = new Set();
      for (const fact of oracle.expectedFacts) {
        if (!exactKeys(fact, FACT_COLUMNS) || typeof fact.fact_id !== 'string' || factIds.has(fact.fact_id)
          || typeof fact.team !== 'string' || !/^2026-\d{2}-\d{2}$/.test(fact.date)
          || !Number.isSafeInteger(fact.amount_minor) || !Number.isSafeInteger(fact.quantity) || fact.quantity < 0
          || !['SGD', 'USD'].includes(fact.unit)) throw new Error('oracle_fact_invalid');
        factIds.add(fact.fact_id);
      }
    }
    counts.cases = ids.size; counts.plannedRuns = counts.cases * manifest.replicateSeeds.length;
    if (counts.solvable !== 40 || counts.ambiguous !== 10 || counts.adversarial !== 10
      || counts.novelRepairs < 16 || counts.newMethods < 1 || [...perFamily.values()].some(count => count !== 5)) throw new Error('family_coverage_invalid');
    if (JSON.stringify(await listFiles(root)) !== JSON.stringify([...declared].sort())) throw new Error('undeclared_artifact');
  } catch (error) {
    const code = error instanceof Error ? error.message : '';
    reasons.push(/^[a-z_]+$/.test(code) ? code : 'suite_input_invalid');
  }
  return { schemaVersion: 1, status: reasons.length ? 'invalid' : 'fixture_ready',
    manifestSha256: manifestHash, counts, reasons, providerCalls: 0, evaluatedRuns: 0,
    capabilityAcceptance: 'pending', liveRunAuthorized: false };
};
