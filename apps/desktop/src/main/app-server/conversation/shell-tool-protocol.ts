import path from 'node:path';

const MAX_COMMAND_BYTES = 32 * 1024;
const MAX_DESCRIPTION_BYTES = 512;
const MAX_ARGUMENTS = 64;
const MAX_ARGUMENT_BYTES = 8 * 1024;
const MAX_TOTAL_BYTES = 32 * 1024;

const utf8Bytes = (value: string): number =>
  new TextEncoder().encode(value).byteLength;

const hasControlCharacters = (value: string): boolean =>
  Array.from(value).some((character) => /\p{Cc}/u.test(character));

const parseArguments = (value: unknown): readonly string[] => {
  if (
    !Array.isArray(value) ||
    value.length > MAX_ARGUMENTS ||
    value.some(
      (argument) =>
        typeof argument !== 'string' ||
        utf8Bytes(argument) > MAX_ARGUMENT_BYTES ||
        hasControlCharacters(argument),
    )
  ) {
    throw new Error('Invalid shell/exec arguments.');
  }
  return [...(value as string[])];
};

export const parseShellToolCallPayload = (
  value: Record<string, unknown>,
): Readonly<{ command: string; arguments: readonly string[] }> => {
  const keys = Object.keys(value).sort().join(',');
  const usesJsonArguments =
    keys === 'argvJson,command,cwd,description';
  const usesDirectKind =
    keys === 'argvJson,command,cwd,description,kind';
  const usesLegacyArguments =
    keys === 'arguments,command,cwd,description';
  const usesShell =
    (keys === 'command,cwd,description,kind' ||
      keys === 'command,cwd,description,kind,timeoutMs') &&
    value.kind === 'shell';
  if (
    (!usesJsonArguments && !usesDirectKind && !usesLegacyArguments && !usesShell) ||
    typeof value.cwd !== 'string' ||
    typeof value.description !== 'string' ||
    value.description.length === 0 ||
    utf8Bytes(value.description) > MAX_DESCRIPTION_BYTES ||
    hasControlCharacters(value.description) ||
    typeof value.command !== 'string' ||
    value.command.length === 0 ||
    utf8Bytes(value.command) > MAX_COMMAND_BYTES ||
    value.command.includes('\0') ||
    (!usesShell && (!path.isAbsolute(value.command) || hasControlCharacters(value.command))) ||
    (usesDirectKind && value.kind !== 'direct') ||
    (usesShell &&
      value.timeoutMs !== undefined &&
      (!Number.isSafeInteger(value.timeoutMs) ||
        (value.timeoutMs as number) < 1 ||
        (value.timeoutMs as number) > 600_000))
  ) {
    throw new Error('Invalid shell/exec ToolCall Item.');
  }

  if (usesShell) {
    return { command: value.command, arguments: [] };
  }
  let argumentsValue: unknown = value.arguments;
  if (usesJsonArguments || usesDirectKind) {
    if (
      typeof value.argvJson !== 'string' ||
      utf8Bytes(value.argvJson) > MAX_TOTAL_BYTES
    ) {
      throw new Error('Invalid shell/exec argvJson.');
    }
    try {
      argumentsValue = JSON.parse(value.argvJson);
    } catch {
      throw new Error('Invalid shell/exec argvJson.');
    }
  }
  const argumentsList = parseArguments(argumentsValue);
  if (
    utf8Bytes(value.command) +
      argumentsList.reduce(
        (total, argument) => total + utf8Bytes(argument),
        0,
      ) >
    MAX_TOTAL_BYTES
  ) {
    throw new Error('Invalid shell/exec command size.');
  }
  return { command: value.command, arguments: argumentsList };
};
