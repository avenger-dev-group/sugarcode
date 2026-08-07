import type { ConversationWorkspacePatchFile } from '../../../shared/conversation.ts';

import type {
  FileChangeReviewFile,
  UnifiedDiffHunk,
  UnifiedDiffLine,
} from './types';

const HUNK_HEADER =
  /^@@ -(?<oldStart>\d+),(?<oldCount>\d+) \+(?<newStart>\d+),(?<newCount>\d+) @@$/u;

export const parseUnifiedDiff = (
  diff: string,
): readonly UnifiedDiffHunk[] => {
  const lines = diff.slice(0, -1).split('\n').slice(2);
  const hunks: UnifiedDiffHunk[] = [];
  let index = 0;
  while (index < lines.length) {
    const header = lines[index] ?? '';
    const match = HUNK_HEADER.exec(header);
    if (!match?.groups) {
      throw new Error('Validated FileChange diff contained an invalid hunk.');
    }
    let oldLine = Number(match.groups.oldStart);
    let newLine = Number(match.groups.newStart);
    index += 1;
    const hunkLines: UnifiedDiffLine[] = [];
    while (index < lines.length && !lines[index]?.startsWith('@@ ')) {
      const source = lines[index] ?? '';
      const prefix = source[0];
      const text = source.slice(1);
      if (prefix === ' ') {
        hunkLines.push({
          kind: 'context',
          oldLine,
          newLine,
          text,
        });
        oldLine += 1;
        newLine += 1;
      } else if (prefix === '-') {
        hunkLines.push({
          kind: 'deletion',
          oldLine,
          newLine: null,
          text,
        });
        oldLine += 1;
      } else if (prefix === '+') {
        hunkLines.push({
          kind: 'addition',
          oldLine: null,
          newLine,
          text,
        });
        newLine += 1;
      } else {
        throw new Error(
          'Validated FileChange diff contained an invalid line.',
        );
      }
      index += 1;
    }
    hunks.push({ header, lines: hunkLines });
  }
  return hunks;
};

export const toWorkspacePatchReviewFile = (
  id: string,
  file: ConversationWorkspacePatchFile,
): FileChangeReviewFile | undefined => {
  if (
    file.diff === undefined ||
    file.newlineStyle === undefined ||
    file.finalNewline === undefined
  ) {
    return undefined;
  }
  try {
    const hunks = parseUnifiedDiff(file.diff);
    const lines = hunks.flatMap((hunk) => hunk.lines);
    return {
      id,
      path: file.path,
      kind: file.kind,
      hunks,
      additions: lines.filter((line) => line.kind === 'addition').length,
      deletions: lines.filter((line) => line.kind === 'deletion').length,
      beforeSha256: file.beforeSha256,
      afterSha256: file.afterSha256,
      beforeBytes: file.beforeBytes,
      afterBytes: file.afterBytes,
      newlineStyle: file.newlineStyle,
      finalNewline: file.finalNewline,
    };
  } catch {
    return undefined;
  }
};
