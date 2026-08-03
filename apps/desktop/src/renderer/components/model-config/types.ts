import type {
  ModelConfigInspection,
  ModelConfigValue,
  ModelConnectionValue,
  ModelProfileValue,
  ModelProviderFamily,
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
  selectedProfile: ModelProfileValue;
  selectedProfileId: string;
  selectedConnection: ModelConnectionValue;
  notice: string | null;
  deleteCredentialOpen: boolean;
  contextInputs: Readonly<Record<string, string>>;
  credentialValue: string;
  setSelectedProfileId: (id: string) => void;
  setDeleteCredentialOpen: (open: boolean) => void;
  setCredentialValue: (value: string) => void;
  setDefaultProfile: () => void;
  setProviderWire: (wireApi: ModelWireApi) => void;
  updateConnection: (patch: Partial<ModelConnectionValue>) => void;
  updateSelectedProfile: (patch: Partial<ModelProfileValue>) => void;
  setContextInput: (value: string) => void;
  addConfiguration: () => void;
  deleteConfiguration: () => void;
  save: () => void;
  deleteCredential: () => void;
}>;

export type ProviderPreset = Readonly<{
  providerFamily: ModelProviderFamily;
  label: string;
  baseUrl: string;
  wireApi: ModelWireApi;
}>;
