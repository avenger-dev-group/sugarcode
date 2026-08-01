import type {
  DiscoveredModel,
  ModelConfigInspection,
  ModelConfigValue,
  ModelConnectionValue,
  ModelProfileValue,
  ModelProviderKind,
  ModelWireApi,
} from '@/shared/model-config';

export type Phase = 'idle' | 'loading' | 'saving' | 'deleting';

export type ModelConfigSettingsPanelProps = Readonly<{
  active?: boolean;
  showCloseAction?: boolean;
}>;

export type ModelConfigStore = Readonly<{
  phase: Phase;
  busy: boolean;
  inspection: ModelConfigInspection | null;
  config: ModelConfigValue;
  selectedConnection: ModelConnectionValue;
  selectedConnectionId: string;
  connectionProfiles: readonly ModelProfileValue[];
  notice: string | null;
  deleteCredentialOpen: boolean;
  contextInputs: Readonly<Record<string, string>>;
  credentialValue: string;
  discoveredModels: readonly DiscoveredModel[];
  discovering: boolean;
  canDiscover: boolean;
  setSelectedConnectionId: (id: string) => void;
  setDeleteCredentialOpen: (open: boolean) => void;
  setCredentialValue: (value: string) => void;
  setDefaultProfileId: (id: string) => void;
  updateConnection: (patch: Partial<ModelConnectionValue>) => void;
  updateProfile: (
    id: string,
    patch: Partial<ModelProfileValue>,
  ) => void;
  setContextInput: (id: string, value: string) => void;
  addConnection: () => void;
  deleteConnection: () => void;
  addProfile: () => void;
  deleteProfile: (id: string) => void;
  save: () => void;
  deleteCredential: () => void;
  refreshModels: () => void;
  addDiscoveredModel: (model: DiscoveredModel) => void;
}>;

export type ProviderPreset = Readonly<{
  kind: ModelProviderKind;
  label: string;
  baseUrl: string;
  wireApi: ModelWireApi;
}>;
