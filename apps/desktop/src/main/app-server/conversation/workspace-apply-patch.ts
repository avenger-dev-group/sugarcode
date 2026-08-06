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
    utf8Bytes(patch) > 96 * 1024
  ) {
    throw new Error('Invalid workspace/apply-patch ToolCall arguments.');
  }
  const rawLines = patch.trim().replaceAll('\r\n', '\n').split('\n');
  const first = rawLines[0]?.trim();
  const last = rawLines.at(-1)?.trim();
  const hasHeredoc =
    (first === '<<EOF' || first === "<<'EOF'" || first === '<<"EOF"') &&
    last === 'EOF' &&
    rawLines.length >= 4;
  const lines = hasHeredoc ? rawLines.slice(1, -1) : rawLines;
  if (
    lines[0]?.trim() !== '*** Begin Patch' ||
    lines.at(-1)?.trim() !== '*** End Patch'
  ) {
    throw new Error('Invalid workspace/apply-patch boundaries.');
  }

  const paths: string[] = [];
  const seenPaths = new Set<string>();
  let mode: 'top' | 'add' | 'delete' | 'update' = 'top';
  let currentPath: string | null = null;
  let currentUpdateMoved = false;
  let currentRepeatedUpdate = false;
  for (const line of lines.slice(1, -1)) {
    const candidate = mode === 'update' ? line.trimEnd() : line.trim();
    const marker = /^\*\*\* (Add|Update|Delete) File: (.+)$/u.exec(candidate);
    if (marker) {
      const operation = marker[1];
      const path = marker[2]?.trim();
      if (path === undefined) {
        throw new Error('Invalid workspace/apply-patch paths.');
      }
      const repeatedAdjacentUpdate =
        operation === 'Update' &&
        mode === 'update' &&
        currentPath === path &&
        !currentUpdateMoved;
      if (seenPaths.has(path) && !repeatedAdjacentUpdate) {
        throw new Error('Invalid workspace/apply-patch paths.');
      }
      if (!repeatedAdjacentUpdate) {
        seenPaths.add(path);
        paths.push(path);
      }
      mode = operation === 'Add' ? 'add' : operation === 'Delete' ? 'delete' : 'update';
      currentPath = path;
      currentUpdateMoved = false;
      currentRepeatedUpdate = repeatedAdjacentUpdate;
      continue;
    }
    if (mode === 'update') {
      const move = /^\*\*\* Move to: (.+)$/u.exec(candidate);
      const path = move?.[1]?.trim();
      if (path !== undefined) {
        if (currentRepeatedUpdate || seenPaths.has(path)) {
          throw new Error('Invalid workspace/apply-patch paths.');
        }
        currentUpdateMoved = true;
        seenPaths.add(path);
        paths.push(path);
      }
    }
  }
  if (
    paths.length === 0 ||
    paths.length > 64 ||
    paths.some((path) => !isValidPath(path))
  ) {
    throw new Error('Invalid workspace/apply-patch paths.');
  }
  return paths;
};
