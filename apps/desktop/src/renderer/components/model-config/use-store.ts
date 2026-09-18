import { useEffect, useState } from 'react';

import {
  type ModelConfigActionResult,
  type ModelConfigInspection,
  type ModelConfigValue,
  type ModelConnectionValue,
  type ModelProfileValue,
  type DiscoveredModel,
} from '@/shared/model-config';
import {
  deleteModelApiKey,
  discoverModels,
  getModelConfig,
  saveModelConfig,
} from '@/renderer/services/model-config';

import type {
  ModelConfigSettingsPanelProps,
  ModelConfigStore,
  Phase,
} from './types';
import {
  baseUrlForProviderWireChange,
  DEFAULT_NEW_MODEL_WIRE_API,
  PROVIDER_PRESETS,
  presetForWire,
} from './provider-presets';
import { consolidateProviderConnections } from './catalog';

const INITIAL_CONNECTION: ModelConnectionValue = {
  id: 'conn_openai',
  providerFamily: 'openai',
  displayName: 'OpenAI 兼容接口',
  baseUrl: 'https://api.openai.com/v1',
  enabled: true,
  wireApi: DEFAULT_NEW_MODEL_WIRE_API,
  continuationMode: 'localReplay',
};

const INITIAL_PROFILE: ModelProfileValue = {
  id: 'model_primary',
  connectionId: INITIAL_CONNECTION.id,
  displayName: '工作模型',
  modelId: '',
  autoCompaction: 'auto',
  nativeCompaction: 'auto',
  reasoningEffort: 'auto',
  serviceTier: 'auto',
  toolCalls: 'auto',
  strictTools: 'auto',
  parallelTools: 'auto',
  imageInput: 'auto',
  videoInput: 'auto',
  audioInput: 'auto',
  pdfInput: 'auto',
};

const EMPTY_CONFIG: ModelConfigValue = {
  defaultProfileId: INITIAL_PROFILE.id,
  connections: [INITIAL_CONNECTION],
  profiles: [INITIAL_PROFILE],
};

const noticeFor = (result: ModelConfigActionResult): string => {
  if (result.state === 'saved') {
    return '已保存。新回合将使用更新后的模型配置。';
  }
  if (result.reason === 'reconnectPending') {
    return '另一项本地配置或工作区更改正在进行中。';
  }
  if (result.reason === 'stale') {
    return '配置已在其他位置发生变化，请重新打开设置后再保存。';
  }
  if (result.reason === 'invalid') {
    return '请检查必填项后再保存此配置。';
  }
  return '无法保存模型配置。';
};

const uniqueId = (prefix: string, existing: readonly string[]): string => {
  for (let index = 1; index <= existing.length + 1; index += 1) {
    const candidate = `${prefix}_${index}`;
    if (!existing.includes(candidate)) {
      return candidate;
    }
  }
  return `${prefix}_${existing.length + 2}`;
};

export const useStore = ({
  active = true,
}: ModelConfigSettingsPanelProps): ModelConfigStore => {
  const [phase, setPhase] = useState<Phase>('idle');
  const [inspection, setInspection] =
    useState<ModelConfigInspection | null>(null);
  const [config, setConfig] = useState<ModelConfigValue>(EMPTY_CONFIG);
  const [selectedProfileId, setSelectedProfileId] = useState<string>(
    INITIAL_PROFILE.id,
  );
  const [selectedConnectionId, setSelectedConnectionId] = useState<string>(
    INITIAL_CONNECTION.id,
  );
  const [notice, setNotice] = useState<string | null>(null);
  const [credentialDrafts, setCredentialDrafts] = useState<
    Readonly<Record<string, string>>
  >({});
  const [deleteCredentialOpen, setDeleteCredentialOpen] =
    useState<boolean>(false);
  const [discoveryCandidates, setDiscoveryCandidates] = useState<
    readonly DiscoveredModel[] | null
  >(null);

  useEffect(() => {
    if (!active) {
      setCredentialDrafts({});
      setDiscoveryCandidates(null);
      return;
    }
    let current = true;
    setPhase('loading');
    setNotice(null);
    setDiscoveryCandidates(null);
    void getModelConfig()
      .then((next) => {
        if (!current) {
          return;
        }
        const nextConfig = next.config
          ? consolidateProviderConnections(
              next.config,
              next.credentialStatuses,
            )
          : EMPTY_CONFIG;
        setInspection(next);
        setConfig(nextConfig);
        setSelectedProfileId(nextConfig.defaultProfileId);
        setSelectedConnectionId(
          nextConfig.profiles.find(
            (profile) => profile.id === nextConfig.defaultProfileId,
          )?.connectionId ?? nextConfig.connections[0]?.id ?? INITIAL_CONNECTION.id,
        );
        setPhase('idle');
      })
      .catch(() => {
        if (current) {
          setNotice('无法读取已保存的模型配置。');
          setPhase('idle');
        }
      });
    return () => {
      current = false;
    };
  }, [active]);

  const selectedProfile =
    config.profiles.find((profile) => profile.id === selectedProfileId) ??
    config.profiles[0] ??
    INITIAL_PROFILE;
  const selectedConnection =
    config.connections.find(
      (connection) => connection.id === selectedConnectionId,
    ) ?? config.connections[0] ?? INITIAL_CONNECTION;
  const credentialValue = credentialDrafts[selectedConnection.id] ?? '';

  const updateConfig = (
    updater: (current: ModelConfigValue) => ModelConfigValue,
  ): void => setConfig((current) => updater(current));

  const updateConnection = (
    patch: Partial<ModelConnectionValue>,
  ): void => {
    updateConfig((current) => ({
      ...current,
      connections: current.connections.map((connection) =>
        connection.id === selectedConnection.id
          ? { ...connection, ...patch }
          : connection,
      ),
    }));
  };

  const updateSelectedProfile = (
    patch: Partial<ModelProfileValue>,
  ): void => {
    updateConfig((current) => ({
      ...current,
      profiles: current.profiles.map((profile) =>
        profile.id === selectedProfile.id
          ? { ...profile, ...patch }
          : profile,
      ),
    }));
  };

  const updateProfile = (
    id: string,
    patch: Partial<ModelProfileValue>,
  ): void => {
    updateConfig((current) => ({
      ...current,
      profiles: current.profiles.map((profile) =>
        profile.id === id ? { ...profile, ...patch } : profile,
      ),
    }));
  };

  const addProvider = (): void => {
    if (config.connections.length >= 16) {
      setNotice('模型目录最多可包含 16 个连接。');
      return;
    }
    if (config.profiles.length >= 128) {
      setNotice('模型目录最多可包含 128 个配置。');
      return;
    }
    const connectionId = uniqueId(
      'conn',
      config.connections.map((connection) => connection.id),
    );
    const profileId = uniqueId(
      'model',
      config.profiles.map((profile) => profile.id),
    );
    const connection: ModelConnectionValue = {
      ...INITIAL_CONNECTION,
      id: connectionId,
      displayName: 'OpenAI 兼容接口',
    };
    const profile: ModelProfileValue = {
      ...INITIAL_PROFILE,
      id: profileId,
      connectionId,
      displayName: '新配置',
    };
    updateConfig((current) => ({
      ...current,
      connections: [...current.connections, connection],
      profiles: [...current.profiles, profile],
    }));
    setSelectedProfileId(profileId);
    setSelectedConnectionId(connectionId);
    setNotice(null);
  };

  const deleteProvider = (): void => {
    if (config.connections.length === 1) {
      setNotice('至少需要保留一个模型提供商。');
      return;
    }
    const removedProfileIds = new Set(
      config.profiles
        .filter((profile) => profile.connectionId === selectedConnection.id)
        .map((profile) => profile.id),
    );
    const nextConnection = config.connections.find(
      (connection) => connection.id !== selectedConnection.id,
    ) ?? INITIAL_CONNECTION;
    const nextProfile = config.profiles.find(
      (profile) => profile.connectionId === nextConnection.id,
    ) ?? INITIAL_PROFILE;
    updateConfig((current) => ({
      ...current,
      mediaRouting: current.mediaRouting
        ? {
            ...current.mediaRouting,
            ...(current.mediaRouting.imageProfileId &&
            removedProfileIds.has(current.mediaRouting.imageProfileId)
              ? { imageProfileId: undefined }
              : {}),
            ...(current.mediaRouting.videoProfileId &&
            removedProfileIds.has(current.mediaRouting.videoProfileId)
              ? { videoProfileId: undefined }
              : {}),
            ...(current.mediaRouting.audioProfileId &&
            removedProfileIds.has(current.mediaRouting.audioProfileId)
              ? { audioProfileId: undefined }
              : {}),
          }
        : undefined,
      defaultProfileId: removedProfileIds.has(current.defaultProfileId)
        ? nextProfile.id
        : current.defaultProfileId,
      profiles: current.profiles.filter(
        (profile) => !removedProfileIds.has(profile.id),
      ),
      connections: current.connections.filter(
        (connection) => connection.id !== selectedConnection.id,
      ),
    }));
    setSelectedProfileId(nextProfile.id);
    setSelectedConnectionId(nextConnection.id);
    setCredentialDrafts((current) => {
      const next = { ...current };
      delete next[selectedConnection.id];
      return next;
    });
    setNotice('已从草稿中移除该提供商及其模型，保存后生效。');
  };

  const addModel = (): void => {
    if (config.profiles.length >= 128) {
      setNotice('模型目录最多可包含 128 个模型。');
      return;
    }
    const profileId = uniqueId(
      'model',
      config.profiles.map((profile) => profile.id),
    );
    const profile: ModelProfileValue = {
      ...INITIAL_PROFILE,
      id: profileId,
      connectionId: selectedConnection.id,
      displayName: '新模型',
    };
    updateConfig((current) => ({
      ...current,
      profiles: [...current.profiles, profile],
    }));
    setSelectedProfileId(profileId);
    setNotice(null);
  };

  const deleteModel = (id: string): void => {
    const providerProfiles = config.profiles.filter(
      (profile) => profile.connectionId === selectedConnection.id,
    );
    if (providerProfiles.length === 1 || config.profiles.length === 1) {
      setNotice('每个提供商至少需要保留一个模型。');
      return;
    }
    const nextProfile = providerProfiles.find((profile) => profile.id !== id) ??
      config.profiles.find((profile) => profile.id !== id) ?? INITIAL_PROFILE;
    updateConfig((current) => ({
      ...current,
      defaultProfileId:
        current.defaultProfileId === id ? nextProfile.id : current.defaultProfileId,
      mediaRouting: current.mediaRouting
        ? {
            ...current.mediaRouting,
            ...(current.mediaRouting.imageProfileId === id
              ? { imageProfileId: undefined }
              : {}),
            ...(current.mediaRouting.videoProfileId === id
              ? { videoProfileId: undefined }
              : {}),
            ...(current.mediaRouting.audioProfileId === id
              ? { audioProfileId: undefined }
              : {}),
          }
        : undefined,
      profiles: current.profiles.filter((profile) => profile.id !== id),
    }));
    if (selectedProfileId === id) setSelectedProfileId(nextProfile.id);
    setNotice('已从草稿中移除该模型，保存后生效。');
  };

  const discoveredProfile = (
    current: ModelConfigValue,
    model: DiscoveredModel,
  ): ModelProfileValue => ({
    ...INITIAL_PROFILE,
    id: uniqueId('model', current.profiles.map((profile) => profile.id)),
    connectionId: selectedConnection.id,
    displayName: model.displayName || model.modelId,
    modelId: model.modelId,
    ...(model.contextWindowTokens === undefined
      ? {}
      : { contextWindowTokens: model.contextWindowTokens }),
  });

  const discoverProviderModels = (): void => {
    if (phase !== 'idle') return;
    if (!selectedConnection.baseUrl.trim()) {
      setNotice('请先填写提供商的基础 URL。');
      return;
    }
    setPhase('discovering');
    setNotice(null);
    void discoverModels({
      connection: selectedConnection,
      ...(credentialValue.trim() ? { apiKey: credentialValue } : {}),
    })
      .then((result) => {
        setDiscoveryCandidates(
          result.models.length > 0 ? result.models : null,
        );
        setNotice(
          result.models.length > 0
            ? `发现 ${result.models.length} 个模型，请选择要添加的项目。`
            : '该提供商没有返回可用模型。',
        );
        setPhase('idle');
      })
      .catch(() => {
        setNotice('无法从该提供商获取模型，请检查地址、协议和 API 密钥。');
        setPhase('idle');
      });
  };

  const adoptDiscoveredModels = (modelIds: readonly string[]): void => {
    if (!discoveryCandidates) return;
    const picked = new Set(modelIds);
    const known = new Set(
      config.profiles
        .filter((profile) => profile.connectionId === selectedConnection.id)
        .map((profile) => profile.modelId),
    );
    const additions: ModelProfileValue[] = [];
    for (const model of discoveryCandidates) {
      if (
        !picked.has(model.modelId) ||
        known.has(model.modelId) ||
        config.profiles.length + additions.length >= 128
      ) {
        continue;
      }
      const profile = discoveredProfile(
        { ...config, profiles: [...config.profiles, ...additions] },
        model,
      );
      additions.push(profile);
      known.add(model.modelId);
    }
    if (additions.length > 0) {
      const blankIds = new Set(
        config.profiles
          .filter(
            (profile) =>
              profile.connectionId === selectedConnection.id &&
              profile.modelId.trim().length === 0,
          )
          .map((profile) => profile.id),
      );
      updateConfig(() => ({
        ...config,
        defaultProfileId: blankIds.has(config.defaultProfileId)
          ? (additions[0]?.id ?? config.defaultProfileId)
          : config.defaultProfileId,
        profiles: [
          ...config.profiles.filter((profile) => !blankIds.has(profile.id)),
          ...additions,
        ],
      }));
      const firstAddedId = additions[0]?.id;
      if (firstAddedId) setSelectedProfileId(firstAddedId);
    }
    setDiscoveryCandidates(null);
    setNotice(
      additions.length > 0
        ? `已添加 ${additions.length} 个模型；已有同名模型保持不变。`
        : '没有添加新的模型。',
    );
  };

  const applyResult = (result: ModelConfigActionResult): void => {
    if (result.inspection) {
      const nextConfig = result.inspection.config
        ? consolidateProviderConnections(
            result.inspection.config,
            result.inspection.credentialStatuses,
          )
        : EMPTY_CONFIG;
      setInspection(result.inspection);
      setConfig(nextConfig);
      setSelectedProfileId((current) =>
        nextConfig.profiles.some((profile) => profile.id === current)
          ? current
          : nextConfig.defaultProfileId,
      );
      setSelectedConnectionId((current) =>
        nextConfig.connections.some((connection) => connection.id === current)
          ? current
          : nextConfig.profiles.find(
              (profile) => profile.id === nextConfig.defaultProfileId,
            )?.connectionId ??
              nextConfig.connections[0]?.id ??
              INITIAL_CONNECTION.id,
      );
    }
    setCredentialDrafts({});
    setNotice(noticeFor(result));
    setPhase('idle');
  };

  const save = (): void => {
    if (!inspection || phase !== 'idle') {
      return;
    }
    if (
      config.profiles.some(
        (profile) =>
          profile.displayName.trim().length === 0 ||
          profile.modelId.trim().length === 0,
      )
    ) {
      setNotice('配置名称和模型 ID 为必填项。');
      return;
    }
    const savedConfig: ModelConfigValue = config;
    setPhase('saving');
    setNotice(null);
    void saveModelConfig({
      expectedRevision: inspection.revision,
      config: savedConfig,
      credentialUpdates: savedConfig.connections.map((connection) => {
        const draft = credentialDrafts[connection.id];
        return draft
          ? {
              action: 'set' as const,
              connectionId: connection.id,
              value: draft,
            }
          : {
              action: 'preserve' as const,
              connectionId: connection.id,
            };
      }),
    })
      .then(applyResult)
      .catch(() => {
        setNotice('无法保存模型配置。');
        setPhase('idle');
      });
  };

  const deleteCredential = (): void => {
    if (!inspection || phase !== 'idle') {
      return;
    }
    setDeleteCredentialOpen(false);
    setPhase('deleting');
    setNotice(null);
    void deleteModelApiKey(
      selectedConnection.id,
      inspection.revision,
    )
      .then(applyResult)
      .catch(() => {
        setNotice('无法删除 API 密钥。');
        setPhase('idle');
      });
  };

  return {
    phase,
    busy: phase !== 'idle',
    inspection,
    config,
    selectedProfile,
    selectedProfileId,
    selectedConnection,
    selectedConnectionId: selectedConnection.id,
    notice,
    deleteCredentialOpen,
    credentialValue,
    discoveryCandidates,
    setSelectedConnectionId: (id) => {
      const profile = config.profiles.find(
        (candidate) => candidate.connectionId === id,
      );
      setSelectedConnectionId(id);
      if (profile) setSelectedProfileId(profile.id);
      setNotice(null);
    },
    setSelectedProfileId: (id) => {
      setSelectedProfileId(id);
      const profile = config.profiles.find((candidate) => candidate.id === id);
      if (profile) setSelectedConnectionId(profile.connectionId);
      setNotice(null);
    },
    setDeleteCredentialOpen,
    setCredentialValue: (value) =>
      setCredentialDrafts((current) => ({
        ...current,
        [selectedConnection.id]: value,
      })),
    setDefaultProfile: (profileId) =>
      updateConfig((current) => ({
        ...current,
        defaultProfileId: profileId ?? selectedProfile.id,
      })),
    setProviderWire: (wireApi) => {
      const preset = presetForWire(wireApi);
      updateConfig((current) => ({
        ...current,
        connections: current.connections.map((connection) =>
          connection.id === selectedConnection.id
            ? {
                ...connection,
                providerFamily: preset.providerFamily,
                displayName: PROVIDER_PRESETS.some(
                  (candidate) => candidate.label === connection.displayName,
                )
                  ? preset.label
                  : connection.displayName,
                baseUrl: baseUrlForProviderWireChange(
                  connection.wireApi,
                  connection.baseUrl,
                  preset.wireApi,
                ),
                wireApi: preset.wireApi,
                continuationMode: 'localReplay',
              }
            : connection,
        ),
        profiles: current.profiles.map((profile) => {
          if (profile.connectionId !== selectedConnection.id) {
            return profile;
          }
          return {
            ...profile,
            ...(preset.wireApi === 'openaiChatCompletions' &&
            profile.pdfInput === 'enabled'
              ? { pdfInput: 'auto' as const }
              : {}),
            ...(preset.providerFamily === 'anthropic' &&
            ['none', 'minimal', 'xhigh'].includes(
              profile.reasoningEffort ?? 'auto',
            )
              ? { reasoningEffort: 'auto' as const }
              : {}),
          };
        }),
      }));
      if (preset.wireApi === 'openaiChatCompletions') {
        setNotice(
          'Compatible Chat selected. PDF input uses the safe compatibility default.',
        );
      }
    },
    updateConnection,
    updateSelectedProfile,
    updateProfile,
    setImageAnalysisProfile: (profileId) =>
      updateConfig((current) => ({
        ...current,
        mediaRouting: {
          ...current.mediaRouting,
          imageProfileId: profileId,
        },
      })),
    setVideoAnalysisProfile: (profileId) =>
      updateConfig((current) => ({
        ...current,
        mediaRouting: {
          ...current.mediaRouting,
          videoProfileId: profileId,
        },
      })),
    setAudioAnalysisProfile: (profileId) =>
      updateConfig((current) => ({
        ...current,
        mediaRouting: {
          ...current.mediaRouting,
          audioProfileId: profileId,
        },
      })),
    addProvider,
    deleteProvider,
    addModel,
    deleteModel,
    discoverProviderModels,
    closeDiscoveryCandidates: () => setDiscoveryCandidates(null),
    adoptDiscoveredModels,
    save,
    deleteCredential,
  };
};
