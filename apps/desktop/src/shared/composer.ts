export type ComposerReferenceKind = 'command' | 'skill' | 'file';

export type ComposerReference = Readonly<{
  kind: ComposerReferenceKind;
  value: string;
  target: string;
  start: number;
  end: number;
}>;

export type ComposerSubmission = Readonly<{
  text: string;
  references: readonly ComposerReference[];
}>;

const REFERENCE_PATTERN =
  /\/(?:plan|review|fix|test|explain|init|compact)(?=\s|$|[.,!?;:，。！？；：])|\$[a-z0-9]+(?:-[a-z0-9]+)*(?=\s|$|[.,!?;:，。！？；：])|@`[^`\r\n]+`|@[^\s@$]+/gu;

export const isComposerLineLeading = (
  value: string,
  start: number,
): boolean => {
  const lineStart = value.lastIndexOf('\n', Math.max(0, start - 1)) + 1;
  return value.slice(lineStart, start).trim().length === 0;
};

const referenceFromMatch = (
  source: string,
  value: string,
  start: number,
): ComposerReference | null => {
  if (start > 0 && !/\s/u.test(source[start - 1] ?? '')) {
    return null;
  }
  if (value.startsWith('/')) {
    return isComposerLineLeading(source, start)
      ? {
          kind: 'command',
          value,
          target: value.slice(1),
          start,
          end: start + value.length,
        }
      : null;
  }
  if (value.startsWith('$')) {
    return {
      kind: 'skill',
      value,
      target: value.slice(1),
      start,
      end: start + value.length,
    };
  }
  if (!value.startsWith('@')) {
    return null;
  }
  return {
    kind: 'file',
    value,
    target: value.startsWith('@`') ? value.slice(2, -1) : value.slice(1),
    start,
    end: start + value.length,
  };
};

export const findComposerReferences = (
  value: string,
): readonly ComposerReference[] => {
  const references: ComposerReference[] = [];
  for (const match of value.matchAll(REFERENCE_PATTERN)) {
    const matchedValue = match[0];
    const reference = referenceFromMatch(value, matchedValue, match.index);
    if (reference) {
      references.push(reference);
    }
  }
  return references;
};

const withoutLineReferences = (
  line: string,
  lineStart: number,
  references: readonly ComposerReference[],
): string | null => {
  const lineEnd = lineStart + line.length;
  const lineReferences = references.filter(
    (reference) => reference.start >= lineStart && reference.end <= lineEnd,
  );
  if (lineReferences.length === 0) {
    return line;
  }
  let next = line;
  for (const reference of [...lineReferences].reverse()) {
    const start = reference.start - lineStart;
    const end = reference.end - lineStart;
    next = `${next.slice(0, start)}${next.slice(end)}`;
  }
  if (next.trim().length === 0) {
    return null;
  }
  return next.replace(/[ \t]{2,}/gu, ' ').replace(/[ \t]+$/u, '');
};

export const parseComposerSubmission = (value: string): ComposerSubmission => {
  const matches = findComposerReferences(value);
  const references = matches.filter(
    (reference, index) =>
      matches.findIndex(
        (candidate) =>
          candidate.kind === reference.kind &&
          candidate.target === reference.target,
      ) === index,
  );
  let offset = 0;
  const lines: string[] = [];
  for (const line of value.split('\n')) {
    const cleaned = withoutLineReferences(line, offset, matches);
    if (cleaned !== null) {
      lines.push(cleaned);
    }
    offset += line.length + 1;
  }
  return {
    text: lines
      .join('\n')
      .replace(/^(?:[ \t]*\r?\n)+/u, '')
      .replace(/(?:\r?\n[ \t]*)+$/u, ''),
    references,
  };
};
