import * as React from 'react';
import { Tooltip as TooltipPrimitive } from 'radix-ui';

import { cn } from '@/renderer/utils/class-name';

const TooltipProvider = TooltipPrimitive.Provider;
const Tooltip = TooltipPrimitive.Root;
const TooltipTrigger = TooltipPrimitive.Trigger;

const TooltipContent = ({
  className,
  sideOffset = 7,
  ...props
}: React.ComponentProps<typeof TooltipPrimitive.Content>) => (
  <TooltipPrimitive.Portal>
    <TooltipPrimitive.Content
      sideOffset={sideOffset}
      className={cn(
        'z-50 max-w-[min(28rem,calc(100vw-2rem))] rounded-lg border bg-popover px-3 py-2 text-xs font-normal leading-5 text-popover-foreground shadow-lg data-[state=closed]:animate-out data-[state=delayed-open]:animate-in data-[state=closed]:fade-out-0 data-[state=delayed-open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=delayed-open]:zoom-in-95 motion-reduce:animate-none',
        className,
      )}
      {...props}
    />
  </TooltipPrimitive.Portal>
);

export {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
};
