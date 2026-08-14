import assert from 'node:assert/strict';
import test from 'node:test';

import {
  canStopTurn,
  canRemoveDraftProject,
  resolveComposerSurface,
  shouldShowStopControl,
  shouldStartChatOnSend,
  TURN_STOP_SAFETY_DELAY_MS,
} from '../../../src/renderer/components/thread/composer-state.ts';

test('approval replaces the composer and takes precedence over user questions', () => {
  assert.equal(resolveComposerSurface(true, false), 'approval');
  assert.equal(resolveComposerSurface(true, true), 'approval');
  assert.equal(resolveComposerSurface(false, true), 'userInput');
  assert.equal(resolveComposerSurface(false, false), 'composer');
});

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

test('the Stop control stays locked until the active Turn survives the safety delay', () => {
  assert.equal(TURN_STOP_SAFETY_DELAY_MS, 1_000);
  assert.equal(shouldShowStopControl('starting', false), true);
  assert.equal(canStopTurn('starting', 'turn-1', null), false);
  assert.equal(canStopTurn('inProgress', 'turn-1', null), false);
  assert.equal(canStopTurn('inProgress', 'turn-1', 'turn-2'), false);
  assert.equal(canStopTurn('inProgress', 'turn-1', 'turn-1'), true);
  assert.equal(canStopTurn('stopping', 'turn-1', 'turn-1'), false);
  assert.equal(shouldShowStopControl('ready', false), false);
});
