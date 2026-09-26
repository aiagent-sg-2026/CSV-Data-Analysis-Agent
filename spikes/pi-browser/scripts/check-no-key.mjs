import { existsSync, readFileSync } from 'node:fs';

const keyNames = new Set(['OPENAI_API_KEY', 'VITE_OPENAI_API_KEY']);
const localEnvFiles = ['.env', '.env.local', '.env.production', '.env.production.local'];

function hasConfiguredKey(contents) {
  return contents.split(/\r?\n/).some((line) => {
    const match = line.match(/^\s*(?:export\s+)?([A-Z_]+)\s*=\s*(.*?)\s*$/);
    return match && keyNames.has(match[1]) && match[2] !== '' && !match[2].startsWith('#');
  });
}

const keyInProcess = [...keyNames].some((name) => Boolean(process.env[name]));
const keyInFile = localEnvFiles.some((file) => existsSync(file) && hasConfiguredKey(readFileSync(file, 'utf8')));

if (keyInProcess || keyInFile) {
  console.error('Build refused: remove the local OpenAI key before creating a distributable browser bundle.');
  process.exitCode = 1;
}
