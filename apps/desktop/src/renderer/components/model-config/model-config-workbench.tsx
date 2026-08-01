import {
  AlertTriangle,
  KeyRound,
  LoaderCircle,
  Plus,
  RefreshCw,
  Trash2,
} from 'lucide-react';

import { Button } from '@/renderer/components/ui/button';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/renderer/components/ui/alert-dialog';
import { DialogClose } from '@/renderer/components/ui/dialog';
import { Checkbox } from '@/renderer/components/ui/checkbox';
import { Input } from '@/renderer/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/renderer/components/ui/select';

import type { ModelConfigSettingsPanelProps } from './types';
import {
  PROVIDER_PRESETS,
  useStore,
  wireApiOptions,
} from './use-store';

const usesPlaintextHttp = (endpoint: string): boolean => {
  try {
    return new URL(endpoint).protocol === 'http:';
  } catch {
    return false;
  }
};

const contextSummary = (raw: string): string | null => {
  const value = Number(raw);
  if (
    !Number.isInteger(value) ||
    value < 4_096 ||
    value > 2_097_152
  ) {
    return null;
  }
  return `${value.toLocaleString()} tokens · approximately ${Math.round(value / 1024).toLocaleString()}K`;
};

export const ModelConfigSettingsPanel = (
  props: ModelConfigSettingsPanelProps,
) => {
  const store = useStore(props);
  const credentialStatus = store.inspection?.credentialStatuses.find(
    (credential) =>
      credential.connectionId === store.selectedConnection.id,
  )?.status;

  return (
    <>
      <div className="mx-auto grid w-full max-w-5xl gap-5">
        <label className="grid gap-1.5 text-sm" htmlFor="default-model">
          <span className="font-medium">Global default model</span>
          <Select
            value={store.config.defaultProfileId}
            disabled={store.busy || !store.inspection}
            onValueChange={store.setDefaultProfileId}
          >
            <SelectTrigger id="default-model">
              <SelectValue placeholder="Choose a default model" />
            </SelectTrigger>
            <SelectContent>
              {store.config.profiles.map((profile) => {
                const connection = store.config.connections.find(
                  (candidate) =>
                    candidate.id === profile.connectionId,
                );
                return (
                  <SelectItem
                    key={profile.id}
                    value={profile.id}
                    disabled={connection?.enabled !== true}
                  >
                    {profile.displayName} ·{' '}
                    {connection?.displayName ?? 'Unavailable'}
                  </SelectItem>
                );
              })}
            </SelectContent>
          </Select>
        </label>

        <div className="grid min-h-[32rem] overflow-hidden rounded-xl border bg-background md:grid-cols-[15rem_1fr]">
          <aside className="border-b bg-surface p-3 md:border-r md:border-b-0">
            <div className="flex items-center justify-between gap-2 px-1">
              <p className="text-sm font-medium">Connections</p>
              <Button
                type="button"
                size="icon-sm"
                variant="ghost"
                disabled={store.busy}
                aria-label="Add connection"
                onClick={store.addConnection}
              >
                <Plus aria-hidden="true" />
              </Button>
            </div>
            <div className="mt-2 grid gap-1">
              {store.config.connections.map((connection) => (
                <button
                  key={connection.id}
                  type="button"
                  className={`rounded-lg px-3 py-2 text-left text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring ${
                    connection.id === store.selectedConnectionId
                      ? 'bg-accent text-primary'
                      : 'text-secondary hover:bg-accent'
                  }`}
                  disabled={store.busy}
                  onClick={() =>
                    store.setSelectedConnectionId(connection.id)
                  }
                >
                  <span className="block truncate">
                    {connection.displayName}
                  </span>
                  <span className="mt-0.5 block truncate text-xs text-tertiary">
                    {connection.enabled
                      ? connection.providerFamily
                      : 'Disabled'}
                  </span>
                </button>
              ))}
            </div>
          </aside>

          <main className="grid content-start gap-6 p-5">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <h3 className="text-sm font-medium">
                  {store.selectedConnection.displayName}
                </h3>
                <p className="mt-1 text-xs text-secondary">
                  Shared endpoint and credential for this connection’s models.
                </p>
              </div>
              <Button
                type="button"
                size="sm"
                variant="destructive"
                disabled={store.busy}
                onClick={store.deleteConnection}
              >
                <Trash2 aria-hidden="true" />
                Delete connection
              </Button>
            </div>

            <fieldset
              className="grid gap-4"
              disabled={store.busy || !store.inspection}
            >
              <legend className="sr-only">Connection configuration</legend>
              <div className="grid gap-4 sm:grid-cols-2">
                <label className="grid gap-1.5 text-sm">
                  <span>Provider</span>
                  <Select
                    value={store.selectedConnection.providerFamily}
                    onValueChange={(providerFamily) =>
                      store.updateConnection({
                        providerFamily:
                          providerFamily as typeof store.selectedConnection.providerFamily,
                      })
                    }
                  >
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {PROVIDER_PRESETS.map((preset) => (
                        <SelectItem
                          key={preset.providerFamily}
                          value={preset.providerFamily}
                        >
                          {preset.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </label>
                <label className="grid gap-1.5 text-sm">
                  <span>Connection name</span>
                  <Input
                    value={store.selectedConnection.displayName}
                    onChange={(event) =>
                      store.updateConnection({
                        displayName: event.target.value,
                      })
                    }
                  />
                </label>
              </div>

              <label className="grid gap-1.5 text-sm">
                <span>Base URL</span>
                <Input
                  value={store.selectedConnection.baseUrl}
                  inputMode="url"
                  spellCheck={false}
                  onChange={(event) =>
                    store.updateConnection({
                      baseUrl: event.target.value,
                    })
                  }
                />
                {usesPlaintextHttp(store.selectedConnection.baseUrl) ? (
                  <span
                    className="flex items-start gap-1.5 text-xs text-destructive"
                    role="alert"
                  >
                    <AlertTriangle
                      className="mt-0.5 size-3.5 shrink-0"
                      aria-hidden="true"
                    />
                    HTTP sends prompts and API credentials without transport
                    encryption.
                  </span>
                ) : null}
              </label>

              <div className="grid gap-4 sm:grid-cols-2">
                <label className="grid gap-1.5 text-sm">
                  <span>Wire API</span>
                  <Select
                    value={store.selectedConnection.wireApi}
                    disabled={
                      store.selectedConnection.providerFamily !== 'openai'
                    }
                    onValueChange={(wireApi) =>
                      store.updateConnection({
                        wireApi:
                          wireApi as typeof store.selectedConnection.wireApi,
                      })
                    }
                  >
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {wireApiOptions(
                        store.selectedConnection.providerFamily,
                      ).map((wireApi) => (
                          <SelectItem key={wireApi} value={wireApi}>
                            {wireApi}
                          </SelectItem>
                        ))}
                    </SelectContent>
                  </Select>
                </label>
                <label className="flex items-center gap-2 self-end rounded-lg border px-3 py-2 text-sm">
                  <Checkbox
                    checked={store.selectedConnection.enabled}
                    onCheckedChange={(checked) =>
                      store.updateConnection({
                        enabled: checked === true,
                      })
                    }
                  />
                  Connection enabled
                </label>
              </div>

              <div className="rounded-xl border bg-surface p-4">
                <div className="flex flex-wrap items-center gap-2">
                  <KeyRound
                    className="size-4 text-secondary"
                    aria-hidden="true"
                  />
                  <p className="text-sm font-medium">
                    {credentialStatus === 'present'
                      ? 'API key saved'
                      : 'API key not configured'}
                  </p>
                </div>
                <label className="mt-3 grid gap-1.5 text-sm">
                  <span>API key (optional)</span>
                  <Input
                    type="password"
                    value={store.credentialValue}
                    autoComplete="new-password"
                    spellCheck={false}
                    onChange={(event) =>
                      store.setCredentialValue(event.target.value)
                    }
                  />
                </label>
                <p className="mt-2 text-xs text-tertiary">
                  Leave blank to preserve the saved key. SugarCode never
                  returns credential values to the app.
                </p>
                {credentialStatus === 'present' ? (
                  <Button
                    className="mt-3"
                    type="button"
                    size="sm"
                    variant="destructive"
                    onClick={() =>
                      store.setDeleteCredentialOpen(true)
                    }
                  >
                    <Trash2 aria-hidden="true" />
                    Delete API key
                  </Button>
                ) : null}
              </div>
            </fieldset>

            <fieldset
              className="grid gap-3"
              disabled={store.busy || !store.inspection}
            >
              <legend className="sr-only">Model profiles</legend>
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div>
                  <h4 className="text-sm font-medium">Models</h4>
                  <p className="mt-1 text-xs text-secondary">
                    Discovery is optional; model IDs can always be entered
                    manually.
                  </p>
                </div>
                <div className="flex gap-2">
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    disabled={!store.canDiscover || store.discovering}
                    title={
                      store.canDiscover
                        ? 'Read model metadata from the provider'
                        : 'Save the connection before refreshing models'
                    }
                    onClick={store.refreshModels}
                  >
                    <RefreshCw
                      className={
                        store.discovering
                          ? 'animate-spin motion-reduce:animate-none'
                          : undefined
                      }
                      aria-hidden="true"
                    />
                    Refresh models
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    disabled={store.busy}
                    onClick={store.addProfile}
                  >
                    <Plus aria-hidden="true" />
                    Add manually
                  </Button>
                </div>
              </div>

              {store.discoveredModels.length > 0 ? (
                <div className="grid gap-1 rounded-xl border bg-surface p-2">
                  {store.discoveredModels.map((model) => (
                    <div
                      key={model.modelId}
                      className="flex items-center justify-between gap-3 rounded-lg px-2 py-2"
                    >
                      <div className="min-w-0">
                        <p className="truncate text-sm text-primary">
                          {model.displayName}
                        </p>
                        <p className="truncate font-mono text-[11px] text-tertiary">
                          {model.modelId}
                          {model.contextWindowTokens
                            ? ` · ${model.contextWindowTokens.toLocaleString()} tokens`
                            : ''}
                        </p>
                      </div>
                      <Button
                        type="button"
                        size="sm"
                        variant="ghost"
                        onClick={() =>
                          store.addDiscoveredModel(model)
                        }
                      >
                        Add
                      </Button>
                    </div>
                  ))}
                </div>
              ) : null}

              {store.connectionProfiles.length === 0 ? (
                <div className="rounded-xl border border-dashed px-4 py-8 text-center text-sm text-secondary">
                  No models use this connection yet.
                </div>
              ) : (
                store.connectionProfiles.map((profile) => {
                  const rawContext =
                    store.contextInputs[profile.id] ?? '';
                  return (
                    <div
                      key={profile.id}
                      className="grid gap-4 rounded-xl border p-4"
                    >
                      <div className="grid gap-4 sm:grid-cols-2">
                        <label className="grid gap-1.5 text-sm">
                          <span>Display name</span>
                          <Input
                            value={profile.displayName}
                            onChange={(event) =>
                              store.updateProfile(profile.id, {
                                displayName: event.target.value,
                              })
                            }
                          />
                        </label>
                        <label className="grid gap-1.5 text-sm">
                          <span>Model ID</span>
                          <Input
                            value={profile.modelId}
                            spellCheck={false}
                            onChange={(event) =>
                              store.updateProfile(profile.id, {
                                modelId: event.target.value,
                              })
                            }
                          />
                        </label>
                      </div>
                      <div className="grid gap-4 sm:grid-cols-2">
                        <label className="grid gap-1.5 text-sm">
                          <span>Tool calls</span>
                          <Select
                            value={profile.toolCalls}
                            onValueChange={(toolCalls) =>
                              store.updateProfile(profile.id, {
                                toolCalls:
                                  toolCalls as typeof profile.toolCalls,
                              })
                            }
                          >
                            <SelectTrigger>
                              <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                              {['auto', 'enabled', 'disabled'].map(
                                (mode) => (
                                  <SelectItem key={mode} value={mode}>
                                    {mode}
                                  </SelectItem>
                                ),
                              )}
                            </SelectContent>
                          </Select>
                        </label>
                        <label className="grid gap-1.5 text-sm">
                          <span>Strict tool schema</span>
                          <Select
                            value={profile.strictTools}
                            onValueChange={(strictTools) =>
                              store.updateProfile(profile.id, {
                                strictTools:
                                  strictTools as typeof profile.strictTools,
                              })
                            }
                          >
                            <SelectTrigger>
                              <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                              {['auto', 'enabled', 'disabled'].map(
                                (mode) => (
                                  <SelectItem key={mode} value={mode}>
                                    {mode}
                                  </SelectItem>
                                ),
                              )}
                            </SelectContent>
                          </Select>
                        </label>
                        <label className="grid gap-1.5 text-sm">
                          <span>Parallel tool calls</span>
                          <Select
                            value={profile.parallelTools}
                            onValueChange={(parallelTools) =>
                              store.updateProfile(profile.id, {
                                parallelTools:
                                  parallelTools as typeof profile.parallelTools,
                              })
                            }
                          >
                            <SelectTrigger>
                              <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                              {['auto', 'enabled', 'disabled'].map(
                                (mode) => (
                                  <SelectItem key={mode} value={mode}>
                                    {mode}
                                  </SelectItem>
                                ),
                              )}
                            </SelectContent>
                          </Select>
                        </label>
                        <label className="grid gap-1.5 text-sm">
                          <span>Image input</span>
                          <Select
                            value={profile.imageInput}
                            onValueChange={(imageInput) =>
                              store.updateProfile(profile.id, {
                                imageInput:
                                  imageInput as typeof profile.imageInput,
                              })
                            }
                          >
                            <SelectTrigger>
                              <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                              {['auto', 'enabled', 'disabled'].map(
                                (mode) => (
                                  <SelectItem key={mode} value={mode}>
                                    {mode}
                                  </SelectItem>
                                ),
                              )}
                            </SelectContent>
                          </Select>
                        </label>
                        <label className="grid gap-1.5 text-sm">
                          <span>PDF input</span>
                          <Select
                            value={profile.pdfInput}
                            onValueChange={(pdfInput) =>
                              store.updateProfile(profile.id, {
                                pdfInput:
                                  pdfInput as typeof profile.pdfInput,
                              })
                            }
                          >
                            <SelectTrigger>
                              <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                              {['auto', 'enabled', 'disabled'].map(
                                (mode) => (
                                  <SelectItem key={mode} value={mode}>
                                    {mode}
                                  </SelectItem>
                                ),
                              )}
                            </SelectContent>
                          </Select>
                          {store.selectedConnection.wireApi ===
                          'openaiChatCompletions' ? (
                            <span className="text-xs text-tertiary">
                              Chat Completions cannot accept PDF input.
                            </span>
                          ) : null}
                        </label>
                      </div>
                      <div className="grid gap-4 sm:grid-cols-[1fr_auto]">
                        <label className="grid gap-1.5 text-sm">
                          <span>Context window (tokens)</span>
                          <Input
                            type="number"
                            inputMode="numeric"
                            min={4096}
                            max={2097152}
                            placeholder="131072"
                            value={rawContext}
                            aria-invalid={
                              rawContext.trim().length > 0 &&
                              contextSummary(rawContext) === null
                            }
                            onChange={(event) =>
                              store.setContextInput(
                                profile.id,
                                event.target.value,
                              )
                            }
                          />
                          <span
                            className={
                              rawContext.trim().length > 0 &&
                              contextSummary(rawContext) === null
                                ? 'text-xs text-destructive'
                                : 'text-xs text-tertiary'
                            }
                          >
                            {contextSummary(rawContext) ??
                              (rawContext.trim().length > 0
                                ? 'Enter an integer from 4,096 to 2,097,152.'
                                : 'Optional. Leave blank to use the 128K default.')}
                          </span>
                        </label>
                        <Button
                          className="self-end"
                          type="button"
                          size="sm"
                          variant="ghost"
                          disabled={store.busy}
                          onClick={() =>
                            store.deleteProfile(profile.id)
                          }
                        >
                          <Trash2 aria-hidden="true" />
                          Delete
                        </Button>
                      </div>
                    </div>
                  );
                })
              )}
            </fieldset>
          </main>
        </div>

        <div
          className="min-h-10 rounded-lg border px-3 py-2 text-sm text-secondary"
          role="status"
          aria-live="polite"
        >
          {store.busy ? (
            <span className="flex items-center gap-2">
              <LoaderCircle
                className="size-4 animate-spin motion-reduce:animate-none"
                aria-hidden="true"
              />
              {store.phase === 'loading'
                ? 'Loading saved catalog…'
                : store.phase === 'deleting'
                  ? 'Deleting API key…'
                  : 'Saving model catalog…'}
            </span>
          ) : (
            store.notice ??
            'Active Turns keep their frozen model. Changes apply to later Turns.'
          )}
        </div>

        <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
          {props.showCloseAction ? (
            <DialogClose asChild>
              <Button type="button" variant="ghost" disabled={store.busy}>
                Close
              </Button>
            </DialogClose>
          ) : null}
          <Button
            type="button"
            disabled={store.busy || !store.inspection}
            onClick={store.save}
          >
            Save catalog
          </Button>
        </div>
      </div>

      <AlertDialog
        open={store.deleteCredentialOpen}
        onOpenChange={store.setDeleteCredentialOpen}
      >
        <AlertDialogContent className="max-w-md p-5">
          <AlertDialogHeader>
            <AlertDialogTitle>Delete saved API key?</AlertDialogTitle>
            <AlertDialogDescription>
              Models and the endpoint remain configured. Active Turns continue
              unchanged.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter className="mt-5">
            <AlertDialogCancel asChild>
              <Button type="button" variant="outline">
                Cancel
              </Button>
            </AlertDialogCancel>
            <AlertDialogAction asChild>
              <Button
                type="button"
                variant="destructive"
                onClick={store.deleteCredential}
              >
                Delete API key
              </Button>
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
};
