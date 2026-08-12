import { Check, Copy, TriangleAlert } from 'lucide-react';

import { Button } from '@/renderer/components/ui/button';

import { useCopyText } from './use-copy-text';

export const MessageCopyButton = ({
  text,
  className,
}: Readonly<{ text: string; className?: string }>) => {
  const { copy, state } = useCopyText(text);
  const label = state === 'copied'
    ? '已复制'
    : state === 'failed'
      ? '复制失败，请重试'
      : '复制消息';

  return (
    <Button
      type="button"
      variant="ghost"
      size="icon-xs"
      className={className}
      aria-label={label}
      title={label}
      onClick={() => void copy()}
    >
      {state === 'copied' ? (
        <Check aria-hidden="true" />
      ) : state === 'failed' ? (
        <TriangleAlert aria-hidden="true" />
      ) : (
        <Copy aria-hidden="true" />
      )}
      <span className="sr-only" aria-live="polite">
        {state === 'idle' ? '' : label}
      </span>
    </Button>
  );
};
