import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

const repository = path.resolve(import.meta.dirname, '..');
const root = await mkdtemp(path.join(tmpdir(), 'sugarcode-desktop-e2e-'));
const reportPath = path.join(root, 'report.json');
const skillRoot = path.join(root, 'data', 'skills', 'e2e-smoke-skill');
await mkdir(skillRoot, { recursive: true });
await writeFile(path.join(skillRoot, 'SKILL.md'), `---
name: e2e-smoke-skill
description: Local E2E navigation fixture
---

# E2E Smoke Skill

This local fixture verifies exact Skill navigation without network access.
`);

const output = [];
const packagedExecutable = process.env.SUGARCODE_E2E_EXECUTABLE?.trim();
const packageManagerEntrypoint = process.env.npm_execpath?.trim();
const packageManagerArgs = ['--filter', '@sugarcode/desktop', 'exec', 'electron-forge', 'start'];
const child = spawn(
  packagedExecutable || (packageManagerEntrypoint ? process.execPath : 'pnpm'),
  packagedExecutable
    ? []
    : packageManagerEntrypoint
      ? [packageManagerEntrypoint, ...packageManagerArgs]
      : packageManagerArgs,
  {
    cwd: repository,
    env: {
      ...process.env,
      SUGARCODE_E2E_PROBE: '1',
      SUGARCODE_E2E_ROOT: root,
      SUGARCODE_E2E_REPORT: reportPath,
      ELECTRON_DISABLE_SECURITY_WARNINGS: 'true',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  },
);
for (const stream of [child.stdout, child.stderr]) {
  stream?.on('data', (chunk) => {
    output.push(String(chunk));
    if (output.length > 400) output.shift();
  });
}

try {
  const deadline = Date.now() + 120_000;
  let report;
  while (Date.now() < deadline) {
    try {
      report = JSON.parse(await readFile(reportPath, 'utf8'));
      break;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
  assert.ok(report, `Desktop E2E timed out.\n${output.join('').slice(-12_000)}`);
  assert.equal(report.ok, true, `Desktop E2E failed: ${report.error ?? 'unknown error'}\n${output.join('').slice(-12_000)}`);
  assert.ok(report.startupMs > 0 && report.startupMs < 60_000);
  assert.ok(report.mainPrivateKb > 0);
  assert.ok(report.rendererWorkingSetKb > 0);
  assert.ok(Array.isArray(report.checks) && report.checks.length >= 8);
  process.stdout.write(`SUGARCODE_E2E startup_ms=${report.startupMs} main_private_mb=${(report.mainPrivateKb / 1024).toFixed(1)} renderer_working_set_mb=${(report.rendererWorkingSetKb / 1024).toFixed(1)} checks=${report.checks.length}\n`);
} finally {
  const exited = new Promise((resolve) => child.once('exit', resolve));
  child.kill('SIGTERM');
  await Promise.race([
    exited,
    new Promise((resolve) => setTimeout(resolve, 10_000)),
  ]);
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      await rm(root, { recursive: true, force: true });
      break;
    } catch (error) {
      if (attempt === 4) throw error;
      await new Promise((resolve) => setTimeout(resolve, 250 * (attempt + 1)));
    }
  }
}
