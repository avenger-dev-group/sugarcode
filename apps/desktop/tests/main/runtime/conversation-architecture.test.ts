import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const conversationRoot = fileURLToPath(
  new URL('../../../src/main/runtime/conversation/', import.meta.url),
);

const sourceFiles = (directory: string): string[] =>
  readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const candidate = path.join(directory, entry.name);
    return entry.isDirectory()
      ? sourceFiles(candidate)
      : entry.name.endsWith('.ts') ? [candidate] : [];
  });

test('conversation modules stay below the 1000-line maintenance budget', () => {
  const oversized = sourceFiles(conversationRoot).flatMap((file) => {
    const lines = readFileSync(file, 'utf8').trimEnd().split('\n').length;
    return lines > 1_000 ? [`${path.relative(conversationRoot, file)}: ${lines}`] : [];
  });
  assert.deepEqual(oversized, [], 'Extract a focused service instead of growing a module.');
});

test('conversation services never depend on the controller composition root', () => {
  for (const file of sourceFiles(conversationRoot)) {
    if (path.basename(file) === 'controller.ts') continue;
    const source = readFileSync(file, 'utf8');
    assert.doesNotMatch(source, /\bRuntimeConversationController\b/u, file);
    for (const match of source.matchAll(/(?:from\s*|import\s*\()\s*['"]([^'"]+)['"]/gu)) {
      const target = path.resolve(path.dirname(file), match[1]);
      assert.notEqual(target.replace(/\.ts$/u, ''), path.join(conversationRoot, 'controller'), file);
    }
  }
});
