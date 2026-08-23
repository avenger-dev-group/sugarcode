import { useEffect, useState } from 'react';

import {
  type ModelConfigActionResult,
  type ModelConfigInspection,
  type ModelConfigValue,
  type ModelConnectionValue,
  type ModelProfileValue,
} from '@/shared/model-config';
import {
  deleteModelApiKey,
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
  presetForWire,
} from './provider-presets';

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
  const [notice, setNotice] = useState<string | null>(null);
  const [credentialValue, setCredentialValue] = useState<string>('');
  const [deleteCredentialOpen, setDeleteCredentialOpen] =
    useState<boolean>(false);

  useEffect(() => {
    if (!active) {
      setCredentialValue('');
      return;
    }
    let current = true;
    setPhase('loading');
    setNotice(null);
    void getModelConfig()
      .then((next) => {
        if (!current) {
          return;
        }
        const nextConfig = next.config ?? EMPTY_CONFIG;
        setInspection(next);
        setConfig(nextConfig);
        setSelectedProfileId(nextConfig.defaultProfileId);
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
      (connection) => connection.id === selectedProfile.connectionId,
    ) ?? config.connections[0] ?? INITIAL_CONNECTION;

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

  const addConfiguration = (): void => {
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
    setCredentialValue('');
    setNotice(null);
  };

  const deleteConfiguration = (): void => {
    if (config.profiles.length === 1) {
      setNotice('至少需要保留一个模型配置。');
      return;
    }
    const nextProfile =
      config.profiles.find((profile) => profile.id !== selectedProfile.id) ??
      config.profiles[0];
    const connectionIsShared = config.profiles.some(
      (profile) =>
        profile.id !== selectedProfile.id &&
        profile.connectionId === selectedConnection.id,
    );
    updateConfig((current) => ({
      ...current,
      ...(current.mediaRouting?.imageProfileId === selectedProfile.id ||
          current.mediaRouting?.videoProfileId === selectedProfile.id ||
          current.mediaRouting?.audioProfileId === selectedProfile.id
        ? {
            mediaRouting: {
              ...current.mediaRouting,
              ...(current.mediaRouting.imageProfileId === selectedProfile.id
                ? { imageProfileId: undefined }
                : {}),
              ...(current.mediaRouting.videoProfileId === selectedProfile.id
                ? { videoProfileId: undefined }
                : {}),
              ...(current.mediaRouting.audioProfileId === selectedProfile.id
                ? { audioProfileId: undefined }
                : {}),
            },
          }
        : {}),
      defaultProfileId:
        current.defaultProfileId === selectedProfile.id
          ? nextProfile.id
          : current.defaultProfileId,
      profiles: current.profiles.filter(
        (profile) => profile.id !== selectedProfile.id,
      ),
      connections: connectionIsShared
        ? current.connections
        : current.connections.filter(
            (connection) => connection.id !== selectedConnection.id,
          ),
    }));
    setSelectedProfileId(nextProfile.id);
    setCredentialValue('');
    setNotice('已从当前草稿中移除该配置，保存后生效。');
  };

  const applyResult = (result: ModelConfigActionResult): void => {
    if (result.inspection) {
      const nextConfig = result.inspection.config ?? EMPTY_CONFIG;
      setInspection(result.inspection);
      setConfig(nextConfig);
      setSelectedProfileId((current) =>
        nextConfig.profiles.some((profile) => profile.id === current)
          ? current
          : nextConfig.defaultProfileId,
      );
    }
    setCredentialValue('');
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
      credentialUpdates: savedConfig.connections.map((connection) =>
        connection.id === selectedConnection.id &&
        credentialValue.length > 0
          ? {
              action: 'set' as const,
              connectionId: connection.id,
              value: credentialValue,
            }
          : {
              action: 'preserve' as const,
              connectionId: connection.id,
            },
      ),
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
    notice,
    deleteCredentialOpen,
    credentialValue,
    setSelectedProfileId: (id) => {
      setSelectedProfileId(id);
      setCredentialValue('');
      setNotice(null);
    },
    setDeleteCredentialOpen,
    setCredentialValue,
    setDefaultProfile: () =>
      updateConfig((current) => ({
        ...current,
        defaultProfileId: selectedProfile.id,
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
                displayName: preset.label,
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
        profiles: current.profiles.map((profile) =>
          profile.connectionId === selectedConnection.id &&
          preset.wireApi === 'openaiChatCompletions' &&
          profile.pdfInput === 'enabled'
            ? { ...profile, pdfInput: 'auto' }
            : profile,
        ),
      }));
      if (preset.wireApi === 'openaiChatCompletions') {
        setNotice(
          'Compatible Chat selected. PDF input uses the safe compatibility default.',
        );
      }
    },
    updateConnection,
    updateSelectedProfile,
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
    addConfiguration,
    deleteConfiguration,
    save,
    deleteCredential,
  };
};
