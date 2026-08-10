import * as React from 'react';
import { ScrollArea as ScrollAreaPrimitive } from 'radix-ui';

import { cn } from '@/renderer/utils/class-name';

const ScrollArea = ({
  className,
  children,
  scrollbars = 'vertical',
  viewportProps,
  ...props
}: React.ComponentProps<typeof ScrollAreaPrimitive.Root> & {
  scrollbars?: 'both' | 'horizontal' | 'vertical';
  viewportProps?: React.ComponentProps<
    typeof ScrollAreaPrimitive.Viewport
  >;
}) => (
  <ScrollAreaPrimitive.Root
    data-slot="scroll-area"
    className={cn('relative', className)}
    {...props}
  >
    <ScrollAreaPrimitive.Viewport
      data-slot="scroll-area-viewport"
      {...viewportProps}
      className={cn(
        'size-full rounded-[inherit] outline-none focus-visible:ring-3 focus-visible:ring-ring/50',
        viewportProps?.className,
      )}
    >
      {children}
    </ScrollAreaPrimitive.Viewport>
    {scrollbars === 'vertical' || scrollbars === 'both' ? <ScrollBar /> : null}
    {scrollbars === 'horizontal' || scrollbars === 'both' ? (
      <ScrollBar orientation="horizontal" />
    ) : null}
    <ScrollAreaPrimitive.Corner />
  </ScrollAreaPrimitive.Root>
);

const ScrollBar = ({
  className,
  orientation = 'vertical',
  ...props
}: React.ComponentProps<typeof ScrollAreaPrimitive.ScrollAreaScrollbar>) => (
  <ScrollAreaPrimitive.ScrollAreaScrollbar
    data-slot="scroll-area-scrollbar"
    orientation={orientation}
    className={cn(
      'flex touch-none p-px transition-colors select-none',
      orientation === 'vertical' && 'h-full w-2.5 border-l border-l-transparent',
      orientation === 'horizontal' &&
        'h-2.5 flex-col border-t border-t-transparent',
      className,
    )}
    {...props}
  >
    <ScrollAreaPrimitive.ScrollAreaThumb
      data-slot="scroll-area-thumb"
      className="relative flex-1 rounded-full bg-border"
    />
  </ScrollAreaPrimitive.ScrollAreaScrollbar>
);

export { ScrollArea, ScrollBar };
