import {
  ChevronRight,
  KeyRound,
  Plus,
  RefreshCw,
  Server,
  Star,
  Trash2,
} from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';

import { Button } from '@/renderer/components/ui/button';
import { Checkbox } from '@/renderer/components/ui/checkbox';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from '@/renderer/components/ui/dialog';
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

import { PROVIDER_PRESETS } from './provider-presets';
import type { ModelConfigStore } from './types';

type ModelProfileSettingsProps = Readonly<{
  store: ModelConfigStore;
}>;

const capabilityOptions = [
  { value: 'auto', label: '自动检测' },
  { value: 'enabled', label: '明确支持' },
  { value: 'disabled', label: '不支持' },
] as const;

const DiscoveryCandidatesDialog = ({
  store,
}: ModelProfileSettingsProps) => {
  const candidates = store.discoveryCandidates;
  const [query, setQuery] = useState('');
  const [picked, setPicked] = useState<ReadonlySet<string>>(new Set());
  const configured = useMemo(
    () =>
      new Set(
        store.config.profiles
          .filter(
            (profile) =>
              profile.connectionId === store.selectedConnection.id,
          )
          .map((profile) => profile.modelId),
      ),
    [store.config.profiles, store.selectedConnection.id],
  );

  useEffect(() => {
    setQuery('');
    setPicked(
      new Set(
        (candidates ?? [])
          .filter((candidate) => !configured.has(candidate.modelId))
          .map((candidate) => candidate.modelId),
      ),
    );
  }, [candidates, configured]);

  const normalizedQuery = query.trim().toLowerCase();
  const visible = (candidates ?? []).filter(
    (candidate) =>
      normalizedQuery.length === 0 ||
      candidate.modelId.toLowerCase().includes(normalizedQuery) ||
      candidate.displayName.toLowerCase().includes(normalizedQuery),
  );
  const selectableVisible = visible.filter(
    (candidate) => !configured.has(candidate.modelId),
  );
  const allVisiblePicked =
    selectableVisible.length > 0 &&
    selectableVisible.every((candidate) => picked.has(candidate.modelId));
  const toggle = (modelId: string): void => {
    setPicked((current) => {
      const next = new Set(current);
      if (!next.delete(modelId)) next.add(modelId);
      return next;
    });
  };
  const toggleVisible = (): void => {
    setPicked((current) => {
      const next = new Set(current);
      if (allVisiblePicked) {
        for (const candidate of selectableVisible) next.delete(candidate.modelId);
      } else {
        for (const candidate of selectableVisible) next.add(candidate.modelId);
      }
      return next;
    });
  };

  return (
    <Dialog
      open={candidates !== null}
      onOpenChange={(open) => {
        if (!open) store.closeDiscoveryCandidates();
      }}
    >
      <DialogContent className="max-w-xl">
        <div className="border-b px-5 py-4">
          <DialogTitle className="text-base font-semibold text-primary">
            选择要添加的模型
          </DialogTitle>
          <DialogDescription className="mt-1 text-sm text-secondary">
            已从 {store.selectedConnection.displayName} 获取 {candidates?.length ?? 0} 个模型。已配置的模型不会被覆盖。
          </DialogDescription>
        </div>
        <div className="flex min-h-0 flex-1 flex-col px-5 py-4">
          <div className="mb-3 flex items-center gap-2">
            <Input
              type="search"
              value={query}
              placeholder="搜索模型 ID 或名称"
              aria-label="搜索可用模型"
              onChange={(event) => setQuery(event.target.value)}
            />
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="shrink-0"
              disabled={selectableVisible.length === 0}
              onClick={toggleVisible}
            >
              {allVisiblePicked ? '取消全选' : '全选当前结果'}
            </Button>
          </div>
          <div className="min-h-0 max-h-[22rem] overflow-y-auto rounded-xl border p-1">
            {visible.length === 0 ? (
              <p className="px-3 py-8 text-center text-sm text-tertiary">
                没有匹配的模型
              </p>
            ) : (
              visible.map((candidate) => {
                const alreadyConfigured = configured.has(candidate.modelId);
                return (
                  <label
                    key={candidate.modelId}
                    className={`flex items-center gap-3 rounded-lg px-3 py-2.5 ${
                      alreadyConfigured
                        ? 'cursor-default opacity-65'
                        : 'cursor-pointer hover:bg-surface-hover'
                    }`}
                  >
                    <Checkbox
                      checked={picked.has(candidate.modelId)}
                      disabled={alreadyConfigured}
                      onCheckedChange={() => toggle(candidate.modelId)}
                    />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-medium text-primary">
                        {candidate.displayName || candidate.modelId}
                      </span>
                      {candidate.displayName !== candidate.modelId ? (
                        <span className="block truncate text-xs text-tertiary">
                          {candidate.modelId}
                        </span>
                      ) : null}
                    </span>
                    {alreadyConfigured ? (
                      <span className="rounded-full bg-surface px-2 py-0.5 text-[11px] text-tertiary">
                        已配置
                      </span>
                    ) : null}
                  </label>
                );
              })
            )}
          </div>
        </div>
        <div className="flex items-center justify-between gap-3 border-t px-5 py-4">
          <span className="text-xs text-tertiary">已选择 {picked.size} 个模型</span>
          <div className="flex gap-2">
            <Button type="button" variant="outline" onClick={store.closeDiscoveryCandidates}>
              取消
            </Button>
            <Button
              type="button"
              disabled={picked.size === 0}
              onClick={() => store.adoptDiscoveredModels([...picked])}
            >
              添加所选模型
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
};

export const ModelProfileSettings = ({ store }: ModelProfileSettingsProps) => {
  const providerProfiles = store.config.profiles.filter(
    (profile) => profile.connectionId === store.selectedConnection.id,
  );
  const credentialStatus = store.inspection?.credentialStatuses.find(
    (credential) => credential.connectionId === store.selectedConnection.id,
  )?.status;
  const providerPreset = PROVIDER_PRESETS.find(
    (preset) => preset.wireApi === store.selectedConnection.wireApi,
  );
  const isDefault = store.config.defaultProfileId === store.selectedProfile.id;
  const contextWindow =
    store.selectedProfile.contextWindowTokens ??
    knownContextWindowTokens(
      store.selectedConnection.providerFamily,
      store.selectedProfile.modelId,
    );
  const calculatedThreshold =
    contextWindow === undefined
      ? undefined
      : Math.min(
          Math.floor(contextWindow * 0.85),
          contextWindow -
            DEFAULT_AGENT_MAX_OUTPUT_TOKENS -
            Math.max(4_096, Math.ceil(contextWindow * 0.05)),
        );

  return (
    <>
    <div className="grid min-h-0 flex-1 grid-rows-[auto_minmax(0,1fr)] md:grid-cols-[15.5rem_minmax(0,1fr)] md:grid-rows-1">
      <aside className="border-b bg-surface/35 p-3 md:border-r md:border-b-0">
        <div className="mb-2 flex items-center justify-between px-2">
          <span className="text-[11px] font-medium tracking-wide text-tertiary uppercase">
            提供商
          </span>
          <span className="rounded-full bg-surface px-2 py-0.5 text-[10px] text-tertiary">
            {store.config.connections.length}
          </span>
        </div>
        <div className="grid max-h-40 gap-1 overflow-y-auto md:max-h-none">
          {store.config.connections.map((connection) => {
            const profiles = store.config.profiles.filter(
              (profile) => profile.connectionId === connection.id,
            );
            const selected = connection.id === store.selectedConnectionId;
            const ready =
              connection.enabled &&
              profiles.some((profile) => profile.modelId.trim().length > 0);
            const preset = PROVIDER_PRESETS.find(
              (candidate) => candidate.wireApi === connection.wireApi,
            );
            return (
              <button
                key={connection.id}
                type="button"
                aria-current={selected ? 'true' : undefined}
                className={`group grid w-full grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-2 rounded-xl border px-3 py-3 text-left outline-none transition-[background-color,border-color,box-shadow] focus-visible:ring-2 focus-visible:ring-ring ${
                  selected
                    ? 'border-border-strong bg-background shadow-sm'
                    : 'border-transparent text-secondary hover:border-border hover:bg-surface-hover'
                }`}
                disabled={store.busy}
                onClick={() => store.setSelectedConnectionId(connection.id)}
              >
                <span
                  className={`size-2 rounded-full ${ready ? 'bg-success' : 'bg-border-strong'}`}
                  aria-label={ready ? '已配置' : '未完成'}
                />
                <span className="min-w-0">
                  <span className="block truncate text-sm font-medium text-primary">
                    {connection.displayName}
                  </span>
                  <span className="mt-0.5 block truncate text-[11px] text-tertiary">
                    {preset?.label ?? connection.providerFamily} · {profiles.length} 个模型
                  </span>
                </span>
                <ChevronRight
                  className={`size-3.5 text-tertiary transition-transform ${selected ? 'translate-x-0.5' : ''}`}
                  aria-hidden="true"
                />
              </button>
            );
          })}
        </div>
      </aside>

      <main className="min-h-0 overflow-y-auto bg-background">
        <fieldset
          className="grid gap-5 px-5 py-5 lg:px-7 lg:py-6"
          disabled={store.busy || !store.inspection}
        >
          <legend className="sr-only">当前模型提供商</legend>

          <div className="flex flex-wrap items-start justify-between gap-3 border-b pb-4">
            <div className="flex min-w-0 items-center gap-3">
              <span className="grid size-9 shrink-0 place-items-center rounded-xl border bg-surface text-secondary">
                <Server className="size-4" aria-hidden="true" />
              </span>
              <div className="min-w-0">
                <h3 className="truncate text-base font-semibold text-primary">
                  {store.selectedConnection.displayName}
                </h3>
                <p className="mt-0.5 text-xs text-tertiary">
                  一套连接信息，可供此提供商下的所有模型共用
                </p>
              </div>
            </div>
            <div className="flex items-center gap-1">
              {!store.selectedConnection.enabled ? (
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={() => store.updateConnection({ enabled: true })}
                >
                  启用
                </Button>
              ) : null}
              <Button
                type="button"
                size="icon-sm"
                variant="ghost"
                aria-label="删除提供商及其模型"
                onClick={store.deleteProvider}
              >
                <Trash2 aria-hidden="true" />
              </Button>
            </div>
          </div>

          <section aria-labelledby="provider-connection-heading">
            <div className="mb-3">
              <h4 id="provider-connection-heading" className="text-sm font-medium text-primary">
                连接设置
              </h4>
              <p className="mt-1 text-xs text-tertiary">
                修改这里会同时影响该提供商下的 {providerProfiles.length} 个模型。
              </p>
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              <label className="grid gap-1 text-sm">
                <span className="text-secondary">显示名称</span>
                <Input
                  value={store.selectedConnection.displayName}
                  placeholder="例如 Metis"
                  onChange={(event) =>
                    store.updateConnection({ displayName: event.target.value })
                  }
                />
              </label>
              <label className="grid gap-1 text-sm">
                <span className="text-secondary">API 协议</span>
                <Select
                  value={store.selectedConnection.wireApi}
                  onValueChange={(wireApi) =>
                    store.setProviderWire(
                      wireApi as typeof store.selectedConnection.wireApi,
                    )
                  }
                >
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {PROVIDER_PRESETS.map((preset) => (
                      <SelectItem key={preset.wireApi} value={preset.wireApi}>
                        {preset.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </label>
              <label className="grid gap-1 text-sm sm:col-span-2">
                <span className="text-secondary">基础 URL</span>
                <Input
                  value={store.selectedConnection.baseUrl}
                  inputMode="url"
                  spellCheck={false}
                  placeholder={providerPreset?.baseUrl}
                  onChange={(event) =>
                    store.updateConnection({ baseUrl: event.target.value })
                  }
                />
              </label>
              <label className="grid gap-1 text-sm sm:col-span-2">
                <span className="flex items-center gap-2 text-secondary">
                  <span>API 密钥</span>
                  {credentialStatus === 'present' ? (
                    <span className="inline-flex items-center gap-1 text-xs text-tertiary">
                      <span className="size-1.5 rounded-full bg-success" aria-hidden="true" />
                      已保存
                    </span>
                  ) : null}
                </span>
                <div className="flex gap-2">
                  <Input
                    type="password"
                    value={store.credentialValue}
                    autoComplete="new-password"
                    spellCheck={false}
                    placeholder={credentialStatus === 'present' ? '留空以保留已保存的密钥' : '输入 API 密钥'}
                    onChange={(event) => store.setCredentialValue(event.target.value)}
                  />
                  {credentialStatus === 'present' ? (
                    <Button
                      type="button"
                      size="icon-lg"
                      variant="outline"
                      aria-label="删除已保存的 API 密钥"
                      onClick={() => store.setDeleteCredentialOpen(true)}
                    >
                      <KeyRound aria-hidden="true" />
                    </Button>
                  ) : null}
                </div>
              </label>
            </div>
          </section>

          <section className="border-t pt-5" aria-labelledby="provider-models-heading">
            <div className="mb-3 flex flex-wrap items-start justify-between gap-3">
              <div>
                <h4 id="provider-models-heading" className="text-sm font-medium text-primary">
                  模型目录
                </h4>
                <p className="mt-1 text-xs text-tertiary">
                  获取服务端模型或手动添加；已有同名模型不会被覆盖。
                </p>
              </div>
              <div className="flex items-center gap-2">
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={store.discoverProviderModels}
                >
                  <RefreshCw
                    className={store.phase === 'discovering' ? 'animate-spin' : undefined}
                    aria-hidden="true"
                  />
                  {store.phase === 'discovering' ? '获取中' : '获取可用模型'}
                </Button>
                <Button type="button" size="sm" variant="outline" onClick={store.addModel}>
                  <Plus aria-hidden="true" />
                  添加模型
                </Button>
              </div>
            </div>

            <div className="grid gap-2">
              {providerProfiles.map((profile) => {
                const selected = profile.id === store.selectedProfileId;
                const profileIsDefault = store.config.defaultProfileId === profile.id;
                return (
                  <div
                    key={profile.id}
                    className={`rounded-xl border p-2 transition-colors ${
                      selected ? 'border-border-strong bg-surface/45' : 'bg-background'
                    }`}
                  >
                    <div className="grid items-center gap-2 sm:grid-cols-[minmax(8rem,0.9fr)_minmax(10rem,1.2fr)_auto]">
                      <Input
                        value={profile.displayName}
                        aria-label={`${profile.displayName || '模型'}的显示名称`}
                        placeholder="显示名称"
                        onFocus={() => store.setSelectedProfileId(profile.id)}
                        onChange={(event) =>
                          store.updateProfile(profile.id, { displayName: event.target.value })
                        }
                      />
                      <Input
                        value={profile.modelId}
                        aria-label={`${profile.displayName || '模型'}的模型 ID`}
                        placeholder="模型 ID"
                        spellCheck={false}
                        onFocus={() => store.setSelectedProfileId(profile.id)}
                        onChange={(event) =>
                          store.updateProfile(profile.id, { modelId: event.target.value })
                        }
                      />
                      <div className="flex justify-end gap-1">
                        <Button
                          type="button"
                          size="icon-sm"
                          variant="ghost"
                          aria-label={profileIsDefault ? '默认模型' : '设为默认模型'}
                          title={profileIsDefault ? '默认模型' : '设为默认模型'}
                          onClick={() => {
                            store.setSelectedProfileId(profile.id);
                            if (!profileIsDefault) store.setDefaultProfile(profile.id);
                          }}
                        >
                          <Star
                            className={profileIsDefault ? 'fill-current text-brand' : undefined}
                            aria-hidden="true"
                          />
                        </Button>
                        <Button
                          type="button"
                          size="icon-sm"
                          variant="ghost"
                          aria-label={`删除模型 ${profile.displayName}`}
                          onClick={() => store.deleteModel(profile.id)}
                        >
                          <Trash2 aria-hidden="true" />
                        </Button>
                        <Button
                          type="button"
                          size="icon-sm"
                          variant="ghost"
                          aria-label={`编辑模型 ${profile.displayName} 的高级设置`}
                          aria-expanded={selected}
                          onClick={() => store.setSelectedProfileId(profile.id)}
                        >
                          <ChevronRight
                            className={`transition-transform ${selected ? 'rotate-90' : ''}`}
                            aria-hidden="true"
                          />
                        </Button>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          </section>

          <section className="border-t pt-5" aria-labelledby="model-advanced-heading">
            <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
              <div>
                <h4 id="model-advanced-heading" className="text-sm font-medium text-primary">
                  {store.selectedProfile.displayName || '当前模型'}的能力设置
                </h4>
                <p className="mt-1 text-xs text-tertiary">仅应用于当前选中的模型。</p>
              </div>
              {isDefault ? (
                <span className="inline-flex items-center gap-1 rounded-full bg-surface px-2 py-1 text-xs text-primary">
                  <Star className="size-3 fill-current text-brand" aria-hidden="true" />
                  默认模型
                </span>
              ) : null}
            </div>

            <div className="grid gap-3 sm:grid-cols-3">
              {([
                ['imageInput', '图像输入'],
                ['videoInput', '原生视频输入'],
                ['audioInput', '音频输入'],
              ] as const).map(([capability, label]) => (
                <label key={capability} className="grid gap-1 text-sm">
                  <span className="text-secondary">{label}</span>
                  <Select
                    value={store.selectedProfile[capability] ?? 'auto'}
                    onValueChange={(value) =>
                      store.updateSelectedProfile({
                        [capability]: value as 'auto' | 'enabled' | 'disabled',
                      })
                    }
                  >
                    <SelectTrigger><SelectValue /></SelectTrigger>
                    <SelectContent>
                      {capabilityOptions.map((option) => (
                        <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </label>
              ))}
            </div>

            <div className="mt-3 grid gap-3 rounded-xl border p-3 sm:grid-cols-2">
              <label className="grid gap-1 text-sm">
                <span className="text-secondary">推理强度</span>
                <Select
                  value={store.selectedProfile.reasoningEffort ?? 'auto'}
                  onValueChange={(value) =>
                    store.updateSelectedProfile({
                      reasoningEffort: value as NonNullable<typeof store.selectedProfile.reasoningEffort>,
                    })
                  }
                >
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="auto">自动（不发送）</SelectItem>
                    {store.selectedConnection.providerFamily === 'openai' ? (
                      <><SelectItem value="none">None</SelectItem><SelectItem value="minimal">Minimal</SelectItem></>
                    ) : null}
                    <SelectItem value="low">Low</SelectItem>
                    <SelectItem value="medium">Medium</SelectItem>
                    <SelectItem value="high">High</SelectItem>
                    {store.selectedConnection.providerFamily === 'openai' ? <SelectItem value="xhigh">XHigh</SelectItem> : null}
                    <SelectItem value="max">Max</SelectItem>
                  </SelectContent>
                </Select>
              </label>
              <label className="grid gap-1 text-sm">
                <span className="text-secondary">服务速度</span>
                <Select
                  value={store.selectedProfile.serviceTier ?? 'auto'}
                  onValueChange={(value) =>
                    store.updateSelectedProfile({
                      serviceTier: value as NonNullable<typeof store.selectedProfile.serviceTier>,
                    })
                  }
                >
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="auto">自动（不发送）</SelectItem>
                    <SelectItem value="standard">标准</SelectItem>
                    <SelectItem value="fast">Fast</SelectItem>
                  </SelectContent>
                </Select>
              </label>
              <p className="text-xs text-tertiary sm:col-span-2">
                Fast 可能需要提供商单独开通并产生更高费用；失败时不会静默降级。
              </p>
            </div>

            <details className="mt-3 rounded-xl border px-3.5 py-2.5 text-sm">
              <summary className="cursor-pointer select-none text-secondary">上下文压缩</summary>
              <div className="mt-3 grid gap-3 sm:grid-cols-2">
                <label className="grid gap-1">
                  <span className="text-secondary">上下文窗口 Token 数</span>
                  <Input
                    type="number"
                    min={4096}
                    max={2097152}
                    value={store.selectedProfile.contextWindowTokens ?? ''}
                    placeholder={contextWindow === undefined ? '未知模型必须填写' : `自动：${contextWindow.toLocaleString()}`}
                    onChange={(event) =>
                      store.updateSelectedProfile({
                        contextWindowTokens: event.target.value ? Number(event.target.value) : undefined,
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
                    placeholder={calculatedThreshold === undefined ? '请先设置上下文窗口' : `自动：${calculatedThreshold.toLocaleString()}`}
                    onChange={(event) =>
                      store.updateSelectedProfile({
                        compactThresholdTokens: event.target.value ? Number(event.target.value) : undefined,
                      })
                    }
                  />
                </label>
                {([
                  ['autoCompaction', '自动压缩'],
                  ['nativeCompaction', '模型原生压缩'],
                ] as const).map(([capability, label]) => (
                  <label key={capability} className="grid gap-1">
                    <span className="text-secondary">{label}</span>
                    <Select
                      value={store.selectedProfile[capability] ?? 'auto'}
                      onValueChange={(value) =>
                        store.updateSelectedProfile({
                          [capability]: value as 'auto' | 'enabled' | 'disabled',
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
                ))}
              </div>
            </details>
          </section>
        </fieldset>
      </main>
    </div>
    <DiscoveryCandidatesDialog store={store} />
    </>
  );
};
