export const SKILLS_MARKET_INSTALL_CHANNEL = 'skills-market:install';

export type CuratedSkillCategory = 'engineering-quality';

export const CURATED_SKILL_CATEGORIES: readonly Readonly<{
  id: CuratedSkillCategory;
  label: string;
  description: string;
}>[] = [{
  id: 'engineering-quality',
  label: '工程质量',
  description: '测试、验证与代码审查工作流',
}];

export type CuratedSkill = Readonly<{
  id: string;
  name: string;
  description: string;
  category: CuratedSkillCategory;
  keywords: readonly string[];
  author: string;
  license: string;
  version: string;
  minimumAppVersion: string;
  repository: string;
  commit: string;
  path: string;
  directorySha256: string;
  skillSha256: string;
  files: readonly string[];
  preview: string;
}>;

const normalizeSearchText = (value: string): string =>
  value.normalize('NFKC').toLocaleLowerCase().replace(/[\s_-]+/gu, ' ').trim();

const includesOrderedCharacters = (value: string, query: string): boolean => {
  let offset = 0;
  for (const character of query) {
    offset = value.indexOf(character, offset);
    if (offset < 0) return false;
    offset += character.length;
  }
  return true;
};

export const curatedSkillMatches = (entry: CuratedSkill, query: string): boolean => {
  const normalizedQuery = normalizeSearchText(query);
  if (!normalizedQuery) return true;
  const searchable = normalizeSearchText([
    entry.name,
    entry.description,
    entry.author,
    entry.category,
    ...entry.keywords,
  ].join(' '));
  return searchable.includes(normalizedQuery) ||
    includesOrderedCharacters(searchable, normalizedQuery);
};

const numericVersion = (value: string): readonly number[] | undefined => {
  const core = value.trim().replace(/^v/u, '').split('-', 1)[0];
  if (!core || !/^\d+(?:\.\d+){0,3}$/u.test(core)) return undefined;
  return core.split('.').map(Number);
};

export const appVersionSatisfies = (current: string, minimum: string): boolean => {
  const left = numericVersion(current);
  const right = numericVersion(minimum);
  if (!left || !right) return false;
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    const difference = (left[index] ?? 0) - (right[index] ?? 0);
    if (difference !== 0) return difference > 0;
  }
  return true;
};

const OPENAI_PLUGINS_COMMIT = '11c74d6ba24d3a6d48f54a194cd00ef3beea18f9';

export const CURATED_SKILLS: readonly CuratedSkill[] = [
  {
    id: 'openai-verification-before-completion',
    name: 'verification-before-completion',
    description: '在宣称完成前运行验证并核对真实输出，避免用推测代替证据。',
    category: 'engineering-quality',
    keywords: ['验证', '完成', '测试', 'evidence', 'quality'],
    author: 'OpenAI / Superpowers',
    license: 'MIT',
    version: '2026.08.17',
    minimumAppVersion: '3.3.2',
    repository: 'https://github.com/openai/plugins.git',
    commit: OPENAI_PLUGINS_COMMIT,
    path: 'plugins/superpowers/skills/verification-before-completion',
    directorySha256: 'd503a317e4b4bc6ffc6a667b74e29cf7d745b47a31d706a7da4454c8c5960b59',
    skillSha256: 'ea52d15aabaf72bc6b558efe2c126f161b53961090ddcd712000273bfe8c7b6c',
    files: ['SKILL.md', 'agents/openai.yaml'],
    preview: `# Verification Before Completion

## Overview

Claiming work is complete without verification is dishonesty, not efficiency.

**Core principle:** Evidence before claims, always.

## The Gate Function

Before claiming any status: identify the command that proves it, run the full command, read its complete output, and only then report the result. Previous runs, partial checks, or confidence are not verification evidence.`,
  },
  {
    id: 'openai-test-driven-development',
    name: 'test-driven-development',
    description: '在实现功能或修复缺陷前建立失败测试，并以最小改动推动测试通过。',
    category: 'engineering-quality',
    keywords: ['测试驱动', '单元测试', '回归', 'tdd', 'red green refactor'],
    author: 'OpenAI / Superpowers',
    license: 'MIT',
    version: '2026.08.17',
    minimumAppVersion: '3.3.2',
    repository: 'https://github.com/openai/plugins.git',
    commit: OPENAI_PLUGINS_COMMIT,
    path: 'plugins/superpowers/skills/test-driven-development',
    directorySha256: '8e41d965878925b2b948ce3c96513dc4421aa3d75ccfd0b372f1e22286670943',
    skillSha256: '7dee67b4af6bdccc7a914ca34533184d64592d0f5b23aeae631538168db14994',
    files: ['SKILL.md', 'agents/openai.yaml', 'testing-anti-patterns.md'],
    preview: `# Test-Driven Development

## Overview

Write the test first. Watch it fail. Write minimal code to pass.

**Core principle:** If you did not watch the test fail, you do not know whether it tests the intended behavior.

## Red-Green-Refactor

1. **RED:** write one focused failing test and verify that it fails for the expected reason.
2. **GREEN:** implement the smallest behavior that makes it pass.
3. **REFACTOR:** improve the implementation while keeping the complete suite green.`,
  },
  {
    id: 'openai-receiving-code-review',
    name: 'receiving-code-review',
    description: '以技术验证处理代码审查意见，在反馈含糊或可疑时先核实再修改。',
    category: 'engineering-quality',
    keywords: ['代码审查', '反馈', '验证', 'review', 'feedback'],
    author: 'OpenAI / Superpowers',
    license: 'MIT',
    version: '2026.08.17',
    minimumAppVersion: '3.3.2',
    repository: 'https://github.com/openai/plugins.git',
    commit: OPENAI_PLUGINS_COMMIT,
    path: 'plugins/superpowers/skills/receiving-code-review',
    directorySha256: '48c3c6b9f65cb96fcf2a202b710bb364a6008c2d9f45922f92c6564e1927ab49',
    skillSha256: 'c9382e92b8f32363566068ecfed19d3b2651eaf40d3942b24840f839dedfc406',
    files: ['SKILL.md', 'agents/openai.yaml'],
    preview: `# Code Review Reception

## Overview

Code review requires technical evaluation, not emotional performance.

**Core principle:** Verify before implementing. Ask before assuming. Technical correctness over social comfort.

## Response Pattern

Read the complete feedback, restate the requirement, verify it against the current codebase, evaluate whether it is technically sound, and then implement one independently testable item at a time.`,
  },
];
