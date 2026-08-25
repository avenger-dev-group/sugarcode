export type ContextTabKind =
  | 'files'
  | 'browser'
  | 'resource'
  | 'plan'
  | 'agent';

export type ContextTabInventory = Readonly<{
  files: boolean;
  browserCount: number;
  resource: boolean;
  plan: boolean;
  agent: boolean;
}>;

export const hasRemainingContextTabs = (
  inventory: ContextTabInventory,
  closing: ContextTabKind,
): boolean => {
  const total =
    Number(inventory.files) +
    inventory.browserCount +
    Number(inventory.resource) +
    Number(inventory.plan) +
    Number(inventory.agent);
  const closingExists =
    closing === 'files'
      ? inventory.files
      : closing === 'browser'
        ? inventory.browserCount > 0
        : closing === 'resource'
          ? inventory.resource
          : closing === 'plan'
            ? inventory.plan
            : inventory.agent;
  return total - Number(closingExists) > 0;
};
