import { Moon, Sun } from 'lucide-react';

import { ConnectionStatus } from '@/renderer/components/connection/connection-status';
import { Button } from '@/renderer/components/ui/button';

import { useStore } from './use-store';

export const FoundationScreen = () => {
  const { isDark, themeLabel, toggleTheme } = useStore();

  return (
    <div className={isDark ? 'dark' : undefined}>
      <main className="flex min-h-screen items-center justify-center bg-background px-6 py-12 text-foreground transition-colors">
        <section className="w-full max-w-sm" aria-labelledby="foundation-title">
          <div className="mb-10 flex items-center gap-2.5">
            <span
              className="size-2 rounded-full bg-primary"
              aria-hidden="true"
            />
            <p className="text-sm font-medium tracking-[-0.01em]">SugarCode</p>
          </div>

          <h1
            id="foundation-title"
            className="max-w-xs text-2xl font-medium tracking-[-0.03em]"
          >
            Local runtime, in view.
          </h1>
          <p className="mt-3 text-secondary">
            SugarCode Desktop verifies its native CLI before work begins.
          </p>

          <div className="mt-8">
            <ConnectionStatus />
          </div>

          <Button
            className="mt-6"
            type="button"
            aria-pressed={isDark}
            onClick={toggleTheme}
          >
            {isDark ? (
              <Sun aria-hidden="true" />
            ) : (
              <Moon aria-hidden="true" />
            )}
            {themeLabel}
          </Button>
        </section>
      </main>
    </div>
  );
};
