import { memo } from 'react';
import type { ComposerToken } from './types';
import { composerDisplaySegments } from './suggestions';

// A pre-wrapped div needs a glyph to create the empty line after a terminal
// newline. The textarea creates that line intrinsically.
const TRAILING_NEWLINE_MARKER = '\u200b';

const ComposerHighlightView = ({
  value,
  activeToken,
}: Readonly<{
  value: string;
  activeToken: ComposerToken | null;
}>) => (
  <>
    {composerDisplaySegments(value, activeToken).map((segment, index) => (
      <span
        key={`${segment.kind}:${index}`}
        className={segment.kind === 'text'
          ? 'text-primary'
          : 'text-link'}
      >
        {segment.text}
      </span>
    ))}
    {value.endsWith('\n') ? TRAILING_NEWLINE_MARKER : null}
  </>
);

export const ComposerHighlight = memo(ComposerHighlightView);
