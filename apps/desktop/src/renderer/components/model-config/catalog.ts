import type {
  ModelConfigValue,
  ModelConnectionValue,
  ModelCredentialStatus,
} from '@/shared/model-config';

const normalizeBaseUrl = (baseUrl: string): string => {
  const trimmed = baseUrl.trim();
  try {
    const parsed = new URL(trimmed);
    parsed.hash = '';
    parsed.pathname = parsed.pathname.replace(/\/+$/u, '') || '/';
    return parsed.toString().replace(/\/$/u, '');
  } catch {
    return trimmed.replace(/\/+$/u, '');
  }
};

const editableConnection = (
  storedConnection: ModelConnectionValue,
): ModelConnectionValue => {
  const connection = {
    ...storedConnection,
  } as ModelConnectionValue & { requestTimeoutMs?: unknown };
  delete connection.requestTimeoutMs;
  return connection;
};

/**
 * Fold legacy one-model-per-connection catalogs into provider connections.
 * A URL alone is not enough to merge safely because one gateway can expose
 * multiple wire protocols at the same address.
 */
export const consolidateProviderConnections = (
  config: ModelConfigValue,
  credentialStatuses: readonly ModelCredentialStatus[] = [],
): ModelConfigValue => {
  const connections = config.connections.map(editableConnection);
  const credentialById = new Map(
    credentialStatuses.map((credential) => [
      credential.connectionId,
      credential.status,
    ]),
  );
  const groups = new Map<string, ModelConnectionValue[]>();
  for (const connection of connections) {
    const key = `${connection.wireApi}\u0000${normalizeBaseUrl(connection.baseUrl)}`;
    const group = groups.get(key);
    if (group) group.push(connection);
    else groups.set(key, [connection]);
  }

  const connectionIdMap = new Map<string, string>();
  const consolidatedConnections: ModelConnectionValue[] = [];
  for (const group of groups.values()) {
    const representative =
      group.find(
        (connection) => credentialById.get(connection.id) === 'present',
      ) ?? group[0];
    if (!representative) continue;
    consolidatedConnections.push({
      ...representative,
      enabled: group.some((connection) => connection.enabled),
    });
    for (const connection of group) {
      connectionIdMap.set(connection.id, representative.id);
    }
  }

  return {
    ...config,
    connections: consolidatedConnections,
    profiles: config.profiles.map((profile) => ({
      ...profile,
      connectionId:
        connectionIdMap.get(profile.connectionId) ?? profile.connectionId,
    })),
  };
};
