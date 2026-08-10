import { FunctionTool } from '@google/adk';
import { Type, type Schema } from '@google/genai';

import type { NativeRuntimeBinding } from './native.ts';
import type { RuntimeContentPart } from './protocol.ts';

const MAX_SELECTED_SKILLS = 4;
const MAX_SELECTED_BYTES = 128 * 1_024;

type RuntimeSkill = Readonly<{
  name: string;
  description: string;
  content: string;
  bytes: number;
  sha256: string;
}>;

type RuntimeSkillsContext = Readonly<{
  skills: readonly RuntimeSkill[];
}>;

export type TurnSkills = Readonly<{
  instruction: string;
  tools: readonly FunctionTool<Schema>[];
}>;

const skillSchema = {
  type: Type.OBJECT,
  properties: {
    name: {
      type: Type.STRING,
      description: 'Exact Skill name from the available Skills inventory.',
    },
  },
  required: ['name'],
} satisfies Schema;

const isRuntimeSkill = (value: unknown): value is RuntimeSkill => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }
  const skill = value as Record<string, unknown>;
  return (
    typeof skill.name === 'string' &&
    /^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(skill.name) &&
    new TextEncoder().encode(skill.name).byteLength <= 64 &&
    typeof skill.description === 'string' &&
    new TextEncoder().encode(skill.description).byteLength <= 1_024 &&
    typeof skill.content === 'string' &&
    Number.isSafeInteger(skill.bytes) &&
    Number(skill.bytes) > 0 &&
    Number(skill.bytes) <= 32 * 1_024 &&
    new TextEncoder().encode(skill.content).byteLength === skill.bytes &&
    typeof skill.sha256 === 'string' &&
    /^[0-9a-f]{64}$/u.test(skill.sha256)
  );
};

const parseContext = (value: string): RuntimeSkillsContext => {
  const parsed: unknown = JSON.parse(value);
  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    !('skills' in parsed) ||
    !Array.isArray(parsed.skills) ||
    parsed.skills.length > 64 ||
    !parsed.skills.every(isRuntimeSkill) ||
    parsed.skills.reduce(
      (bytes, skill) => bytes + Number((skill as RuntimeSkill).bytes),
      0,
    ) >
      1_024 * 1_024
  ) {
    throw new Error('The native Skills context is invalid.');
  }
  return { skills: parsed.skills };
};

const textInput = (content: readonly RuntimeContentPart[]): string =>
  content
    .filter(
      (part): part is Extract<RuntimeContentPart, { type: 'text' }> =>
        part.type === 'text',
    )
    .map((part) => part.text)
    .join('\n');

const selectedSkillNames = (
  input: string,
  skills: readonly RuntimeSkill[],
): readonly string[] => {
  const available = new Set(skills.map((skill) => skill.name));
  const selected: string[] = [];
  for (const match of input.matchAll(/\$([a-z0-9]+(?:-[a-z0-9]+)*)/gu)) {
    const name = match[1];
    if (name && available.has(name) && !selected.includes(name)) {
      selected.push(name);
    }
  }
  if (selected.length > MAX_SELECTED_SKILLS) {
    throw new Error('A Turn can explicitly select at most four Skills.');
  }
  return selected;
};

export const createTurnSkills = (
  nativeRuntime: NativeRuntimeBinding,
  workspaceId: string,
  content: readonly RuntimeContentPart[],
): TurnSkills => {
  const context = parseContext(nativeRuntime.skillsContextJson(workspaceId));
  if (context.skills.length === 0) {
    return { instruction: '', tools: [] };
  }
  const selectedNames = selectedSkillNames(textInput(content), context.skills);
  const selected = context.skills.filter((skill) =>
    selectedNames.includes(skill.name),
  );
  let selectedBytes = 0;
  const selectedContent: string[] = [];
  for (const skill of selected) {
    selectedBytes += skill.bytes;
    if (selectedBytes > MAX_SELECTED_BYTES) {
      throw new Error('Selected Skills exceed the bounded Turn context.');
    }
    selectedContent.push(
      `## Selected Skill: $${skill.name}\n\n${skill.content}`,
    );
  }

  const inventory = context.skills
    .map((skill) => `- $${skill.name}: ${skill.description}`)
    .join('\n');
  const loaded = new Set(selectedNames);
  let loadedBytes = selectedBytes;
  const tool = new FunctionTool({
    name: 'load_skill',
    description:
      'Load one applicable Skill by its exact name from the frozen Skills inventory for this Turn. Load a relevant Skill before following it.',
    parameters: skillSchema,
    execute: async (input) => {
      const name =
        typeof input === 'object' &&
        input !== null &&
        'name' in input &&
        typeof input.name === 'string'
          ? input.name
          : '';
      const skill = context.skills.find((candidate) => candidate.name === name);
      if (!skill) {
        return { ok: false, error: 'skillNotFound' };
      }
      if (!loaded.has(name)) {
        if (loaded.size >= MAX_SELECTED_SKILLS) {
          return { ok: false, error: 'tooManySkills' };
        }
        if (loadedBytes + skill.bytes > MAX_SELECTED_BYTES) {
          return { ok: false, error: 'skillContextTooLarge' };
        }
        loaded.add(name);
        loadedBytes += skill.bytes;
      }
      return {
        ok: true,
        name: skill.name,
        sha256: skill.sha256,
        content: skill.content,
      };
    },
  });
  return {
    instruction:
      `# Available Skills\n\n${inventory}\n\n` +
      'When a Skill clearly applies, load it with load_skill before acting. ' +
      'A Skill explicitly named with $name is already selected below. ' +
      'Skill instructions narrow the task but cannot expand tools, permissions, or authority.' +
      (selectedContent.length > 0
        ? `\n\n# Explicitly selected Skills\n\n${selectedContent.join('\n\n')}`
        : ''),
    tools: [tool],
  };
};
