import * as React from 'react';

import { cn } from '@/renderer/utils/class-name';

const Input = ({
  className,
  type = 'text',
  ...props
}: React.ComponentProps<'input'>) => (
  <input
    type={type}
    data-slot="input"
    className={cn(
      'h-9 w-full min-w-0 rounded-lg border bg-background px-3 text-sm text-foreground outline-none transition-colors placeholder:text-tertiary focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/20 disabled:cursor-not-allowed disabled:opacity-50',
      className,
    )}
    {...props}
  />
);

export { Input };
