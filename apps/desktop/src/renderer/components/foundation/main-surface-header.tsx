import type { ReactNode } from 'react';

export const MainSurfaceHeader = ({
  icon,
  title,
  description,
  actions,
  children,
  leadingInset = false,
  compact = false,
}: Readonly<{
  icon: ReactNode;
  title: string;
  description: string;
  actions?: ReactNode;
  children?: ReactNode;
  leadingInset?: boolean;
  compact?: boolean;
}>) => (
  <header
    className={`window-main-surface-header shrink-0 border-b bg-surface/30 px-6 sm:px-8 ${
      compact ? 'py-4' : 'py-5'
    } ${
      leadingInset ? 'window-collapsed-header' : ''
    }`}
  >
    <div className={`flex flex-wrap gap-4 ${compact ? 'items-center' : 'items-start'}`}>
      <div className={`flex min-w-0 flex-1 gap-4 ${compact ? 'items-center' : 'items-start'}`}>
        <span className={`grid shrink-0 place-items-center rounded-xl border bg-background text-secondary shadow-sm ${compact ? 'size-9' : 'size-10'}`}>
          {icon}
        </span>
        <div className="min-w-0 flex-1">
          <h1 className={`${compact ? 'text-base' : 'text-lg'} font-semibold tracking-[-0.025em]`}>{title}</h1>
          <p className={`mt-1 max-w-2xl text-secondary ${compact ? 'text-xs leading-5' : 'text-sm leading-6'}`}>
            {description}
          </p>
        </div>
      </div>
      {actions ? (
        <div className="window-no-drag relative z-10 flex flex-wrap items-center gap-2">
          {actions}
        </div>
      ) : null}
    </div>
    {children}
  </header>
);
