import assert from 'node:assert/strict';
import test from 'node:test';

import type { LlmRequest } from '@google/adk';
import type { Content } from '@google/genai';

import type { NativeRuntimeBinding } from '../../src/runtime/persistence/native.ts';
import {
  instructionScopesForPatch,
  WorkspaceInstructionContext,
} from '../../src/runtime/instructions/workspace.ts';

const requestWith = (contents: Content[]): LlmRequest => ({
  model: 'fixture',
  contents,
  config: { systemInstruction: 'system fixture' },
  liveConnectConfig: {},
  toolsDict: {},
});

const document = (
  path: string,
  scope: string,
  content: string,
  sha256 = path.padEnd(64, '0').slice(0, 64),
) => ({ path, scope, content, bytes: Buffer.byteLength(content), sha256 });

test('project instructions are temporary user context immediately before the current request', () => {
  const root = document('AGENTS.md', '.', 'Use repository rules.');
  const native = {
    workspaceInstructionsJson: (_workspaceId: string, scopesJson: string) => {
      const scopes = JSON.parse(scopesJson) as string[];
      return JSON.stringify({
        contractVersion: 1,
        documents: [root],
        chains: scopes.map((scope) => ({ scope, paths: ['AGENTS.md'] })),
        errors: [],
      });
    },
  } as NativeRuntimeBinding;
  const context = new WorkspaceInstructionContext(native, 'workspace');
  context.preloadRoot();
  const current: Content = { role: 'user', parts: [{ text: 'Implement the change.' }] };
  const request = requestWith([
    { role: 'user', parts: [{ text: 'Older message.' }] },
    current,
  ]);

  context.injectIntoRequest(request, current);

  assert.equal(request.config?.systemInstruction, 'system fixture');
  assert.equal(request.contents.length, 3);
  assert.match(request.contents[1]?.parts?.[0]?.text ?? '', /Source: AGENTS\.md/u);
  assert.equal(request.contents[2], current);

  const compacted = requestWith([current]);
  context.injectIntoRequest(compacted, current);
  assert.equal(compacted.contents.length, 2, 'context is re-injected after compaction');
});

test('project context metadata does not remove user text that resembles the internal marker', () => {
  const root = document('AGENTS.md', '.', 'Use repository rules.');
  const native = {
    workspaceInstructionsJson: (_workspaceId: string, scopesJson: string) => {
      const scopes = JSON.parse(scopesJson) as string[];
      return JSON.stringify({
        contractVersion: 1,
        documents: [root],
        chains: scopes.map((scope) => ({ scope, paths: ['AGENTS.md'] })),
        errors: [],
      });
    },
  } as NativeRuntimeBinding;
  const context = new WorkspaceInstructionContext(native, 'workspace');
  context.preloadRoot();
  const user: Content = {
    role: 'user',
    parts: [{ text: '[SugarCode project instructions context]\nThis is user text.' }],
  };
  const request = requestWith([user]);

  context.injectIntoRequest(request, user);
  context.injectIntoRequest(request, user);

  assert.equal(request.contents.length, 2);
  assert.equal(request.contents[1], user);
});

test('nested instructions block the first write until a model boundary delivers them', () => {
  const root = document('AGENTS.md', '.', 'Root rules.');
  const nested = document('src/CLAUDE.md', 'src', 'Nested rules.');
  const native = {
    workspaceInstructionsJson: (_workspaceId: string, scopesJson: string) => {
      const scopes = JSON.parse(scopesJson) as string[];
      const hasNested = scopes.includes('src');
      return JSON.stringify({
        contractVersion: 1,
        documents: hasNested ? [root, nested] : [root],
        chains: scopes.map((scope) => ({
          scope,
          paths: scope === 'src' ? ['AGENTS.md', 'src/CLAUDE.md'] : ['AGENTS.md'],
        })),
        errors: [],
      });
    },
  } as NativeRuntimeBinding;
  const context = new WorkspaceInstructionContext(native, 'workspace');
  context.preloadRoot();
  context.injectIntoRequest(requestWith([{ role: 'user', parts: [{ text: 'Initial' }] }]));

  assert.deepEqual(context.warningsForRead(['src']), []);
  const first = context.checkWrite(['src']);
  assert.equal(first?.error, 'workspaceInstructionsRequired');
  assert.deepEqual(first && 'paths' in first ? first.paths : [], ['src/CLAUDE.md']);

  const next = requestWith([{ role: 'user', parts: [{ text: 'Continue' }] }]);
  context.injectIntoRequest(next);
  assert.match(next.contents[0]?.parts?.[0]?.text ?? '', /Nested rules/u);
  assert.equal(context.checkWrite(['src']), undefined);
});

test('instruction failures warn on reads and fail closed on writes', () => {
  const native = {
    workspaceInstructionsJson: (_workspaceId: string, scopesJson: string) => {
      const scopes = JSON.parse(scopesJson) as string[];
      return JSON.stringify({
        contractVersion: 1,
        documents: [],
        chains: [],
        errors: scopes.map((scope) => ({ scope, kind: 'invalidEncoding' })),
      });
    },
  } as NativeRuntimeBinding;
  const context = new WorkspaceInstructionContext(native, 'workspace');

  assert.deepEqual(context.warningsForRead(['src']), [{
    scope: 'src',
    kind: 'invalidEncoding',
  }]);
  assert.equal(context.checkWrite(['src'])?.error, 'workspaceInstructionsUnavailable');

  const request = requestWith([{ role: 'user', parts: [{ text: 'Inspect.' }] }]);
  context.injectIntoRequest(request);
  assert.match(
    request.contents[0]?.parts?.[0]?.text ?? '',
    /Instruction loading warnings[\s\S]*invalidEncoding/u,
  );
});

test('patch scope discovery includes both move source and destination', () => {
  assert.deepEqual(
    instructionScopesForPatch(
      '*** Begin Patch\n*** Update File: src/old.ts\n*** Move to: packages/new.ts\n-old\n+new\n*** End Patch',
    ),
    ['src', 'packages'],
  );
});

test('writing an instruction file invalidates the turn cache before the next request', () => {
  let version = 1;
  const native = {
    workspaceInstructionsJson: (_workspaceId: string, scopesJson: string) => {
      const scopes = JSON.parse(scopesJson) as string[];
      const root = document(
        'AGENTS.md',
        '.',
        `Rules version ${version}.`,
        String(version).repeat(64),
      );
      return JSON.stringify({
        contractVersion: 1,
        documents: [root],
        chains: scopes.map((scope) => ({ scope, paths: ['AGENTS.md'] })),
        errors: [],
      });
    },
  } as NativeRuntimeBinding;
  const context = new WorkspaceInstructionContext(native, 'workspace');
  context.preloadRoot();
  const first = requestWith([{ role: 'user', parts: [{ text: 'First' }] }]);
  context.injectIntoRequest(first);
  assert.match(first.contents[0]?.parts?.[0]?.text ?? '', /version 1/u);

  version = 2;
  context.invalidateAfterWrite(['AGENTS.md']);
  const second = requestWith([{ role: 'user', parts: [{ text: 'Second' }] }]);
  context.injectIntoRequest(second);
  assert.match(second.contents[0]?.parts?.[0]?.text ?? '', /version 2/u);
});
