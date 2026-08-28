import {
  findComposerReferences,
  isComposerLineLeading,
} from '../../../shared/composer.ts';
import type { SkillSummary } from '../../../shared/skills.ts';

import type {
  ComposerSuggestion,
  ComposerDisplaySegment,
  ComposerToken,
  ComposerTrigger,
} from './types';

const COMMANDS: readonly ComposerSuggestion[] = [
  {
    id: 'command:goal',
    kind: 'command',
    label: '持续目标',
    alias: '/goal',
    description: '创建或管理可跨 Turn 自动继续的持久 Goal',
    insertion: '/goal',
  },
  {
    id: 'command:plan',
    kind: 'command',
    label: '计划',
    alias: '/plan',
    description: '分析需求与代码，先给出可执行计划，不修改文件',
    insertion: '/plan',
  },
  {
    id: 'command:review',
    kind: 'command',
    label: '代码审查',
    alias: '/review',
    description: '审查当前工作区变更，优先指出缺陷、风险与缺失测试',
    insertion: '/review',
  },
  {
    id: 'command:fix',
    kind: 'command',
    label: '修复问题',
    alias: '/fix',
    description: '定位问题根因，完成修复并运行相关验证',
    insertion: '/fix',
  },
  {
    id: 'command:test',
    kind: 'command',
    label: '运行测试',
    alias: '/test',
    description: '运行与当前改动相关的测试并处理失败',
    insertion: '/test',
  },
  {
    id: 'command:explain',
    kind: 'command',
    label: '解释代码',
    alias: '/explain',
    description: '解释指定代码、文件或行为，并标出关键位置',
    insertion: '/explain',
  },
  {
    id: 'command:init',
    kind: 'command',
    label: '初始化项目',
    alias: '/init',
    description: '分析仓库并创建或完善项目的 AGENTS.md 指引',
    insertion: '/init',
  },
  {
    id: 'command:draw',
    kind: 'command',
    label: '绘制图表',
    alias: '/draw',
    description: '生成可编辑的 Draw.io 原生图表',
    insertion: '/draw',
  },
  {
    id: 'command:compact',
    kind: 'command',
    label: '压缩上下文',
    alias: '/compact',
    description: '压缩当前任务上下文，可在后面注明需要重点保留的内容',
    insertion: '/compact',
  },
];

const FIGMA_SKILL_LABELS: Readonly<Record<string, string>> = {
  'figma-code-connect': 'Figma: Code Connect',
  'figma-design-to-code': 'Figma: 设计转代码',
  'figma-selection-context': 'Figma: 读取设计上下文',
};

const skillSourceLabel = (skill: SkillSummary): string =>
  skill.source === 'project'
    ? '项目 Skill'
    : skill.source === 'bundled'
      ? '内置 Skill'
      : '个人 Skill';

const skillSuggestion = (skill: SkillSummary): ComposerSuggestion => {
  if (skill.name === 'figma') {
    return {
      id: `application:${skill.id}`,
      kind: 'application',
      label: 'Figma',
      alias: '$figma',
      brand: 'figma',
      description: '连接 Figma Desktop 画布，读取设计并协助构建产品界面',
      detail: '应用',
      insertion: '$figma',
    };
  }
  const figmaLabel = FIGMA_SKILL_LABELS[skill.name];
  return {
    id: skill.id,
    kind: 'skill',
    label: figmaLabel ?? skill.name,
    alias: figmaLabel ? `$${skill.name}` : undefined,
    brand: figmaLabel ? 'figma' : undefined,
    description: skill.description,
    detail: skillSourceLabel(skill),
    insertion: `$${skill.name}`,
  };
};

export const skillSuggestions = (
  skills: readonly SkillSummary[],
  query: string,
): readonly ComposerSuggestion[] => {
  const normalized = query.trim().toLocaleLowerCase();
  return skills
    .map(skillSuggestion)
    .filter((suggestion) =>
      `${suggestion.label} ${suggestion.alias ?? ''} ${suggestion.description}`
        .toLocaleLowerCase()
        .includes(normalized),
    )
    .sort((left, right) => {
      const leftRank = left.kind === 'application' ? 0 : left.brand === 'figma' ? 1 : 2;
      const rightRank = right.kind === 'application' ? 0 : right.brand === 'figma' ? 1 : 2;
      return leftRank - rightRank;
    });
};

const isTrigger = (value: string): value is ComposerTrigger =>
  value === '/' || value === '$' || value === '@';

export const findComposerToken = (
  value: string,
  caret: number,
): ComposerToken | null => {
  const beforeCaret = value.slice(0, Math.max(0, caret));
  const match = beforeCaret.match(/(?:^|\s)([/@$])([^\s@$]*)$/u);
  if (!match) {
    return null;
  }
  const marker = match[1] ?? '';
  if (!isTrigger(marker)) {
    return null;
  }
  const trigger = marker;
  const query = match[2] ?? '';
  if (trigger === '@' && /^https?:\/\//iu.test(query)) {
    return null;
  }
  const start = beforeCaret.length - query.length - 1;
  if (trigger === '/' && !isComposerLineLeading(beforeCaret, start)) {
    return null;
  }
  return { trigger, start, end: caret, query };
};

export const commandSuggestions = (
  query: string,
): readonly ComposerSuggestion[] => {
  const normalized = query.trim().toLocaleLowerCase();
  if (!normalized) {
    return COMMANDS;
  }
  return COMMANDS.filter((command) =>
    `${command.alias?.slice(1) ?? ''} ${command.label} ${command.description}`
      .toLocaleLowerCase()
      .includes(normalized),
  );
};

export const composerDisplaySegments = (
  value: string,
  activeToken: ComposerToken | null,
): readonly ComposerDisplaySegment[] => {
  if (!value.includes('/') && !value.includes('$') && !value.includes('@')) {
    return [{ kind: 'text', text: value }];
  }
  const segments: ComposerDisplaySegment[] = [];
  let cursor = 0;
  for (const reference of findComposerReferences(value)) {
    const { start, end } = reference;
    const text = reference.value;
    const kind: Exclude<ComposerDisplaySegment['kind'], 'text'> =
      reference.kind;
    const overlapsActiveToken =
      activeToken !== null &&
      start < activeToken.end &&
      end > activeToken.start;
    if (overlapsActiveToken) continue;
    if (start > cursor) {
      segments.push({ kind: 'text', text: value.slice(cursor, start) });
    }
    segments.push({ kind, text });
    cursor = end;
  }
  if (cursor < value.length) {
    segments.push({ kind: 'text', text: value.slice(cursor) });
  }
  return segments.length > 0 ? segments : [{ kind: 'text', text: value }];
};

export const replaceComposerToken = (
  value: string,
  token: ComposerToken,
  insertion: string,
): Readonly<{ value: string; caret: number }> => {
  const before = value.slice(0, token.start);
  const after = value.slice(token.end);
  const trailingSpace = after.length === 0 || !/^\s/u.test(after) ? ' ' : '';
  const next = `${before}${insertion}${trailingSpace}${after}`;
  return {
    value: next,
    caret: before.length + insertion.length + trailingSpace.length,
  };
};
