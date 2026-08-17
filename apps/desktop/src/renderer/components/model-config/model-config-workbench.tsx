import {
  Check,
  Cpu,
  KeyRound,
  LoaderCircle,
  Plus,
  Star,
  Trash2,
} from 'lucide-react';

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/renderer/components/ui/alert-dialog';
import { Button } from '@/renderer/components/ui/button';
import { Checkbox } from '@/renderer/components/ui/checkbox';
import { DialogClose } from '@/renderer/components/ui/dialog';
import { Input } from '@/renderer/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/renderer/components/ui/select';
import {
  DEFAULT_AGENT_MAX_OUTPUT_TOKENS,
  knownContextWindowTokens,
} from '@/shared/model-metadata';

import type { ModelConfigSettingsPanelProps } from './types';
import { PROVIDER_PRESETS } from './provider-presets';
import { useStore } from './use-store';

export const ModelConfigSettingsPanel = (
  props: ModelConfigSettingsPanelProps,
) => {
  const store = useStore(props);
  const credentialStatus = store.inspection?.credentialStatuses.find(
    (credential) =>
      credential.connectionId === store.selectedConnection.id,
  )?.status;
  const providerLabel =
    PROVIDER_PRESETS.find(
      (preset) =>
        preset.wireApi === store.selectedConnection.wireApi,
    )?.label ?? store.selectedConnection.providerFamily;
  const isDefault =
    store.config.defaultProfileId === store.selectedProfile.id;
  const contextWindow = store.selectedProfile.contextWindowTokens ??
    knownContextWindowTokens(
      store.selectedConnection.providerFamily,
      store.selectedProfile.modelId,
    );
  const calculatedThreshold = contextWindow === undefined
    ? undefined
    : Math.min(
      Math.floor(contextWindow * 0.85),
      contextWindow - DEFAULT_AGENT_MAX_OUTPUT_TOKENS -
        Math.max(4_096, Math.ceil(contextWindow * 0.05)),
    );

  return (
    <>
      <div className="flex h-full min-h-0 flex-col">
        <header className="flex h-[4.25rem] shrink-0 items-center gap-3 border-b px-6">
          <Cpu className="size-4 text-secondary" aria-hidden="true" />
          <h2 className="text-sm font-medium">模型配置</h2>
          <Button
            className="ml-auto"
            type="button"
            size="lg"
            variant="outline"
            disabled={store.busy}
            onClick={store.addConfiguration}
          >
            <Plus aria-hidden="true" />
            新建
          </Button>
        </header>

        <div className="grid min-h-0 flex-1 grid-rows-[auto_minmax(0,1fr)] md:grid-cols-[14rem_minmax(0,1fr)] md:grid-rows-1">
          <aside className="border-b bg-surface/35 p-3 md:border-r md:border-b-0">
            <div className="grid max-h-40 gap-1 overflow-y-auto md:max-h-none">
              {store.config.profiles.map((profile) => {
                const connection = store.config.connections.find(
                  (candidate) =>
                    candidate.id === profile.connectionId,
                );
                const preset = PROVIDER_PRESETS.find(
                  (candidate) =>
                    candidate.wireApi === connection?.wireApi,
                );
                const selected =
                  profile.id === store.selectedProfileId;
                const ready =
                  connection?.enabled === true &&
                  profile.modelId.trim().length > 0;
                return (
                  <button
                    key={profile.id}
                    type="button"
                    aria-current={selected ? 'true' : undefined}
                    className={`grid w-full grid-cols-[auto_minmax(0,1fr)] gap-x-2 rounded-lg px-3 py-2.5 text-left outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring ${
                      selected
                        ? 'bg-background text-primary shadow-sm'
                        : 'text-secondary hover:bg-surface-hover hover:text-primary'
                    }`}
                    disabled={store.busy}
                    onClick={() =>
                      store.setSelectedProfileId(profile.id)
                    }
                  >
                    <span
                      className={`mt-1.5 size-1.5 rounded-full ${
                        ready ? 'bg-success' : 'bg-border'
                      }`}
                      aria-hidden="true"
                    />
                    <span className="min-w-0">
                      <span className="block truncate text-sm font-medium">
                        {profile.displayName}
                      </span>
                      <span className="mt-0.5 block truncate text-xs text-tertiary">
                        {preset?.label ??
                          connection?.providerFamily ??
                          '不可用'}
                        {profile.modelId
                          ? ` · ${profile.modelId}`
                          : ''}
                      </span>
                    </span>
                  </button>
                );
              })}
            </div>
          </aside>

          <main className="min-h-0 overflow-y-auto">
            <fieldset
              className="grid gap-3 px-5 py-4 lg:px-6"
              disabled={store.busy || !store.inspection}
            >
              <legend className="sr-only">
                当前模型配置
              </legend>

              <div className="flex min-h-7 flex-wrap items-center justify-between gap-2">
                <div className="flex items-center gap-2 text-xs text-secondary">
                  <span>{providerLabel}</span>
                  {isDefault ? (
                    <span className="inline-flex items-center gap-1 rounded-full bg-surface px-2 py-1 text-primary">
                      <Star className="size-3" aria-hidden="true" />
                      默认
                    </span>
                  ) : null}
                </div>
                <div className="flex items-center gap-1">
                  {!isDefault ? (
                    <Button
                      type="button"
                      size="sm"
                      variant="ghost"
                      disabled={!store.selectedConnection.enabled}
                      onClick={store.setDefaultProfile}
                    >
                      <Star aria-hidden="true" />
                      设为默认
                    </Button>
                  ) : null}
                  <Button
                    type="button"
                    size="icon-sm"
                    variant="ghost"
                    aria-label="删除配置"
                    onClick={store.deleteConfiguration}
                  >
                    <Trash2 aria-hidden="true" />
                  </Button>
                </div>
              </div>

              {!store.selectedConnection.enabled ? (
                <div className="flex items-center justify-between gap-3 rounded-lg border px-3 py-2 text-sm text-secondary">
                  <span>这个已保存的连接当前已停用。</span>
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    onClick={() =>
                      store.updateConnection({ enabled: true })
                    }
                  >
                    启用
                  </Button>
                </div>
              ) : null}

              <div className="grid gap-3 sm:grid-cols-2">
                <label className="grid gap-1 text-sm">
                  <span className="text-secondary">模型协议</span>
                  <Select
                    value={store.selectedConnection.wireApi}
                    onValueChange={(wireApi) =>
                      store.setProviderWire(
                        wireApi as typeof store.selectedConnection.wireApi,
                      )
                    }
                  >
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {PROVIDER_PRESETS.map((preset) => (
                        <SelectItem
                          key={preset.wireApi}
                          value={preset.wireApi}
                        >
                          {preset.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </label>

                <label className="grid gap-1 text-sm">
                  <span className="text-secondary">
                    配置名称
                  </span>
                  <Input
                    value={store.selectedProfile.displayName}
                    placeholder="工作模型"
                    onChange={(event) =>
                      store.updateSelectedProfile({
                        displayName: event.target.value,
                      })
                    }
                  />
                </label>

                <label className="grid gap-1 text-sm">
                  <span className="text-secondary">模型</span>
                  <Input
                    value={store.selectedProfile.modelId}
                    placeholder="gpt-5"
                    spellCheck={false}
                    onChange={(event) =>
                      store.updateSelectedProfile({
                        modelId: event.target.value,
                      })
                    }
                  />
                </label>

              </div>

              <label className="grid gap-1 text-sm">
                <span className="text-secondary">基础 URL</span>
                <Input
                  value={store.selectedConnection.baseUrl}
                  inputMode="url"
                  spellCheck={false}
                  onChange={(event) =>
                    store.updateConnection({
                      baseUrl: event.target.value,
                    })
                  }
                />
              </label>

              <label className="grid gap-1 text-sm">
                <span className="flex items-center gap-2 text-secondary">
                  <span>API 密钥</span>
                  {credentialStatus === 'present' ? (
                    <span className="text-xs text-tertiary">已保存</span>
                  ) : null}
                </span>
                <div className="flex gap-2">
                  <Input
                    type="password"
                    value={store.credentialValue}
                    autoComplete="new-password"
                    spellCheck={false}
                    placeholder={
                      credentialStatus === 'present'
                        ? '留空以保留已保存的密钥'
                        : '可选'
                    }
                    onChange={(event) =>
                      store.setCredentialValue(event.target.value)
                    }
                  />
                  {credentialStatus === 'present' ? (
                    <Button
                      type="button"
                      size="icon-lg"
                      variant="outline"
                      aria-label="删除已保存的 API 密钥"
                      onClick={() =>
                        store.setDeleteCredentialOpen(true)
                      }
                    >
                      <KeyRound aria-hidden="true" />
                    </Button>
                  ) : null}
                </div>
              </label>

              <label className="flex min-h-11 items-center gap-3 rounded-lg border px-3.5 py-2.5 text-sm">
                <Checkbox
                  checked={store.selectedProfile.imageInput === 'enabled'}
                  onCheckedChange={(checked) =>
                    store.updateSelectedProfile({
                      imageInput: checked === true ? 'enabled' : 'auto',
                    })
                  }
                />
                <span>支持图像理解（视觉）</span>
              </label>

              <details className="rounded-lg border px-3.5 py-2.5 text-sm">
                <summary className="cursor-pointer select-none text-secondary">
                  上下文压缩
                </summary>
                <div className="mt-3 grid gap-3 sm:grid-cols-2">
                  <label className="grid gap-1">
                    <span className="text-secondary">上下文窗口 Token 数</span>
                    <Input
                      type="number"
                      min={4096}
                      max={2097152}
                      value={store.selectedProfile.contextWindowTokens ?? ''}
                      placeholder={contextWindow === undefined
                        ? '未知模型必须填写'
                        : `自动：${contextWindow.toLocaleString()}`}
                      onChange={(event) =>
                        store.updateSelectedProfile({
                          contextWindowTokens: event.target.value
                            ? Number(event.target.value)
                            : undefined,
                        })
                      }
                    />
                  </label>
                  <label className="grid gap-1">
                    <span className="text-secondary">压缩触发 Token 数</span>
                    <Input
                      type="number"
                      min={4096}
                      max={2097152}
                      value={store.selectedProfile.compactThresholdTokens ?? ''}
                      placeholder={calculatedThreshold === undefined
                        ? '请先设置上下文窗口'
                        : `自动：${calculatedThreshold.toLocaleString()}`}
                      onChange={(event) =>
                        store.updateSelectedProfile({
                          compactThresholdTokens: event.target.value
                            ? Number(event.target.value)
                            : undefined,
                        })
                      }
                    />
                  </label>
                  <label className="grid gap-1">
                    <span className="text-secondary">自动压缩</span>
                    <Select
                      value={store.selectedProfile.autoCompaction ?? 'auto'}
                      onValueChange={(value) =>
                        store.updateSelectedProfile({
                          autoCompaction: value as 'auto' | 'enabled' | 'disabled',
                        })
                      }
                    >
                      <SelectTrigger><SelectValue /></SelectTrigger>
                      <SelectContent>
                        <SelectItem value="auto">自动</SelectItem>
                        <SelectItem value="enabled">启用</SelectItem>
                        <SelectItem value="disabled">停用</SelectItem>
                      </SelectContent>
                    </Select>
                  </label>
                  <label className="grid gap-1">
                    <span className="text-secondary">模型原生压缩</span>
                    <Select
                      value={store.selectedProfile.nativeCompaction ?? 'auto'}
                      onValueChange={(value) =>
                        store.updateSelectedProfile({
                          nativeCompaction: value as 'auto' | 'enabled' | 'disabled',
                        })
                      }
                    >
                      <SelectTrigger><SelectValue /></SelectTrigger>
                      <SelectContent>
                        <SelectItem value="auto">自动</SelectItem>
                        <SelectItem value="enabled">启用</SelectItem>
                        <SelectItem value="disabled">停用</SelectItem>
                      </SelectContent>
                    </Select>
                  </label>
                </div>
                <p className="mt-3 text-xs text-tertiary">
                  自动压缩需要明确的上下文窗口。压缩前，SugarCode
                  会为输出预留容量和 5% 的安全余量。
                </p>
              </details>

              <div className="flex flex-col gap-3 border-t pt-4 sm:flex-row sm:items-center">
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
                    store.notice ??
                    '更改会应用于新回合；正在进行的回合继续使用当前模型。'
                  )}
                </div>
                <div className="flex gap-2 sm:justify-end">
                  {props.showCloseAction ? (
                    <DialogClose asChild>
                      <Button
                        type="button"
                        variant="ghost"
                        disabled={store.busy}
                      >
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
              </div>
            </fieldset>
          </main>
        </div>
      </div>

      <AlertDialog
        open={store.deleteCredentialOpen}
        onOpenChange={store.setDeleteCredentialOpen}
      >
        <AlertDialogContent className="max-w-md p-5">
          <AlertDialogHeader>
            <AlertDialogTitle>删除已保存的 API 密钥？</AlertDialogTitle>
            <AlertDialogDescription>
              模型配置和接口地址会保留，正在进行的回合不会受到影响。
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter className="mt-5">
            <AlertDialogCancel asChild>
              <Button type="button" variant="outline">
                取消
              </Button>
            </AlertDialogCancel>
            <AlertDialogAction asChild>
              <Button
                type="button"
                variant="destructive"
                onClick={store.deleteCredential}
              >
                删除 API 密钥
              </Button>
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
};
