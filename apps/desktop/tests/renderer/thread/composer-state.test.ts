import assert from 'node:assert/strict';
import test from 'node:test';

import {
  canRemoveDraftProject,
  shouldStartChatOnSend,
} from '../../../src/renderer/components/thread/composer-state.ts';

test('an unselected workspace starts an independent Chat on first send', () => {
  assert.equal(
    shouldStartChatOnSend({
      revision: 1,
      generation: 0,
      status: 'unselected',
    }),
    true,
  );
  assert.equal(
    shouldStartChatOnSend({
      revision: 2,
      generation: 0,
      status: 'failed',
    }),
    true,
  );
});

test('an active or selecting workspace keeps its existing destination', () => {
  assert.equal(
    shouldStartChatOnSend({
      revision: 1,
      generation: 1,
      status: 'ready',
      kind: 'project',
    }),
    false,
  );
  assert.equal(
    shouldStartChatOnSend({
      revision: 2,
      generation: 2,
      status: 'ready',
      kind: 'chat',
    }),
    false,
  );
  assert.equal(
    shouldStartChatOnSend({
      revision: 3,
      generation: 3,
      status: 'selecting',
      kind: 'chat',
    }),
    false,
  );
});

test('only a new project draft can remove its project before first send', () => {
  const project = {
    revision: 1,
    generation: 1,
    status: 'ready' as const,
    kind: 'project' as const,
    projectName: 'sugarcode',
  };

  assert.equal(canRemoveDraftProject(project, null), true);
  assert.equal(canRemoveDraftProject(project, 'thread-1'), false);
  assert.equal(
    canRemoveDraftProject({ ...project, kind: 'chat' }, null),
    false,
  );
  assert.equal(
    canRemoveDraftProject({ ...project, status: 'selecting' }, null),
    false,
  );
});
