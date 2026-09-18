import type {
  ModelConfigInspection,
  ModelConfigValue,
  ModelConnectionValue,
  DiscoveredModel,
  ModelProfileValue,
  ModelWireApi,
} from '@/shared/model-config';

export type Phase =
  | 'idle'
  | 'loading'
  | 'saving'
  | 'deleting'
  | 'discovering';

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
  selectedConnectionId: string;
  notice: string | null;
  deleteCredentialOpen: boolean;
  credentialValue: string;
  discoveryCandidates: readonly DiscoveredModel[] | null;
  setSelectedConnectionId: (id: string) => void;
  setSelectedProfileId: (id: string) => void;
  setDeleteCredentialOpen: (open: boolean) => void;
  setCredentialValue: (value: string) => void;
  setDefaultProfile: (profileId?: string) => void;
  setProviderWire: (wireApi: ModelWireApi) => void;
  updateConnection: (patch: Partial<ModelConnectionValue>) => void;
  updateSelectedProfile: (patch: Partial<ModelProfileValue>) => void;
  updateProfile: (id: string, patch: Partial<ModelProfileValue>) => void;
  setImageAnalysisProfile: (profileId: string | undefined) => void;
  setVideoAnalysisProfile: (profileId: string | undefined) => void;
  setAudioAnalysisProfile: (profileId: string | undefined) => void;
  addProvider: () => void;
  deleteProvider: () => void;
  addModel: () => void;
  deleteModel: (id: string) => void;
  discoverProviderModels: () => void;
  closeDiscoveryCandidates: () => void;
  adoptDiscoveredModels: (modelIds: readonly string[]) => void;
  save: () => void;
  deleteCredential: () => void;
}>;
