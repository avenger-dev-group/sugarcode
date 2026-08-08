import { isAbsoluteWorkspaceFileReference } from '../../../shared/workspace-file-reference.ts';

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
const CODE_REFERENCE_FORBIDDEN_PATTERN = /[[\]{}()<>"'`=,*?&|!;]/u;

export const toWorkspaceFileReference = (
  value: string | undefined,
): string | null => {
  if (!value) {
    return null;
  }
  const normalized = value
    .trim()
    .replace(/^`|`$/gu, '')
    .replace(/#L\d+(?:-L\d+)?$/u, '')
    .replace(LINE_SUFFIX_PATTERN, '')
    .replace(/^\.\//u, '');
  const candidate = (() => {
    if (!normalized.includes('%')) {
      return normalized;
    }
    try {
      return decodeURIComponent(normalized);
    } catch {
      return normalized;
    }
  })();
  if (
    isAbsoluteWorkspaceFileReference(candidate) &&
    candidate.length <= 1_024 &&
    !candidate.includes('://') &&
    !Array.from(candidate).some((character) => /\p{Cc}/u.test(character)) &&
    !candidate
      .split(/[\\/]/u)
      .some((part) => part === '.' || part === '..')
  ) {
    return candidate;
  }
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

const toCodeSpanFileCandidate = (value: string): string | null => {
  const candidate = toWorkspaceFileReference(value);
  if (
    !candidate ||
    candidate.startsWith('@') ||
    CODE_REFERENCE_FORBIDDEN_PATTERN.test(candidate) ||
    isAbsoluteWorkspaceFileReference(candidate)
  ) {
    return null;
  }
  const name = candidate.split('/').at(-1) ?? '';
  return (name.startsWith('.') && name.length > 1) ||
    name.includes('.') ||
    EXTENSIONLESS_FILE_NAMES.has(name)
    ? candidate
    : null;
};

export const resolveVerifiedWorkspaceFileReference = (
  value: string,
  verifiedPaths: readonly string[],
): string | null =>
  createVerifiedWorkspaceFileReferenceResolver(verifiedPaths)(value);

export const createVerifiedWorkspaceFileReferenceResolver = (
  verifiedPaths: readonly string[],
): ((value: string) => string | null) => {
  const matches = new Map<string, string | null>();
  for (const path of verifiedPaths) {
    const normalizedPath = path.replaceAll('\\', '/').replace(/^\.\//u, '');
    const parts = normalizedPath.split('/').filter(Boolean);
    for (let index = 0; index < parts.length; index += 1) {
      const suffix = parts.slice(index).join('/');
      const existing = matches.get(suffix);
      matches.set(suffix, existing === undefined || existing === path ? path : null);
    }
  }
  return (value: string): string | null => {
    const candidate = toCodeSpanFileCandidate(value);
    return candidate
      ? matches.get(candidate.replaceAll('\\', '/')) ?? null
      : null;
  };
};
