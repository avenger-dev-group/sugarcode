import { Download } from 'lucide-react';
import { useState } from 'react';

import {
  installUpdate,
  openUpdateDownloadPage,
} from '@/renderer/services/update';
import { Button } from '@/renderer/components/ui/button';

import { useStore } from './use-store';

export const UpdateAction = () => {
  const update = useStore();
  const [acting, setActing] = useState(false);
  const visible = update.status === 'ready' || update.status === 'fallback';

  if (!visible) {
    return null;
  }

  const title = update.status === 'ready'
    ? `安装 SugarCode v${update.version}`
    : '打开 SugarCode 下载页面';

  return (
    <Button
      type="button"
      variant="default"
      className="w-full justify-start"
      disabled={acting}
      title={title}
      aria-label={title}
      onClick={() => {
        if (acting) return;
        setActing(true);
        const action = update.status === 'ready'
          ? installUpdate()
          : openUpdateDownloadPage();
        void action.finally(() => setActing(false));
      }}
    >
      <Download aria-hidden="true" />
      更新
    </Button>
  );
};
