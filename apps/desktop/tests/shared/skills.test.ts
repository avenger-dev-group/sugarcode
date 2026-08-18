import assert from 'node:assert/strict';
import test from 'node:test';

import {
  isSkillContent,
  isSkillsActionResult,
  isSkillsInspection,
} from '../../src/shared/skills.ts';

const skill = {
  id: `skl_${'a'.repeat(64)}`,
  name: 'code-review',
  description: 'Review a focused code change.',
  source: 'project' as const,
  path: '.agents/skills/code-review/SKILL.md',
  sha256: 'b'.repeat(64),
  bytes: 7,
  enabled: true,
};

test('Skills bridge contracts bound inventory and verified content', () => {
  assert.equal(
    isSkillsInspection({ skills: [skill], workspaceAvailable: true }),
    true,
  );
  assert.equal(
    isSkillsInspection({
      skills: [{ ...skill, id: `skl_${'z'.repeat(64)}` }],
      workspaceAvailable: true,
    }),
    false,
  );
  assert.equal(isSkillContent({ skill, content: '你好\n' }), true);
  assert.equal(isSkillContent({ skill, content: 'short' }), false);
});

test('Skills actions accept only the bounded result union', () => {
  assert.equal(
    isSkillsActionResult({
      accepted: true,
      inspection: { skills: [skill], workspaceAvailable: true },
    }),
    true,
  );
  assert.equal(
    isSkillsActionResult({
      accepted: false,
      reason: 'cancelled',
    }),
    true,
  );
  assert.equal(
    isSkillsActionResult({ accepted: false, reason: 'permissionDenied' }),
    false,
  );
});
