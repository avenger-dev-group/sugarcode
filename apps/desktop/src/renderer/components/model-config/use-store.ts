import { useEffect, useMemo, useState } from 'react';

import {
  type DiscoveredModel,
  type ModelConfigActionResult,
  type ModelConfigInspection,
  type ModelConfigValue,
  type ModelConnectionValue,
  type ModelProfileValue,
  type ModelProviderFamily,
  type ModelWireApi,
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
  ProviderPreset,
} from './types';

export const PROVIDER_PRESETS: readonly ProviderPreset[] = [
  {
    providerFamily: 'openai',
    label: 'OpenAI',
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
    providerFamily: 'gemini',
    label: 'Gemini',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
    wireApi: 'geminiGenerateContent',
  },
];

const INITIAL_CONNECTION: ModelConnectionValue = {
  id: 'conn_openai',
  providerFamily: 'openai',
  displayName: 'OpenAI',
  baseUrl: 'https://api.openai.com/v1',
  enabled: true,
  wireApi: 'openaiResponses',
  continuationMode: 'localReplay',
};

const INITIAL_PROFILE: ModelProfileValue = {
  id: 'model_primary',
  connectionId: INITIAL_CONNECTION.id,
  displayName: 'Primary coding model',
  modelId: '',
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
    return 'Saved. New Turns will use the updated model catalog.';
  }
  if (result.reason === 'reconnectPending') {
    return 'Another local configuration or workspace change is in progress.';
  }
  if (result.reason === 'stale') {
    return 'Configuration changed elsewhere. Reload before saving.';
  }
  if (result.reason === 'invalid') {
    return 'The model catalog was rejected by SugarCode validation.';
  }
  return 'The model catalog action could not be completed.';
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

const presetFor = (
  providerFamily: ModelProviderFamily,
): ProviderPreset =>
  PROVIDER_PRESETS.find(
    (preset) => preset.providerFamily === providerFamily,
  ) ??
  PROVIDER_PRESETS[0];

export const useStore = ({
  active = true,
}: ModelConfigSettingsPanelProps): ModelConfigStore => {
  const [phase, setPhase] = useState<Phase>('idle');
  const [inspection, setInspection] =
    useState<ModelConfigInspection | null>(null);
  const [config, setConfig] =
    useState<ModelConfigValue>(EMPTY_CONFIG);
  const [selectedConnectionId, setSelectedConnectionId] =
    useState<string>(INITIAL_CONNECTION.id);
  const [notice, setNotice] = useState<string | null>(null);
  const [credentialValue, setCredentialValue] = useState<string>('');
  const [deleteCredentialOpen, setDeleteCredentialOpen] =
    useState<boolean>(false);
  const [discoveredModels, setDiscoveredModels] = useState<
    DiscoveredModel[]
  >([]);
  const [discovering, setDiscovering] = useState<boolean>(false);
  const [contextInputs, setContextInputs] = useState<
    Record<string, string>
  >({ [INITIAL_PROFILE.id]: '' });

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
        setSelectedConnectionId(
          nextConfig.connections[0]?.id ?? INITIAL_CONNECTION.id,
        );
        setContextInputs(
          Object.fromEntries(
            nextConfig.profiles.map((profile) => [
              profile.id,
              profile.contextWindowTokens?.toString() ?? '',
            ]),
          ),
        );
        setPhase('idle');
      })
      .catch(() => {
        if (current) {
          setNotice('The saved model catalog is unavailable.');
          setPhase('idle');
        }
      });
    return () => {
      current = false;
    };
  }, [active]);

  const selectedConnection =
    config.connections.find(
      (connection) => connection.id === selectedConnectionId,
    ) ?? config.connections[0] ?? INITIAL_CONNECTION;
  const connectionProfiles = useMemo(
    () =>
      config.profiles.filter(
        (profile) => profile.connectionId === selectedConnection.id,
      ),
    [config.profiles, selectedConnection.id],
  );

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

  const setContextInput = (id: string, value: string): void => {
    setContextInputs((current) => ({ ...current, [id]: value }));
  };

  const addConnection = (): void => {
    if (config.connections.length >= 16) {
      setNotice('A model catalog can contain at most 16 connections.');
      return;
    }
    const id = uniqueId(
      'conn',
      config.connections.map((connection) => connection.id),
    );
    const connection: ModelConnectionValue = {
      id,
      providerFamily: 'openai',
      displayName: 'New connection',
      baseUrl: 'http://127.0.0.1:8000/v1',
      enabled: true,
      wireApi: 'openaiChatCompletions',
      continuationMode: 'localReplay',
    };
    updateConfig((current) => ({
      ...current,
      connections: [...current.connections, connection],
    }));
    setSelectedConnectionId(id);
    setCredentialValue('');
    setDiscoveredModels([]);
  };

  const deleteConnection = (): void => {
    if (connectionProfiles.length > 0) {
      setNotice('Delete this connection’s model profiles first.');
      return;
    }
    if (config.connections.length === 1) {
      setNotice('At least one connection is required.');
      return;
    }
    const connections = config.connections.filter(
      (connection) => connection.id !== selectedConnection.id,
    );
    updateConfig((current) => ({ ...current, connections }));
    setSelectedConnectionId(connections[0]?.id ?? '');
    setCredentialValue('');
    setDiscoveredModels([]);
  };

  const addProfile = (): void => {
    if (config.profiles.length >= 128) {
      setNotice('A model catalog can contain at most 128 profiles.');
      return;
    }
    const id = uniqueId(
      'model',
      config.profiles.map((profile) => profile.id),
    );
    const profile: ModelProfileValue = {
      id,
      connectionId: selectedConnection.id,
      displayName: 'New model',
      modelId: '',
      toolCalls: 'auto',
      strictTools: 'auto',
      parallelTools: 'auto',
      imageInput: 'auto',
      pdfInput: 'auto',
    };
    updateConfig((current) => ({
      ...current,
      profiles: [...current.profiles, profile],
      defaultProfileId:
        current.profiles.length === 0 ? id : current.defaultProfileId,
    }));
    setContextInput(id, '');
  };

  const addDiscoveredModel = (model: DiscoveredModel): void => {
    if (config.profiles.length >= 128) {
      setNotice('A model catalog can contain at most 128 profiles.');
      return;
    }
    if (
      config.profiles.some(
        (profile) =>
          profile.connectionId === selectedConnection.id &&
          profile.modelId === model.modelId,
      )
    ) {
      setNotice('That model is already in this connection.');
      return;
    }
    const id = uniqueId(
      'model',
      config.profiles.map((profile) => profile.id),
    );
    const profile: ModelProfileValue = {
      id,
      connectionId: selectedConnection.id,
      displayName: model.displayName,
      modelId: model.modelId,
      ...(model.contextWindowTokens
        ? { contextWindowTokens: model.contextWindowTokens }
        : {}),
      toolCalls: 'auto',
      strictTools: 'auto',
      parallelTools: 'auto',
      imageInput: 'auto',
      pdfInput: 'auto',
    };
    updateConfig((current) => ({
      ...current,
      profiles: [...current.profiles, profile],
    }));
    setContextInput(
      id,
      model.contextWindowTokens?.toString() ?? '',
    );
  };

  const deleteProfile = (id: string): void => {
    if (config.defaultProfileId === id) {
      setNotice('Choose another default model before deleting this profile.');
      return;
    }
    if (config.profiles.length === 1) {
      setNotice('At least one model profile is required.');
      return;
    }
    updateConfig((current) => ({
      ...current,
      profiles: current.profiles.filter((profile) => profile.id !== id),
    }));
  };

  const applyResult = (result: ModelConfigActionResult): void => {
    if (result.inspection) {
      setInspection(result.inspection);
      setConfig(result.inspection.config ?? EMPTY_CONFIG);
    }
    setCredentialValue('');
    setNotice(noticeFor(result));
    setPhase('idle');
  };

  const save = (): void => {
    if (!inspection || phase !== 'idle') {
      return;
    }
    const invalidContext = config.profiles.find((profile) => {
      const raw = contextInputs[profile.id]?.trim() ?? '';
      if (raw.length === 0) {
        return false;
      }
      const value = Number(raw);
      return (
        !Number.isInteger(value) ||
        value < 4_096 ||
        value > 2_097_152
      );
    });
    if (invalidContext) {
      setNotice(
        'Context window must be blank or an integer from 4,096 to 2,097,152.',
      );
      return;
    }
    const savedConfig: ModelConfigValue = {
      ...config,
      profiles: config.profiles.map((profile) => {
        const raw = contextInputs[profile.id]?.trim() ?? '';
        if (raw.length === 0) {
          const withoutContext = { ...profile };
          delete withoutContext.contextWindowTokens;
          return withoutContext;
        }
        return { ...profile, contextWindowTokens: Number(raw) };
      }),
    };
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
        setNotice('The model catalog could not be saved.');
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

  const canDiscover =
    storeConnectionSaved(inspection, selectedConnection.id) &&
    phase === 'idle';

  const refreshModels = (): void => {
    if (!canDiscover) {
      setNotice('Save this connection before refreshing models.');
      return;
    }
    setDiscovering(true);
    setNotice(null);
    void discoverModels(selectedConnection.id)
      .then((result) => {
        setDiscoveredModels([...result.models]);
        setNotice(
          result.models.length === 0
            ? 'The provider returned no model candidates.'
            : `Found ${result.models.length.toLocaleString()} model candidates.`,
        );
      })
      .catch(() => {
        setNotice(
          'Model discovery failed. You can still enter a model ID manually.',
        );
      })
      .finally(() => setDiscovering(false));
  };

  const changeProvider = (
    providerFamily: ModelProviderFamily,
  ): void => {
    const preset = presetFor(providerFamily);
    updateConnection({
      providerFamily,
      displayName: preset.label,
      baseUrl: preset.baseUrl,
      wireApi: preset.wireApi,
      continuationMode: 'localReplay',
    });
  };

  return {
    phase,
    busy: phase !== 'idle',
    inspection,
    config,
    selectedConnection,
    selectedConnectionId,
    connectionProfiles,
    notice,
    deleteCredentialOpen,
    contextInputs,
    credentialValue,
    discoveredModels,
    discovering,
    canDiscover,
    setSelectedConnectionId: (id) => {
      setSelectedConnectionId(id);
      setCredentialValue('');
      setDiscoveredModels([]);
    },
    setDeleteCredentialOpen,
    setCredentialValue,
    setDefaultProfileId: (id) =>
      updateConfig((current) => ({
        ...current,
        defaultProfileId: id,
      })),
    updateConnection: (patch) => {
      if (patch.providerFamily) {
        changeProvider(patch.providerFamily);
      } else {
        updateConnection(patch);
      }
    },
    updateProfile,
    setContextInput,
    addConnection,
    deleteConnection,
    addProfile,
    deleteProfile,
    save,
    deleteCredential,
    refreshModels,
    addDiscoveredModel,
  };
};

const storeConnectionSaved = (
  inspection: ModelConfigInspection | null,
  connectionId: string,
): boolean =>
  inspection?.config?.connections.some(
    (connection) => connection.id === connectionId,
  ) ?? false;

export const wireApiOptions = (
  providerFamily: ModelProviderFamily,
): readonly ModelWireApi[] => {
  if (providerFamily === 'openai') {
    return ['openaiResponses', 'openaiChatCompletions'];
  }
  return [presetFor(providerFamily).wireApi];
};
