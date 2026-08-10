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
  assert.equal(turn.tools.length, 1);
  assert.deepEqual(
    await turn.tools[0].runAsync({
      args: { name: 'testing' },
      toolContext: {} as never,
    }),
    {
      ok: true,
      name: 'testing',
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
