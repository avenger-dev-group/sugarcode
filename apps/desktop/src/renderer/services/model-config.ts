export const getModelConfig = () => window.sugarcode.getModelConfig();
export const saveModelConfig: typeof window.sugarcode.saveModelConfig = (
  request,
) => window.sugarcode.saveModelConfig(request);
export const deleteModelApiKey: typeof window.sugarcode.deleteModelApiKey =
  (expectedRevision) =>
    window.sugarcode.deleteModelApiKey(expectedRevision);
