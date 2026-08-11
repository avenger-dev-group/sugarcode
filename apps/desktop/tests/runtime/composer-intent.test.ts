import assert from 'node:assert/strict';
import test from 'node:test';

import {
  composerIntentInstruction,
  composerModelText,
} from '../../src/runtime/composer-intent.ts';

test('composer selections become explicit command, Skill, and file instructions', () => {
  const instruction = composerIntentInstruction([
    {
      type: 'text',
      text: '$estimate\n@.gitignore\n/fix\n\n目前选择了几个能力？',
    },
  ]);

  assert.match(instruction, /\$estimate/u);
  assert.match(instruction, /mandatory|must be followed/u);
  assert.match(instruction, /\/fix: Diagnose the root cause/u);
  assert.match(instruction, /workspace_read/u);
  assert.match(instruction, /- \.gitignore/u);
  assert.match(instruction, /plain-text request remains authoritative/u);
});

test('model input separates Composer metadata from the plain user request', () => {
  assert.equal(
    composerModelText('$estimate\n@.gitignore\n/fix\n\n先告诉我选择了几个能力，不要修改'),
    '# Composer selections\n\n' +
      '- skill: $estimate\n\n' +
      '- file: @.gitignore\n\n' +
      '- command: /fix\n\n' +
      '# User request\n\n' +
      '先告诉我选择了几个能力，不要修改',
  );
});

test('ordinary messages add no Composer control instruction', () => {
  assert.equal(
    composerIntentInstruction([{ type: 'text', text: '解释这段代码' }]),
    '',
  );
});
