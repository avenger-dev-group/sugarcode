import * as React from 'react';

import { cn } from '@/renderer/utils/class-name';

const Textarea = ({
  className,
  ...props
}: React.ComponentProps<'textarea'>) => (
  <textarea
    data-slot="textarea"
    className={cn(
      'min-h-20 w-full resize-none bg-transparent px-3 py-2 text-sm font-normal leading-[22px] text-foreground outline-none placeholder:text-tertiary disabled:cursor-not-allowed disabled:opacity-50',
      className,
    )}
    {...props}
  />
);

export { Textarea };
