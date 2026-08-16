import assert from 'node:assert/strict';
import test from 'node:test';

import type { NativeRuntimeBinding } from '../../src/runtime/native.ts';
import { createTurnSkills } from '../../src/runtime/skills.ts';

const runtimeSkill = (name: string, description = `${name} instructions`) => {
  const content = `---\nname: ${name}\ndescription: ${description}\n---\n\nFollow ${name}.\n`;
  return {
    name,
    description,
    content,
    bytes: new TextEncoder().encode(content).byteLength,
    sha256: 'a'.repeat(64),
  };
};

const nativeWithSkills = (names: readonly string[]): NativeRuntimeBinding =>
  ({
    skillsContextJson: () =>
      JSON.stringify({ skills: names.map((name) => runtimeSkill(name)) }),
  }) as unknown as NativeRuntimeBinding;

test('Turn Skills freeze inventory and inline an explicit selection', async () => {
  const turn = createTurnSkills(
    nativeWithSkills(['review', 'testing']),
    'workspace-1',
    [{ type: 'text', text: 'Please use $review.' }],
  );

  assert.match(turn.instruction, /\$review: review instructions/u);
  assert.match(turn.instruction, /Selected Skill: \$review/u);
  assert.match(turn.instruction, /without the leading \$ marker/u);
  assert.equal(turn.tools.length, 1);
  assert.deepEqual(
    await turn.tools[0].runAsync({
      args: {
        name: ' $Testing ',
        purpose: 'Use its focused checks to verify the current change.',
      },
      toolContext: {} as never,
    }),
    {
      ok: true,
      name: 'testing',
      description: 'testing instructions',
      purpose: 'Use its focused checks to verify the current change.',
      sha256: 'a'.repeat(64),
      content: runtimeSkill('testing').content,
    },
  );
});

test('Turn Skills reject over-selection and cap on-demand loads', async () => {
  const names = ['one', 'two', 'three', 'four', 'five'];
  assert.throws(
    () =>
      createTurnSkills(nativeWithSkills(names), 'workspace-1', [
        { type: 'text', text: names.map((name) => `$${name}`).join(' ') },
      ]),
    /at most four Skills/u,
  );

  const turn = createTurnSkills(nativeWithSkills(names), 'workspace-1', [
    { type: 'text', text: 'No explicit Skill.' },
  ]);
  for (const name of names.slice(0, 4)) {
    const result = await turn.tools[0].runAsync({
      args: { name },
      toolContext: {} as never,
    });
    assert.equal((result as { ok: boolean }).ok, true);
  }
  assert.deepEqual(
    await turn.tools[0].runAsync({
      args: { name: 'five' },
      toolContext: {} as never,
    }),
    { ok: false, error: 'tooManySkills' },
  );
});

test('Turn Skills return the frozen inventory when a requested name is unknown', async () => {
  const turn = createTurnSkills(
    nativeWithSkills(['frontend-design', 'testing']),
    'workspace-1',
    [{ type: 'text', text: 'Improve the interface.' }],
  );

  assert.deepEqual(
    await turn.tools[0].runAsync({
      args: { name: '$missing-skill' },
      toolContext: {} as never,
    }),
    {
      ok: false,
      error: 'skillNotFound',
      availableSkills: ['frontend-design', 'testing'],
    },
  );
});

test('steering resolves explicit Skills from the frozen Turn inventory and shared limits', () => {
  const turn = createTurnSkills(
    nativeWithSkills(['one', 'two', 'three', 'four', 'five']),
    'workspace-1',
    [{ type: 'text', text: 'Start with $one.' }],
  );
  assert.match(
    turn.steeringInstruction([{ type: 'text', text: 'Also apply $two.' }]),
    /Selected Skill: \$two/u,
  );
  turn.steeringInstruction([{ type: 'text', text: '$three' }]);
  turn.steeringInstruction([{ type: 'text', text: '$four' }]);
  assert.throws(
    () => turn.steeringInstruction([{ type: 'text', text: '$five' }]),
    /at most four Skills/u,
  );
  assert.equal(
    turn.steeringInstruction([{ type: 'text', text: '$missing' }]),
    '',
  );
});
