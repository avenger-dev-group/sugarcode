import { Check, LoaderCircle } from 'lucide-react';

import { Button } from '@/renderer/components/ui/button';
import { DialogClose } from '@/renderer/components/ui/dialog';

import type { ModelConfigStore } from './types';

type ModelConfigSaveBarProps = Readonly<{
  showCloseAction?: boolean;
  store: ModelConfigStore;
}>;

export const ModelConfigSaveBar = ({
  showCloseAction,
  store,
}: ModelConfigSaveBarProps) => (
  <footer className="flex shrink-0 flex-col gap-3 border-t bg-background px-5 py-3 sm:flex-row sm:items-center lg:px-6">
    <div
      className="min-h-5 flex-1 text-xs text-secondary"
      role="status"
      aria-live="polite"
    >
      {store.busy ? (
        <span className="flex items-center gap-2">
          <LoaderCircle
            className="size-3.5 animate-spin motion-reduce:animate-none"
            aria-hidden="true"
          />
          {store.phase === 'loading'
            ? '正在加载配置…'
            : store.phase === 'deleting'
              ? '正在删除 API 密钥…'
              : '正在保存配置…'}
        </span>
      ) : (
        (store.notice ?? '更改会应用于新回合；正在进行的回合继续使用当前模型。')
      )}
    </div>
    <div className="flex gap-2 sm:justify-end">
      {showCloseAction ? (
        <DialogClose asChild>
          <Button type="button" variant="ghost" disabled={store.busy}>
            关闭
          </Button>
        </DialogClose>
      ) : null}
      <Button
        type="button"
        size="lg"
        disabled={store.busy || !store.inspection}
        onClick={store.save}
      >
        <Check aria-hidden="true" />
        保存配置
      </Button>
    </div>
  </footer>
);
