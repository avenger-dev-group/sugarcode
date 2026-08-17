import {
  AlertCircle,
  CheckCircle2,
  Download,
  ExternalLink,
  Info,
  LoaderCircle,
  RefreshCw,
} from 'lucide-react';
import { useState } from 'react';

import desktopPackage from '../../../../package.json';
import appIcon from '../../../../assets/icon.png';
import { Button } from '@/renderer/components/ui/button';
import { useStore as useUpdateStore } from '@/renderer/components/update/use-store';
import {
  checkUpdate,
  installUpdate,
  openUpdateDownloadPage,
} from '@/renderer/services/update';
import type {
  UpdateActionReason,
  UpdateActionResult,
  UpdateStateSnapshot,
} from '@/shared/update';

const resultMessage = (reason: UpdateActionReason): string => {
  switch (reason) {
    case 'busy':
      return '更新任务正在进行中，请稍候。';
    case 'unavailable':
      return '当前平台暂不支持自动更新。';
    case 'invalid':
      return '更新包校验失败，请前往下载页面重新下载。';
    case 'failed':
      return '操作未完成，请稍后重试。';
    case 'accepted':
      return '';
  }
};

const statusContent = (
  update: UpdateStateSnapshot,
): Readonly<{
  title: string;
  description: string;
  icon: typeof CheckCircle2;
  iconClassName: string;
}> => {
  switch (update.status) {
    case 'checking':
      return {
        title: '正在检查更新',
        description: '正在连接发布服务器并核对最新版本。',
        icon: LoaderCircle,
        iconClassName: 'animate-spin text-secondary',
      };
    case 'downloading':
      return {
        title: '正在下载更新',
        description: '发现新版本，安装包会在后台完成校验。',
        icon: Download,
        iconClassName: 'text-secondary',
      };
    case 'ready':
      return {
        title: `SugarCode v${update.version} 已准备好`,
        description: '更新已下载并通过校验，可以立即安装。',
        icon: CheckCircle2,
        iconClassName: 'text-success',
      };
    case 'upToDate':
      return {
        title: 'SugarCode 已是最新版本',
        description: `当前安装的是 v${desktopPackage.version}，暂无可用更新。`,
        icon: CheckCircle2,
        iconClassName: 'text-success',
      };
    case 'fallback':
      return {
        title: '暂时无法自动更新',
        description: '你可以重新检查，或前往发布页面手动下载。',
        icon: AlertCircle,
        iconClassName: 'text-warning',
      };
    case 'idle':
      return {
        title: '检查 SugarCode 更新',
        description: '手动检查是否有适用于当前设备的新版本。',
        icon: RefreshCw,
        iconClassName: 'text-secondary',
      };
  }
};

export const AboutSettings = () => {
  const update = useUpdateStore();
  const [acting, setActing] = useState(false);
  const [message, setMessage] = useState('');
  const status = statusContent(update);
  const StatusIcon = status.icon;
  const checking = update.status === 'checking';
  const downloading = update.status === 'downloading';
  const pending = checking || downloading;

  const runAction = (action: () => Promise<UpdateActionResult>): void => {
    if (acting || pending) return;
    setActing(true);
    setMessage('');
    void action()
      .then((result) => {
        if (!result.accepted) {
          setMessage(resultMessage(result.reason));
        }
      })
      .catch(() => setMessage('操作未完成，请稍后重试。'))
      .finally(() => setActing(false));
  };

  return (
    <>
      <header className="border-b px-6 py-5">
        <div className="flex items-center gap-2.5">
          <Info className="size-4 text-secondary" aria-hidden="true" />
          <h2 className="text-sm font-medium">关于</h2>
        </div>
        <p className="mt-1.5 max-w-2xl text-sm font-normal leading-normal text-secondary">
          查看版本信息，并保持 SugarCode 为最新版本。
        </p>
      </header>

      <div className="px-6 py-6">
        <section className="flex items-center gap-4 border-b pb-6" aria-labelledby="product-name">
          <div className="flex size-16 shrink-0 items-center justify-center overflow-hidden rounded-2xl border bg-surface shadow-sm">
            <img src={appIcon} alt="" className="size-14" />
          </div>
          <div className="min-w-0">
            <h3 id="product-name" className="text-xl font-semibold tracking-[-0.03em]">
              SugarCode
            </h3>
            <p className="mt-1 text-sm font-normal text-secondary">
              AI 编程工作台 · 版本 {desktopPackage.version}
            </p>
          </div>
        </section>

        <section className="py-6" aria-labelledby="update-title">
          <h3 id="update-title" className="text-sm font-medium">
            软件更新
          </h3>
          <div className="mt-3 rounded-xl border bg-surface/35 p-4">
            <div className="flex items-start gap-3">
              <div className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-full border bg-background">
                <StatusIcon
                  className={`size-4 ${status.iconClassName}`}
                  aria-hidden="true"
                />
              </div>
              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium">{status.title}</p>
                <p className="mt-1 text-sm font-normal leading-normal text-secondary">
                  {status.description}
                </p>
              </div>
            </div>

            <div className="mt-4 flex flex-wrap items-center gap-2 pl-11">
              {update.status === 'ready' ? (
                <Button
                  type="button"
                  disabled={acting}
                  onClick={() => runAction(installUpdate)}
                >
                  <Download aria-hidden="true" />
                  {acting ? '正在启动…' : '安装更新'}
                </Button>
              ) : (
                <Button
                  type="button"
                  variant={update.status === 'fallback' ? 'outline' : 'default'}
                  disabled={acting || pending}
                  onClick={() => runAction(checkUpdate)}
                >
                  <RefreshCw
                    className={checking ? 'animate-spin' : undefined}
                    aria-hidden="true"
                  />
                  {checking
                    ? '正在检查…'
                    : downloading
                      ? '正在下载…'
                      : update.status === 'fallback'
                        ? '重新检查'
                        : update.status === 'upToDate'
                          ? '再次检查'
                          : '检查更新'}
                </Button>
              )}
              {update.status === 'fallback' ? (
                <Button
                  type="button"
                  variant="ghost"
                  disabled={acting}
                  onClick={() => runAction(openUpdateDownloadPage)}
                >
                  <ExternalLink aria-hidden="true" />
                  前往下载页面
                </Button>
              ) : null}
            </div>

            {message ? (
              <p className="mt-3 pl-11 text-xs font-normal text-warning" role="status">
                {message}
              </p>
            ) : null}
          </div>
        </section>

        <footer className="border-t pt-5 text-xs font-normal leading-relaxed text-tertiary">
          © 2026 AixvoLink LLC。保留所有权利。
        </footer>
      </div>
    </>
  );
};
