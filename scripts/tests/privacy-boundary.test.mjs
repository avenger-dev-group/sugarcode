import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

const repository = path.resolve(import.meta.dirname, '../..');
const productionRoots = [
  path.join(repository, 'apps/desktop/src'),
  path.join(repository, 'crates/desktop-native/src'),
];

const sourceFiles = async (root) => {
  const output = [];
  const pending = [root];
  while (pending.length > 0) {
    const directory = pending.pop();
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const target = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== 'tests') pending.push(target);
      } else if (/\.(?:rs|ts|tsx|mjs)$/u.test(entry.name)) {
        output.push(target);
      }
    }
  }
  return output.sort();
};

test('production manifests do not include telemetry or analytics SDKs', async () => {
  const manifests = await Promise.all([
    readFile(path.join(repository, 'package.json'), 'utf8'),
    readFile(path.join(repository, 'apps/desktop/package.json'), 'utf8'),
    readFile(path.join(repository, 'crates/desktop-native/Cargo.toml'), 'utf8'),
  ]);
  const combined = manifests.join('\n').toLocaleLowerCase();
  for (const forbidden of [
    '@sentry/', 'posthog', 'amplitude', 'mixpanel', 'segment',
    'telemetrydeck', 'opentelemetry', 'datadog', 'newrelic',
  ]) {
    assert.equal(combined.includes(forbidden), false, `forbidden telemetry dependency: ${forbidden}`);
  }
});

test('knowledge, query, and Skill content are not written to diagnostic output', async () => {
  const files = (await Promise.all(productionRoots.map(sourceFiles))).flat();
  const violations = [];
  const diagnosticCall = /(?:console\.(?:log|info|warn|error)|println!|eprintln!|tracing::\w+!|log::\w+!)[^\n]*(?:knowledge|query|skill|content)/giu;
  for (const file of files) {
    const source = await readFile(file, 'utf8');
    for (const match of source.matchAll(diagnosticCall)) {
      violations.push(`${path.relative(repository, file)}: ${match[0]}`);
    }
  }
  assert.deepEqual(violations, []);
});
