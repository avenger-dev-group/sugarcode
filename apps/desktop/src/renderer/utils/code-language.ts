type CodeLanguage = Readonly<{
  highlight: string | undefined;
  label: string;
}>;

const LANGUAGE_BY_EXTENSION: Readonly<Record<string, CodeLanguage>> = {
  c: { highlight: 'c', label: 'C' },
  cc: { highlight: 'cpp', label: 'C++' },
  cpp: { highlight: 'cpp', label: 'C++' },
  cs: { highlight: 'csharp', label: 'C#' },
  css: { highlight: 'css', label: 'CSS' },
  go: { highlight: 'go', label: 'Go' },
  h: { highlight: 'c', label: 'C' },
  hpp: { highlight: 'cpp', label: 'C++' },
  html: { highlight: 'html', label: 'HTML' },
  java: { highlight: 'java', label: 'Java' },
  js: { highlight: 'javascript', label: 'JavaScript' },
  json: { highlight: 'json', label: 'JSON' },
  jsx: { highlight: 'javascript', label: 'JavaScript React' },
  md: { highlight: 'markdown', label: 'Markdown' },
  php: { highlight: 'php', label: 'PHP' },
  py: { highlight: 'python', label: 'Python' },
  rb: { highlight: 'ruby', label: 'Ruby' },
  rs: { highlight: 'rust', label: 'Rust' },
  sh: { highlight: 'bash', label: 'Shell' },
  toml: { highlight: 'ini', label: 'TOML' },
  ts: { highlight: 'typescript', label: 'TypeScript' },
  tsx: { highlight: 'typescript', label: 'TypeScript React' },
  xml: { highlight: 'xml', label: 'XML' },
  yaml: { highlight: 'yaml', label: 'YAML' },
  yml: { highlight: 'yaml', label: 'YAML' },
  zsh: { highlight: 'bash', label: 'Shell' },
};

export const codeLanguageForPath = (path: string): CodeLanguage => {
  const filename = path.replaceAll('\\', '/').split('/').at(-1) ?? path;
  const extension = filename.includes('.')
    ? filename.split('.').at(-1)?.toLowerCase()
    : undefined;
  return LANGUAGE_BY_EXTENSION[extension ?? ''] ?? {
    highlight: undefined,
    label: 'Plain text',
  };
};
