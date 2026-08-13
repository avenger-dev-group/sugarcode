import { useEffect, useState } from 'react';

import {
  type ModelConfigActionResult,
  type ModelConfigInspection,
  type ModelConfigValue,
  type ModelConnectionValue,
  type ModelProfileValue,
  type ModelWireApi,
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
  ProviderPreset,
} from './types';

export const PROVIDER_PRESETS: readonly ProviderPreset[] = [
  {
    providerFamily: 'openai',
    label: 'OpenAI Responses',
    baseUrl: 'https://api.openai.com/v1',
    wireApi: 'openaiResponses',
  },
  {
    providerFamily: 'anthropic',
    label: 'Anthropic',
    baseUrl: 'https://api.anthropic.com/v1',
    wireApi: 'anthropicMessages',
  },
  {
    providerFamily: 'openai',
    label: 'OpenAI-compatible',
    baseUrl: 'https://api.openai.com/v1',
    wireApi: 'openaiChatCompletions',
  },
];

const INITIAL_CONNECTION: ModelConnectionValue = {
  id: 'conn_openai',
  providerFamily: 'openai',
  displayName: 'OpenAI-compatible',
  baseUrl: 'https://api.openai.com/v1',
  enabled: true,
  wireApi: 'openaiChatCompletions',
  continuationMode: 'localReplay',
};

const INITIAL_PROFILE: ModelProfileValue = {
  id: 'model_primary',
  connectionId: INITIAL_CONNECTION.id,
  displayName: 'Work model',
  modelId: '',
  autoCompaction: 'auto',
  nativeCompaction: 'auto',
  toolCalls: 'auto',
  strictTools: 'auto',
  parallelTools: 'auto',
  imageInput: 'auto',
  pdfInput: 'auto',
};

const EMPTY_CONFIG: ModelConfigValue = {
  defaultProfileId: INITIAL_PROFILE.id,
  connections: [INITIAL_CONNECTION],
  profiles: [INITIAL_PROFILE],
};

const noticeFor = (result: ModelConfigActionResult): string => {
  if (result.state === 'saved') {
    return 'Saved. New turns will use the updated model configuration.';
  }
  if (result.reason === 'reconnectPending') {
    return 'Another local configuration or workspace change is in progress.';
  }
  if (result.reason === 'stale') {
    return 'Configuration changed elsewhere. Reopen Settings before saving.';
  }
  if (result.reason === 'invalid') {
    return 'Check the required fields before saving this configuration.';
  }
  return 'The model configuration could not be saved.';
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

const presetForWire = (wireApi: ModelWireApi): ProviderPreset =>
  PROVIDER_PRESETS.find(
    (preset) => preset.wireApi === wireApi,
  ) ?? PROVIDER_PRESETS[0];

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
          setNotice('The saved model configuration is unavailable.');
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
      setNotice('A model catalog can contain at most 16 connections.');
      return;
    }
    if (config.profiles.length >= 128) {
      setNotice('A model catalog can contain at most 128 profiles.');
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
      displayName: 'OpenAI-compatible',
    };
    const profile: ModelProfileValue = {
      ...INITIAL_PROFILE,
      id: profileId,
      connectionId,
      displayName: 'New configuration',
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
      setNotice('At least one model configuration is required.');
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
    setNotice('Configuration removed from this draft. Save to apply.');
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
      setNotice('Configuration name and model ID are required.');
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
        setNotice('The model configuration could not be saved.');
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
        setNotice('The API key could not be deleted.');
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
                baseUrl: preset.baseUrl,
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
    addConfiguration,
    deleteConfiguration,
    save,
    deleteCredential,
  };
};
