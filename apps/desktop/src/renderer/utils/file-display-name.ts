const normalizedPathParts = (path: string): readonly string[] =>
  path.replaceAll('\\', '/').split('/').filter(Boolean);

export const fileBasename = (path: string): string =>
  normalizedPathParts(path).at(-1) ?? path;

export const createShortestUniquePathLabels = (
  paths: readonly string[],
): ReadonlyMap<string, string> => {
  const uniquePaths = [...new Set(paths)];
  const partsByPath = new Map(
    uniquePaths.map((path) => [path, normalizedPathParts(path)]),
  );
  const suffixCounts = new Map<string, number>();
  for (const parts of partsByPath.values()) {
    for (let length = 1; length <= parts.length; length += 1) {
      const suffix = parts.slice(-length).join('/');
      suffixCounts.set(suffix, (suffixCounts.get(suffix) ?? 0) + 1);
    }
  }
  return new Map(
    uniquePaths.map((path) => {
      const parts = partsByPath.get(path) ?? [];
      for (let length = 1; length <= parts.length; length += 1) {
        const suffix = parts.slice(-length).join('/');
        if (suffixCounts.get(suffix) === 1) {
          return [path, suffix] as const;
        }
      }
      return [path, parts.join('/') || path] as const;
    }),
  );
};
