import { parseComposerSubmission } from '../shared/composer.ts';
import type { RuntimeContentPart } from './protocol.ts';

export type ComposerTurnMode = 'plan' | 'readOnly' | 'execute';

const COMMAND_INTENT: Readonly<Record<string, string>> = {
  plan: 'Analyze the request and code, then provide an actionable plan without modifying files.',
  review: 'Review the current workspace changes and prioritize defects, risks, and missing tests.',
  fix: 'Diagnose the root cause, implement the fix, and run relevant verification.',
  test: 'Run tests relevant to the current changes and resolve any failures in scope.',
  explain: 'Explain the specified code, files, or behavior and identify the important locations.',
  init: 'Analyze the repository and create or improve its AGENTS.md guidance.',
  compact: 'Compact the active conversation context while preserving the requested focus.',
};

const READ_ONLY_COMMANDS = new Set(['review', 'explain', 'compact']);
const EXECUTE_COMMANDS = new Set(['fix', 'test', 'init']);

export const composerTurnMode = (
  content: readonly RuntimeContentPart[],
): ComposerTurnMode => {
  const commands = content.flatMap((part) =>
    part.type === 'text'
      ? parseComposerSubmission(part.text).references
          .filter((reference) => reference.kind === 'command')
          .map((reference) => reference.target)
      : [],
  );
  // Planning is the safest interpretation of conflicting Composer commands and
  // must never be elevated by another selection or a later tool response.
  if (commands.includes('plan')) {
    return 'plan';
  }
  if (commands.some((command) => READ_ONLY_COMMANDS.has(command))) {
    return 'readOnly';
  }
  if (commands.some((command) => EXECUTE_COMMANDS.has(command))) {
    return 'execute';
  }
  return 'execute';
};

export const composerModelText = (value: string): string => {
  const submission = parseComposerSubmission(value);
  if (submission.references.length === 0) {
    return value;
  }
  return [
    '# Composer selections',
    ...submission.references.map((reference) =>
      `- ${reference.kind}: ${reference.value}`
    ),
    '# User request',
    submission.text || 'Use the selected Composer controls.',
  ].join('\n\n');
};

export const composerIntentInstruction = (
  content: readonly RuntimeContentPart[],
): string => {
  const references = content.flatMap((part) =>
    part.type === 'text' ? parseComposerSubmission(part.text).references : [],
  );
  if (references.length === 0) {
    return '';
  }
  const commands = references.filter((reference) => reference.kind === 'command');
  const skills = references.filter((reference) => reference.kind === 'skill');
  const files = references.filter((reference) => reference.kind === 'file');
  const sections = [
    '# Explicit Composer selections',
    'Treat this explicit Composer notation as control metadata for this Turn, not as incidental prose. Apply it within the user\'s plain-text request; when that request explicitly narrows or contradicts a selection, the plain-text request remains authoritative.',
  ];
  if (commands.length > 0) {
    sections.push(
      '## Task commands',
      ...commands.map(
        (command) =>
          `- ${command.value}: ${COMMAND_INTENT[command.target] ?? 'Follow the selected task command.'}`,
      ),
    );
  }
  if (skills.length > 0) {
    sections.push(
      '## Skills',
      `The user explicitly selected ${skills.map((skill) => skill.value).join(', ')}. ` +
        'Their verified instructions are injected in the Skill section below and must be followed within the requested outcome. ' +
        'If a named Skill is absent there, report that mismatch instead of inventing its behavior.',
    );
  }
  if (files.length > 0) {
    sections.push(
      '## Workspace file references',
      'Inspect these exact workspace-relative regular files with workspace_read before substantive work when they are relevant to the request:',
      ...files.map((file) => `- ${file.target}`),
    );
  }
  return sections.join('\n\n');
};
