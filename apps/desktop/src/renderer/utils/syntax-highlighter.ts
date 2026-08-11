import highlight from 'highlight.js/lib/common';

const MAX_HIGHLIGHT_CHARACTERS = 256 * 1024;

const LANGUAGE_ALIASES: Readonly<Record<string, string>> = {
  'c#': 'csharp',
  'c++': 'cpp',
  cs: 'csharp',
  cxx: 'cpp',
  golang: 'go',
  h: 'c',
  hpp: 'cpp',
  js: 'javascript',
  jsx: 'javascript',
  md: 'markdown',
  py: 'python',
  rb: 'ruby',
  rs: 'rust',
  sh: 'bash',
  shell: 'bash',
  ts: 'typescript',
  tsx: 'typescript',
  yml: 'yaml',
  zsh: 'bash',
};

const normalizedLanguage = (language: string): string => {
  const candidate = language.trim().toLowerCase();
  return LANGUAGE_ALIASES[candidate] ?? candidate;
};

export const highlightCode = (
  code: string,
  language: string | undefined,
): string | null => {
  if (!language || code.length > MAX_HIGHLIGHT_CHARACTERS) {
    return null;
  }
  const normalized = normalizedLanguage(language);
  if (!highlight.getLanguage(normalized)) {
    return null;
  }
  return highlight.highlight(code, {
    language: normalized,
    ignoreIllegals: true,
  }).value;
};
