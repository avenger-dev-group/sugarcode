import * as React from 'react';
import { ContextMenu as ContextMenuPrimitive } from 'radix-ui';

import { cn } from '@/renderer/utils/class-name';

const ContextMenu = ContextMenuPrimitive.Root;
const ContextMenuTrigger = ContextMenuPrimitive.Trigger;

const ContextMenuContent = ({
  className,
  ...props
}: React.ComponentProps<typeof ContextMenuPrimitive.Content>) => (
  <ContextMenuPrimitive.Portal>
    <ContextMenuPrimitive.Content
      className={cn(
        'z-50 min-w-36 overflow-hidden rounded-md border bg-popover p-1 text-popover-foreground shadow-xl outline-none data-[state=closed]:animate-out data-[state=open]:animate-in data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 motion-reduce:animate-none',
        className,
      )}
      {...props}
    />
  </ContextMenuPrimitive.Portal>
);

const ContextMenuItem = ({
  className,
  ...props
}: React.ComponentProps<typeof ContextMenuPrimitive.Item>) => (
  <ContextMenuPrimitive.Item
    className={cn(
      'flex h-7 cursor-default select-none items-center rounded px-2.5 text-sm font-normal text-primary outline-none data-[disabled]:pointer-events-none data-[disabled]:opacity-50 data-[highlighted]:bg-accent data-[highlighted]:text-primary',
      className,
    )}
    {...props}
  />
);

export {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
};
