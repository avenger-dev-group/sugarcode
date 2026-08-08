import { Check, Copy, TriangleAlert } from 'lucide-react';
import { type ReactElement, useMemo } from 'react';

import { Button } from '@/renderer/components/ui/button';
import { highlightCode } from '@/renderer/utils/syntax-highlighter';

import type { AgentCodeBlockProps, CodeBlockCopyState } from './types';
import { useStore } from './use-store';

const CODE_LANGUAGE_HINT_PATTERN =
  /^[A-Za-z0-9][A-Za-z0-9_+.#-]{0,63}$/u;

const codeLanguageHint = (language: string | undefined): string | null => {
  const hint = language?.trimStart().split(/\s+/u, 1)[0];
  return hint && CODE_LANGUAGE_HINT_PATTERN.test(hint) ? hint : null;
};

const codeLineCount = (code: string): number => {
  if (code.length === 0) {
    return 0;
  }
  return code.split('\n').length;
};

const codeLineLabel = (lines: number): string =>
  `${lines} ${lines === 1 ? 'line' : 'lines'}`;

const copyLabel = (state: CodeBlockCopyState): string => {
  switch (state) {
    case 'copied':
      return 'Copied';
    case 'failed':
      return 'Copy failed';
    default:
      return 'Copy';
  }
};

const copyAriaLabel = (state: CodeBlockCopyState): string => {
  switch (state) {
    case 'copied':
      return 'Code copied';
    case 'failed':
      return 'Copy failed. Try again';
    default:
      return 'Copy code';
  }
};

export const AgentCodeBlock = ({
  code,
  language,
}: AgentCodeBlockProps): ReactElement => {
  const languageHint = codeLanguageHint(language);
  const highlightedCode = useMemo(
    () => highlightCode(code, languageHint ?? undefined),
    [code, languageHint],
  );
  const { copy, copyState } = useStore(code);
  const lineLabel = codeLineLabel(codeLineCount(code));
  const label = copyLabel(copyState);
  const captionLabel = languageHint
    ? `${languageHint} code, ${lineLabel}`
    : `Code block, ${lineLabel}`;

  return (
    <figure
      aria-label={captionLabel}
      className="agent-code-block syntax-highlight my-3.5 min-w-0 max-w-full overflow-hidden rounded-lg border bg-surface first:mt-0 last:mb-0"
    >
      <figcaption className="flex min-w-0 items-center gap-3 border-b px-2 py-1 font-mono text-[10px] text-tertiary">
        <span className="min-w-0 break-all px-1 uppercase tracking-[0.12em]">
          {languageHint ?? 'Code'}
        </span>
        <span className="ml-auto shrink-0 whitespace-nowrap tracking-[0.08em]">
          {lineLabel}
        </span>
        <Button
          aria-label={copyAriaLabel(copyState)}
          className="h-6 px-1.5 font-mono text-[10px] text-tertiary hover:bg-surface-hover hover:text-foreground"
          onClick={() => {
            void copy();
          }}
          size="xs"
          title={copyState === 'failed' ? 'Copy failed. Try again' : label}
          type="button"
          variant="ghost"
        >
          {copyState === 'copied' ? (
            <Check aria-hidden="true" />
          ) : copyState === 'failed' ? (
            <TriangleAlert aria-hidden="true" />
          ) : (
            <Copy aria-hidden="true" />
          )}
          <span aria-live="polite">{label}</span>
        </Button>
      </figcaption>
      <pre className="max-w-full overflow-x-auto p-3 font-mono text-xs font-normal leading-5">
        {highlightedCode === null ? (
          <code>{code}</code>
        ) : (
          <code
            className="hljs"
            dangerouslySetInnerHTML={{ __html: highlightedCode }}
          />
        )}
      </pre>
    </figure>
  );
};
