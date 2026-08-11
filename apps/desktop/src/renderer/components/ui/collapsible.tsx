import * as React from 'react';
import { Collapsible as CollapsiblePrimitive } from 'radix-ui';

const Collapsible = (
  props: React.ComponentProps<typeof CollapsiblePrimitive.Root>,
) => <CollapsiblePrimitive.Root data-slot="collapsible" {...props} />;

const CollapsibleTrigger = (
  props: React.ComponentProps<typeof CollapsiblePrimitive.Trigger>,
) => (
  <CollapsiblePrimitive.Trigger
    data-slot="collapsible-trigger"
    {...props}
  />
);

const CollapsibleContent = (
  props: React.ComponentProps<typeof CollapsiblePrimitive.Content>,
) => (
  <CollapsiblePrimitive.Content
    data-slot="collapsible-content"
    {...props}
  />
);

export { Collapsible, CollapsibleContent, CollapsibleTrigger };
