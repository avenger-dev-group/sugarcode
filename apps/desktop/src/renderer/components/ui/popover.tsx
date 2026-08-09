import * as React from 'react';
import { Popover as PopoverPrimitive } from 'radix-ui';

import { cn } from '@/renderer/utils/class-name';

const Popover = PopoverPrimitive.Root;
const PopoverTrigger = PopoverPrimitive.Trigger;
const PopoverAnchor = PopoverPrimitive.Anchor;

const PopoverContent = ({
  className,
  align = 'center',
  sideOffset = 7,
  ...props
}: React.ComponentProps<typeof PopoverPrimitive.Content>) => (
  <PopoverPrimitive.Portal>
    <PopoverPrimitive.Content
      align={align}
      sideOffset={sideOffset}
      className={cn(
        'z-50 rounded-xl border bg-popover text-popover-foreground shadow-lg outline-none data-[state=closed]:animate-out data-[state=open]:animate-in data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95 motion-reduce:animate-none',
        className,
      )}
      {...props}
    />
  </PopoverPrimitive.Portal>
);

export { Popover, PopoverAnchor, PopoverContent, PopoverTrigger };
