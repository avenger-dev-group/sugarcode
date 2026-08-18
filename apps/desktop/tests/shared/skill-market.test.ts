import assert from 'node:assert/strict';
import test from 'node:test';

import {
  appVersionSatisfies,
  CURATED_SKILLS,
  curatedSkillMatches,
} from '../../src/shared/skill-market.ts';

test('curated Skill search matches normalized keywords and ordered fuzzy characters', () => {
  const tdd = CURATED_SKILLS.find((entry) => entry.name === 'test-driven-development');
  assert.ok(tdd);
  assert.equal(curatedSkillMatches(tdd, '测试驱动'), true);
  assert.equal(curatedSkillMatches(tdd, 'test driven'), true);
  assert.equal(curatedSkillMatches(tdd, 'tdd'), true);
  assert.equal(curatedSkillMatches(tdd, 'unrelated database migration'), false);
});

test('curated Skill compatibility compares bounded numeric application versions', () => {
  assert.equal(appVersionSatisfies('3.3.2', '3.3.2'), true);
  assert.equal(appVersionSatisfies('3.4.0', '3.3.2'), true);
  assert.equal(appVersionSatisfies('3.3.1', '3.3.2'), false);
  assert.equal(appVersionSatisfies('v4.0.0', '3.3.2'), true);
  assert.equal(appVersionSatisfies('invalid', '3.3.2'), false);
});

test('offline curated entries include a real content preview and bounded file manifest', () => {
  for (const entry of CURATED_SKILLS) {
    assert.match(entry.preview, /^# /u);
    assert.ok(entry.preview.length >= 200);
    assert.ok(entry.files.includes('SKILL.md'));
    assert.ok(entry.files.length <= 32);
  }
});
