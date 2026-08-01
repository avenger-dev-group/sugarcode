export const MODEL_CONFIG_CHANGED_EVENT =
  'sugarcode:model-config-changed';

export const getModelConfig = () => window.sugarcode.getModelConfig();
export const saveModelConfig: typeof window.sugarcode.saveModelConfig = async (
  request,
) => {
  const result = await window.sugarcode.saveModelConfig(request);
  if (result.accepted) {
    window.dispatchEvent(new Event(MODEL_CONFIG_CHANGED_EVENT));
  }
  return result;
};
export const discoverModels: typeof window.sugarcode.discoverModels = (
  connectionId,
) => window.sugarcode.discoverModels(connectionId);
export const deleteModelApiKey: typeof window.sugarcode.deleteModelApiKey =
  async (connectionId, expectedRevision) => {
    const result = await window.sugarcode.deleteModelApiKey(
      connectionId,
      expectedRevision,
    );
    if (result.accepted) {
      window.dispatchEvent(new Event(MODEL_CONFIG_CHANGED_EVENT));
    }
    return result;
  };
