const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const utf8Bytes = (value: string): number =>
  new TextEncoder().encode(value).byteLength;

export const parseWorkspaceApplyPatchPaths = (
  argumentsValue: unknown,
  isValidPath: (value: unknown) => value is string,
): readonly string[] => {
  const patch = typeof argumentsValue === 'string'
    ? argumentsValue
    : isRecord(argumentsValue) &&
        Object.keys(argumentsValue).length === 1 &&
        typeof argumentsValue.patch === 'string'
      ? argumentsValue.patch
      : null;
  if (
    patch === null ||
    patch.length === 0 ||
    utf8Bytes(patch) > 96 * 1024 ||
    /\r(?!\n)/u.test(patch)
  ) {
    throw new Error('Invalid workspace/apply-patch ToolCall arguments.');
  }
  const lines = patch.replaceAll('\r\n', '\n').split('\n');
  if (lines.at(-1) === '') {
    lines.pop();
  }
  if (lines[0] !== '*** Begin Patch' || lines.at(-1) !== '*** End Patch') {
    throw new Error('Invalid workspace/apply-patch boundaries.');
  }
  const marker = /^\*\*\* (?:Add|Update|Delete) File: (.+)$/u;
  const paths = lines
    .map((line) => marker.exec(line)?.[1])
    .filter((path): path is string => path !== undefined);
  if (
    paths.length === 0 ||
    paths.length > 64 ||
    paths.some((path) => !isValidPath(path)) ||
    new Set(paths).size !== paths.length
  ) {
    throw new Error('Invalid workspace/apply-patch paths.');
  }
  return paths;
};
