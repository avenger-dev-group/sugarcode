import { FileCode2 } from 'lucide-react';

import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/renderer/components/ui/tooltip';
import { cn } from '@/renderer/utils/class-name';

import type { FileReferenceLinkProps } from './types';
import { useStore } from './use-store';

export const FileReferenceLink = ({
  children,
  exactPath = false,
  openFile,
  path,
  variant,
  workspaceGeneration,
  workspaceReady,
}: FileReferenceLinkProps) => {
  const store = useStore(
    path,
    exactPath,
    openFile,
    workspaceGeneration,
    workspaceReady,
  );

  return (
    <Tooltip
      onOpenChange={(open) => {
        if (open) {
          store.prepare();
        }
      }}
    >
      <TooltipTrigger asChild>
        <button
          type="button"
          className={cn(
            'inline-flex max-w-full cursor-pointer items-baseline gap-1 text-link underline decoration-link-muted underline-offset-[3px] transition-[color,text-decoration-color] hover:text-link-hover hover:decoration-link focus-visible:rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
            variant === 'code'
              ? 'font-mono text-[0.92em] font-normal'
              : undefined,
          )}
          onClick={() => void store.open()}
          onFocus={store.prepare}
          aria-label={`在右侧打开 ${path}`}
        >
          <FileCode2
            className="size-3 shrink-0 self-center"
            strokeWidth={1.8}
            aria-hidden="true"
          />
          <span className="min-w-0 break-all">{children}</span>
        </button>
      </TooltipTrigger>
      <TooltipContent
        className="break-all font-mono"
        side="top"
        aria-label={`文件位置：${store.locationLabel}`}
      >
        {store.locationLabel}
      </TooltipContent>
    </Tooltip>
  );
};
