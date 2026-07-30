import * as React from 'react';
import { AlertDialog as AlertDialogPrimitive } from 'radix-ui';

import { cn } from '@/renderer/utils/class-name';

const AlertDialog = (
  props: React.ComponentProps<typeof AlertDialogPrimitive.Root>,
) => <AlertDialogPrimitive.Root data-slot="alert-dialog" {...props} />;

const AlertDialogPortal = (
  props: React.ComponentProps<typeof AlertDialogPrimitive.Portal>,
) => (
  <AlertDialogPrimitive.Portal
    data-slot="alert-dialog-portal"
    {...props}
  />
);

const AlertDialogOverlay = ({
  className,
  ...props
}: React.ComponentProps<typeof AlertDialogPrimitive.Overlay>) => (
  <AlertDialogPrimitive.Overlay
    data-slot="alert-dialog-overlay"
    className={cn(
      'fixed inset-0 z-50 bg-black/50 data-[state=closed]:animate-out data-[state=open]:animate-in data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0',
      className,
    )}
    {...props}
  />
);

const AlertDialogContent = ({
  className,
  ...props
}: React.ComponentProps<typeof AlertDialogPrimitive.Content>) => (
  <AlertDialogPortal>
    <AlertDialogOverlay />
    <AlertDialogPrimitive.Content
      data-slot="alert-dialog-content"
      className={cn(
        'fixed top-1/2 left-1/2 z-50 grid max-h-[calc(100vh-3rem)] w-[calc(100%-2rem)] max-w-[42rem] -translate-x-1/2 -translate-y-1/2 gap-0 overflow-hidden rounded-xl border bg-background shadow-2xl outline-none data-[state=closed]:animate-out data-[state=open]:animate-in data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95',
        className,
      )}
      {...props}
    />
  </AlertDialogPortal>
);

const AlertDialogHeader = ({
  className,
  ...props
}: React.ComponentProps<'div'>) => (
  <div
    data-slot="alert-dialog-header"
    className={cn('flex flex-col gap-2', className)}
    {...props}
  />
);

const AlertDialogFooter = ({
  className,
  ...props
}: React.ComponentProps<'div'>) => (
  <div
    data-slot="alert-dialog-footer"
    className={cn(
      'flex flex-col-reverse gap-2 sm:flex-row sm:justify-end',
      className,
    )}
    {...props}
  />
);

const AlertDialogTitle = ({
  className,
  ...props
}: React.ComponentProps<typeof AlertDialogPrimitive.Title>) => (
  <AlertDialogPrimitive.Title
    data-slot="alert-dialog-title"
    className={cn(
      'text-lg font-semibold tracking-[-0.02em]',
      className,
    )}
    {...props}
  />
);

const AlertDialogDescription = ({
  className,
  ...props
}: React.ComponentProps<typeof AlertDialogPrimitive.Description>) => (
  <AlertDialogPrimitive.Description
    data-slot="alert-dialog-description"
    className={cn('text-sm text-secondary', className)}
    {...props}
  />
);

const AlertDialogAction = AlertDialogPrimitive.Action;
const AlertDialogCancel = AlertDialogPrimitive.Cancel;
const AlertDialogTrigger = AlertDialogPrimitive.Trigger;

export {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
};
