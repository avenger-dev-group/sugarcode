const SAFE_PATH_PATTERN = /^(?:[^/\\\s:]+\/)*[^/\\\s:]+$/u;
const LINE_SUFFIX_PATTERN = /(?::\d+){1,2}$/u;
const EXTENSIONLESS_FILE_NAMES = new Set([
  'Dockerfile',
  'Gemfile',
  'LICENSE',
  'Makefile',
  'Procfile',
  'Rakefile',
  'README',
]);

export const toWorkspaceFileReference = (
  value: string | undefined,
): string | null => {
  if (!value) {
    return null;
  }
  const candidate = value
    .trim()
    .replace(/^`|`$/gu, '')
    .replace(/#L\d+(?:-L\d+)?$/u, '')
    .replace(LINE_SUFFIX_PATTERN, '')
    .replace(/^\.\//u, '');
  if (
    candidate.length === 0 ||
    candidate.length > 1_024 ||
    candidate.startsWith('/') ||
    candidate.startsWith('\\') ||
    candidate.includes('://') ||
    !SAFE_PATH_PATTERN.test(candidate) ||
    candidate.split('/').some((part) => part === '.' || part === '..')
  ) {
    return null;
  }
  const name = candidate.split('/').at(-1) ?? '';
  return candidate.includes('/') ||
    (name.startsWith('.') && name.length > 1) ||
    name.includes('.') ||
    EXTENSIONLESS_FILE_NAMES.has(name)
    ? candidate
    : null;
};
