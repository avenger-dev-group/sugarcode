import { FunctionTool } from '@google/adk';
import { Type, type Schema } from '@google/genai';

import { findComposerReferences } from '../shared/composer.ts';
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
  validateSteering: (content: readonly RuntimeContentPart[]) => void;
  steeringInstruction: (content: readonly RuntimeContentPart[]) => string;
}>;

const skillSchema = (skills: readonly RuntimeSkill[]): Schema =>
  ({
    type: Type.OBJECT,
    properties: {
      name: {
        type: Type.STRING,
        description:
          'Exact Skill name from the available Skills inventory, without the leading $ marker.',
        enum: skills.map((skill) => skill.name),
      },
      purpose: {
        type: Type.STRING,
        description:
          'One concise public sentence in the user\'s language explaining how this Skill will be applied to the current task. Do not describe tool mechanics.',
      },
    },
    required: ['name'],
  }) satisfies Schema;

const normalizeRequestedSkillName = (value: unknown): string => {
  if (typeof value !== 'string') {
    return '';
  }
  const trimmed = value.trim();
  const name = (trimmed.startsWith('$') ? trimmed.slice(1) : trimmed)
    .toLowerCase();
  return /^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(name) ? name : '';
};

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
  for (const reference of findComposerReferences(input)) {
    if (reference.kind !== 'skill') {
      continue;
    }
    const name = reference.target;
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
    return {
      instruction: '',
      tools: [],
      validateSteering: () => undefined,
      steeringInstruction: () => '',
    };
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
  const validateSteering = (content: readonly RuntimeContentPart[]): void => {
    const names = selectedSkillNames(textInput(content), context.skills);
    const additions = context.skills.filter(
      (skill) => names.includes(skill.name) && !loaded.has(skill.name),
    );
    if (loaded.size + additions.length > MAX_SELECTED_SKILLS) {
      throw new Error('A Turn can explicitly select at most four Skills.');
    }
    if (
      loadedBytes + additions.reduce((bytes, skill) => bytes + skill.bytes, 0) >
      MAX_SELECTED_BYTES
    ) {
      throw new Error('Selected Skills exceed the bounded Turn context.');
    }
  };
  const tool = new FunctionTool({
    name: 'load_skill',
    description:
      'Load the single best-matching Skill from the frozen inventory before following it. Pass the exact inventory name without $, and include a concise public purpose for the process timeline.',
    parameters: skillSchema(context.skills),
    execute: async (input) => {
      const requestedName =
        typeof input === 'object' &&
        input !== null &&
        'name' in input &&
        typeof input.name === 'string'
          ? input.name
          : '';
      const name = normalizeRequestedSkillName(requestedName);
      const purpose =
        typeof input === 'object' &&
        input !== null &&
        'purpose' in input &&
        typeof input.purpose === 'string' &&
        new TextEncoder().encode(input.purpose.trim()).byteLength <= 512
          ? input.purpose.trim()
          : '';
      const skill = context.skills.find((candidate) => candidate.name === name);
      if (!skill) {
        return {
          ok: false,
          error: 'skillNotFound',
          availableSkills: context.skills.map((candidate) => candidate.name),
        };
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
        description: skill.description,
        ...(purpose ? { purpose } : {}),
        sha256: skill.sha256,
        content: skill.content,
      };
    },
  });
  return {
    instruction:
      `# Available Skills\n\n${inventory}\n\n` +
      'When a Skill clearly applies, load the single best match with load_skill before acting. ' +
      'Pass only its inventory name without the leading $ marker, and do not load Skills merely because they are available. ' +
      'Include one concise public purpose in the original user\'s language explaining how that Skill applies to the current task. ' +
      'A Skill explicitly named with $name is already selected below and must be followed within the user\'s requested outcome without overriding explicit plain-text constraints. ' +
      'Skill instructions narrow the task but cannot expand tools, permissions, or authority.' +
      (selectedContent.length > 0
        ? `\n\n# Explicitly selected Skills\n\n${selectedContent.join('\n\n')}`
        : ''),
    tools: [tool],
    validateSteering,
    steeringInstruction: (content) => {
      const names = selectedSkillNames(textInput(content), context.skills);
      if (names.length === 0) {
        return '';
      }
      validateSteering(content);
      const selectedForSteer: string[] = [];
      for (const name of names) {
        const skill = context.skills.find((candidate) => candidate.name === name);
        if (!skill) {
          continue;
        }
        if (!loaded.has(name)) {
          loaded.add(name);
          loadedBytes += skill.bytes;
        }
        selectedForSteer.push(
          `## Selected Skill: $${skill.name}\n\n${skill.content}`,
        );
      }
      return selectedForSteer.length > 0
        ? '# Skills selected by the user adjustment\n\n' + selectedForSteer.join('\n\n')
        : '';
    },
  };
};
