import type { ReactNode } from 'react';

export const MainSurfaceHeader = ({
  icon,
  title,
  description,
  actions,
  children,
  leadingInset = false,
}: Readonly<{
  icon: ReactNode;
  title: string;
  description: string;
  actions?: ReactNode;
  children?: ReactNode;
  leadingInset?: boolean;
}>) => (
  <header
    className={`window-main-surface-header shrink-0 border-b bg-surface/30 px-6 py-5 sm:px-8 ${
      leadingInset ? 'window-collapsed-header' : ''
    }`}
  >
    <div className="flex flex-wrap items-start gap-4">
      <div className="flex min-w-0 flex-1 items-start gap-4">
        <span className="grid size-10 shrink-0 place-items-center rounded-xl border bg-background text-secondary shadow-sm">
          {icon}
        </span>
        <div className="min-w-0 flex-1">
          <h1 className="text-lg font-semibold tracking-[-0.025em]">{title}</h1>
          <p className="mt-1 max-w-2xl text-sm leading-6 text-secondary">
            {description}
          </p>
        </div>
      </div>
      {actions ? (
        <div className="window-no-drag relative z-10 flex items-center gap-2">
          {actions}
        </div>
      ) : null}
    </div>
    {children}
  </header>
);
