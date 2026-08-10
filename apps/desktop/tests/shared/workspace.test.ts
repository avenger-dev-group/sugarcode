import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import test from 'node:test';

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (
      specifier.startsWith('.') &&
      !specifier.split('/').at(-1)?.includes('.') &&
      context.parentURL
    ) {
      return {
        shortCircuit: true,
        url: new URL(`${specifier}.ts`, context.parentURL).href,
      };
    }
    return nextResolve(specifier, context);
  },
});

const {
  isWorkspaceResolveRequest,
  isWorkspaceResolveResult,
  isWorkspacePathSearchRequest,
  isWorkspacePathSearchResult,
  isWorkspaceTaskRenameRequest,
} = await import('../../src/shared/workspace.ts');

test('workspace path suggestions keep search bounded to safe relative files', () => {
  assert.equal(
    isWorkspacePathSearchRequest({ generation: 2, query: 'composer' }),
    true,
  );
  assert.equal(
    isWorkspacePathSearchRequest({ generation: 2, query: 'bad\nquery' }),
    false,
  );
  assert.equal(
    isWorkspacePathSearchResult({
      accepted: true,
      generation: 2,
      query: 'composer',
      paths: ['apps/desktop/src/renderer/components/composer/composer-input.tsx'],
      truncated: false,
    }),
    true,
  );
  assert.equal(
    isWorkspacePathSearchResult({
      accepted: true,
      generation: 2,
      query: 'composer',
      paths: ['../outside.ts'],
      truncated: false,
    }),
    false,
  );
});

test('workspace Thread rename requests are bounded and explicit', () => {
  assert.equal(
    isWorkspaceTaskRenameRequest({
      threadId: '00000000-0000-7000-8000-000000000001',
      title: '无需选中即可重命名',
    }),
    true,
  );
  assert.equal(
    isWorkspaceTaskRenameRequest({
      threadId: '00000000-0000-7000-8000-000000000001',
      title: '   ',
    }),
    false,
  );
});

test('workspace reference resolution accepts bounded absolute citations', () => {
  assert.equal(
    isWorkspaceResolveRequest({
      generation: 4,
      reference: '/Users/simonf/My Project/src/sidebar.tsx',
    }),
    true,
  );
  assert.equal(
    isWorkspaceResolveResult({
      accepted: true,
      generation: 4,
      reference: '/Users/simonf/My Project/src/sidebar.tsx',
      status: 'resolved',
      path: 'src/sidebar.tsx',
    }),
    true,
  );
});

test('workspace reference resolution rejects URLs and invalid resolved paths', () => {
  assert.equal(
    isWorkspaceResolveRequest({
      generation: 4,
      reference: 'file:///Users/simonf/project/src/sidebar.tsx',
    }),
    false,
  );
  assert.equal(
    isWorkspaceResolveResult({
      accepted: true,
      generation: 4,
      reference: '/Users/simonf/project/src/sidebar.tsx',
      status: 'resolved',
      path: '../outside/sidebar.tsx',
    }),
    false,
  );
});
