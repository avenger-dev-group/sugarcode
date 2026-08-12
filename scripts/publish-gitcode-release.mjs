import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

const token = process.env.GITCODE_TOKEN;
const version = process.env.RELEASE_VERSION;
const notes = process.env.RELEASE_NOTES ?? '';
const owner = process.env.GITCODE_OWNER ?? 'Simoonf';
const repository = process.env.GITCODE_REPOSITORY ?? 'SugarCode';
const assetsDirectory = path.resolve(
  process.env.RELEASE_ASSETS_DIR ?? 'release-assets',
);
const tag = `v${version}`;
const apiBase = `https://api.gitcode.com/api/v5/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repository)}`;
const retryableStatuses = new Set([408, 425, 429, 500, 502, 503, 504]);
const requestAttempts = 4;
const requestTimeoutMs = 180_000;

if (!token) throw new Error('GITCODE_TOKEN is required.');
if (!version) throw new Error('RELEASE_VERSION is required.');
if (!notes.trim()) throw new Error('RELEASE_NOTES is required.');

const apiUrl = (resource, parameters = {}) => {
  const url = new URL(`${apiBase}${resource}`);
  for (const [key, value] of Object.entries(parameters)) {
    url.searchParams.set(key, value);
  }
  return url;
};

const sleep = (duration) =>
  new Promise((resolve) => setTimeout(resolve, duration));

const errorMessage = (error) =>
  error instanceof Error ? error.message : String(error);

const fetchWithRetry = async (
  url,
  options,
  label,
  attempts = requestAttempts,
) => {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const response = await fetch(url, {
        ...options,
        signal: AbortSignal.timeout(requestTimeoutMs),
      });
      if (!retryableStatuses.has(response.status) || attempt === attempts) {
        return response;
      }
      await response.body?.cancel();
      lastError = new Error(`${label} returned ${response.status}.`);
    } catch (error) {
      lastError = error;
      if (attempt === attempts) break;
    }

    const delay = 2_000 * 2 ** (attempt - 1);
    console.warn(
      `${label} failed (attempt ${attempt}/${attempts}): ${errorMessage(lastError)} Retrying in ${delay / 1_000}s.`,
    );
    await sleep(delay);
  }
  throw new Error(`${label} failed after ${attempts} attempts.`, {
    cause: lastError,
  });
};

const jsonRequest = async (
  resource,
  {
    method = 'GET',
    parameters,
    body,
    allowed = [],
    retry = method !== 'POST',
  } = {},
) => {
  const response = await fetchWithRetry(
    apiUrl(resource, parameters),
    {
      method,
      headers: {
        Accept: 'application/json',
        'PRIVATE-TOKEN': token,
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    },
    `GitCode API ${method} ${resource}`,
    retry ? requestAttempts : 1,
  );
  if (!response.ok && !allowed.includes(response.status)) {
    const detail = await response.text();
    throw new Error(
      `GitCode API ${method} ${resource} failed (${response.status}): ${detail}`,
    );
  }
  if (allowed.includes(response.status)) {
    return { response, value: null };
  }
  return { response, value: await response.json() };
};

const uploadedAssetNames = (release) =>
  new Set((release?.assets ?? []).map((asset) => asset.name));

const releaseStatus = (release) => {
  if (release?.release_status) return release.release_status;
  if (release?.prerelease === true) return 'pre';
  if (release?.prerelease === false) return 'latest';
  return undefined;
};

const getRelease = async () =>
  (
    await jsonRequest(`/releases/tags/${encodeURIComponent(tag)}`, {
      allowed: [404],
    })
  ).value;

const waitForAsset = async (name, attempts = 3) => {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (attempt > 0) await sleep(2_000);
    const release = await getRelease();
    if (uploadedAssetNames(release).has(name)) return true;
  }
  return false;
};

const uploadAsset = async (name) => {
  let lastError;
  for (let attempt = 1; attempt <= requestAttempts; attempt += 1) {
    let mayRetry = true;
    try {
      const { value: upload } = await jsonRequest(
        `/releases/${encodeURIComponent(tag)}/upload_url`,
        { parameters: { file_name: name } },
      );
      if (!upload?.url || !upload?.headers) {
        throw new Error(`GitCode did not return an upload URL for ${name}.`);
      }
      const response = await fetchWithRetry(
        upload.url,
        {
          method: 'PUT',
          headers: upload.headers,
          body: await readFile(path.join(assetsDirectory, name)),
        },
        `Uploading ${name}`,
        1,
      );
      if (response.ok) {
        console.log(`Uploaded ${name}.`);
        return;
      }

      const detail = await response.text();
      lastError = new Error(
        `Uploading ${name} failed (${response.status}): ${detail}`,
      );
      mayRetry = retryableStatuses.has(response.status);
    } catch (error) {
      lastError = error;
    }

    if (await waitForAsset(name)) {
      console.warn(
        `Uploading ${name} returned an error, but GitCode lists the asset; continuing.`,
      );
      return;
    }
    if (!mayRetry) throw lastError;
    if (attempt === requestAttempts) break;

    const delay = 2_000 * 2 ** (attempt - 1);
    console.warn(
      `Uploading ${name} failed (attempt ${attempt}/${requestAttempts}): ${errorMessage(lastError)} Retrying with a new upload URL in ${delay / 1_000}s.`,
    );
    await sleep(delay);
  }
  throw new Error(`Uploading ${name} failed after ${requestAttempts} attempts.`, {
    cause: lastError,
  });
};

const assetNames = [
  `SugarCode-${version}-macos-arm64.dmg`,
  `SugarCode-${version}-macos-x64.dmg`,
  `SugarCode-${version}-windows-x64-Setup.exe`,
  'update-manifest.json',
];
const directoryNames = await readdir(assetsDirectory);
const publishableNames = directoryNames.filter(
  (name) =>
    name === 'update-manifest.json' ||
    name.endsWith('.dmg') ||
    name.endsWith('.exe'),
);
const missingLocalAssets = assetNames.filter(
  (name) => !publishableNames.includes(name),
);
const unexpectedLocalAssets = publishableNames.filter(
  (name) => !assetNames.includes(name),
);
if (missingLocalAssets.length > 0 || unexpectedLocalAssets.length > 0) {
  throw new Error(
    `Release assets do not match the expected files. Missing: ${missingLocalAssets.join(', ') || 'none'}. Unexpected: ${unexpectedLocalAssets.join(', ') || 'none'}.`,
  );
}
for (const name of assetNames) {
  const metadata = await stat(path.join(assetsDirectory, name));
  if (!metadata.isFile() || metadata.size === 0) {
    throw new Error(`Release asset is empty: ${name}`);
  }
}
const manifest = JSON.parse(
  await readFile(path.join(assetsDirectory, 'update-manifest.json'), 'utf8'),
);
if (manifest.version !== version) {
  throw new Error(
    `Update manifest version ${manifest.version ?? 'unknown'} does not match release version ${version}.`,
  );
}

let release = await getRelease();
if (!release) {
  try {
    release = (
      await jsonRequest('/releases', {
        method: 'POST',
        body: {
          tag_name: tag,
          name: `SugarCode ${tag}`,
          body: notes,
          release_status: 'pre',
        },
      })
    ).value;
  } catch (createError) {
    release = await getRelease();
    if (!release) throw createError;
    console.warn(
      `Release creation returned an error, but ${tag} now exists; resuming it.`,
    );
  }
}

const initialStatus = releaseStatus(release);
const initialMissingAssets = assetNames.filter(
  (name) => !uploadedAssetNames(release).has(name),
);
if (initialStatus === 'latest') {
  if (initialMissingAssets.length > 0) {
    throw new Error(
      `GitCode Release ${tag} is already latest but is missing assets: ${initialMissingAssets.join(', ')}`,
    );
  }
  console.log(`GitCode Release ${tag} is already published.`);
  process.exit(0);
}
if (initialStatus !== 'pre') {
  throw new Error(
    `GitCode Release ${tag} has an unsupported status: ${initialStatus ?? 'unknown'}.`,
  );
}

for (const name of assetNames) {
  if (!initialMissingAssets.includes(name)) {
    console.log(`Skipping ${name}; it is already uploaded.`);
    continue;
  }
  await uploadAsset(name);
}

let missingAssets = assetNames;
for (let attempt = 0; attempt < 5 && missingAssets.length > 0; attempt += 1) {
  if (attempt > 0) await sleep(2_000);
  release = await getRelease();
  const uploadedNames = uploadedAssetNames(release);
  missingAssets = assetNames.filter((name) => !uploadedNames.has(name));
}
if (missingAssets.length > 0) {
  throw new Error(
    `GitCode Release did not expose uploaded assets: ${missingAssets.join(', ')}`,
  );
}

try {
  await jsonRequest(`/releases/${encodeURIComponent(tag)}`, {
    method: 'PATCH',
    body: {
      tag_name: tag,
      name: `SugarCode ${tag}`,
      body: notes,
      release_status: 'latest',
    },
  });
} catch (publishError) {
  release = await getRelease();
  if (releaseStatus(release) !== 'latest') throw publishError;
  console.warn(
    `Publishing ${tag} returned an error, but GitCode reports it as latest; continuing.`,
  );
}

console.log(`Published GitCode Release ${tag}.`);
