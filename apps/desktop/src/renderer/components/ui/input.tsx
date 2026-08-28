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
      'h-9 w-full min-w-0 rounded-[10px] border border-border-strong bg-surface-raised px-3 text-sm text-foreground shadow-[var(--shadow-raised)] outline-none transition-[border-color,box-shadow,background-color] placeholder:text-tertiary hover:border-input focus-visible:border-ring focus-visible:bg-background focus-visible:ring-3 focus-visible:ring-ring/15 disabled:cursor-not-allowed disabled:opacity-50',
      className,
    )}
    {...props}
  />
);

export { Input };
