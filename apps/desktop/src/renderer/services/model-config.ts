export const getModelConfig = () => window.sugarcode.getModelConfig();
export const saveModelConfig: typeof window.sugarcode.saveModelConfig = (
  request,
) => window.sugarcode.saveModelConfig(request);
export const deleteModelCredential: typeof window.sugarcode.deleteModelCredential =
  (expectedRevision) =>
    window.sugarcode.deleteModelCredential(expectedRevision);
export const retryModelConnection = () =>
  window.sugarcode.retryModelConnection();
