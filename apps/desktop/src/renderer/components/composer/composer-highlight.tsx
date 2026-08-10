import type { ComposerToken } from './types';
import { composerDisplaySegments } from './suggestions';

export const ComposerHighlight = ({
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
  </>
);
