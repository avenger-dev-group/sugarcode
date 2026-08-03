import {
  AlertTriangle,
  Check,
  Cpu,
  KeyRound,
  LoaderCircle,
  Plus,
  Star,
  Trash2,
} from 'lucide-react';

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
import { Button } from '@/renderer/components/ui/button';
import { Checkbox } from '@/renderer/components/ui/checkbox';
import { DialogClose } from '@/renderer/components/ui/dialog';
import { Input } from '@/renderer/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/renderer/components/ui/select';

import type { ModelConfigSettingsPanelProps } from './types';
import { PROVIDER_PRESETS, useStore } from './use-store';

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
  return `Approximately ${Math.round(value / 1024).toLocaleString()}K tokens`;
};

export const ModelConfigSettingsPanel = (
  props: ModelConfigSettingsPanelProps,
) => {
  const store = useStore(props);
  const rawContext =
    store.contextInputs[store.selectedProfile.id] ?? '';
  const credentialStatus = store.inspection?.credentialStatuses.find(
    (credential) =>
      credential.connectionId === store.selectedConnection.id,
  )?.status;
  const providerLabel =
    PROVIDER_PRESETS.find(
      (preset) =>
        preset.wireApi === store.selectedConnection.wireApi,
    )?.label ?? store.selectedConnection.providerFamily;
  const isDefault =
    store.config.defaultProfileId === store.selectedProfile.id;

  return (
    <>
      <div className="flex h-full min-h-0 flex-col">
        <header className="flex h-[4.25rem] shrink-0 items-center gap-3 border-b px-6">
          <Cpu className="size-4 text-secondary" aria-hidden="true" />
          <h2 className="text-sm font-medium">Model configuration</h2>
          <Button
            className="ml-auto"
            type="button"
            size="lg"
            variant="outline"
            disabled={store.busy}
            onClick={store.addConfiguration}
          >
            <Plus aria-hidden="true" />
            New
          </Button>
        </header>

        <div className="grid min-h-0 flex-1 grid-rows-[auto_minmax(0,1fr)] md:grid-cols-[14rem_minmax(0,1fr)] md:grid-rows-1">
          <aside className="border-b bg-surface/35 p-3 md:border-r md:border-b-0">
            <div className="grid max-h-40 gap-1 overflow-y-auto md:max-h-none">
              {store.config.profiles.map((profile) => {
                const connection = store.config.connections.find(
                  (candidate) =>
                    candidate.id === profile.connectionId,
                );
                const preset = PROVIDER_PRESETS.find(
                  (candidate) =>
                    candidate.wireApi === connection?.wireApi,
                );
                const selected =
                  profile.id === store.selectedProfileId;
                const ready =
                  connection?.enabled === true &&
                  profile.modelId.trim().length > 0;
                return (
                  <button
                    key={profile.id}
                    type="button"
                    aria-current={selected ? 'true' : undefined}
                    className={`grid w-full grid-cols-[auto_minmax(0,1fr)] gap-x-2 rounded-lg px-3 py-2.5 text-left outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring ${
                      selected
                        ? 'bg-background text-primary shadow-sm'
                        : 'text-secondary hover:bg-surface-hover hover:text-primary'
                    }`}
                    disabled={store.busy}
                    onClick={() =>
                      store.setSelectedProfileId(profile.id)
                    }
                  >
                    <span
                      className={`mt-1.5 size-1.5 rounded-full ${
                        ready ? 'bg-success' : 'bg-border'
                      }`}
                      aria-hidden="true"
                    />
                    <span className="min-w-0">
                      <span className="block truncate text-sm font-medium">
                        {profile.displayName}
                      </span>
                      <span className="mt-0.5 block truncate text-xs text-tertiary">
                        {preset?.label ??
                          connection?.providerFamily ??
                          'Unavailable'}
                        {profile.modelId
                          ? ` · ${profile.modelId}`
                          : ''}
                      </span>
                    </span>
                  </button>
                );
              })}
            </div>
          </aside>

          <main className="min-h-0 overflow-y-auto">
            <fieldset
              className="grid gap-3 px-5 py-4 lg:px-6"
              disabled={store.busy || !store.inspection}
            >
              <legend className="sr-only">
                Selected model configuration
              </legend>

              <div className="flex min-h-7 flex-wrap items-center justify-between gap-2">
                <div className="flex items-center gap-2 text-xs text-secondary">
                  <span>{providerLabel}</span>
                  {isDefault ? (
                    <span className="inline-flex items-center gap-1 rounded-full bg-surface px-2 py-1 text-primary">
                      <Star className="size-3" aria-hidden="true" />
                      Default
                    </span>
                  ) : null}
                </div>
                <div className="flex items-center gap-1">
                  {!isDefault ? (
                    <Button
                      type="button"
                      size="sm"
                      variant="ghost"
                      disabled={!store.selectedConnection.enabled}
                      onClick={store.setDefaultProfile}
                    >
                      <Star aria-hidden="true" />
                      Make default
                    </Button>
                  ) : null}
                  <Button
                    type="button"
                    size="icon-sm"
                    variant="ghost"
                    aria-label="Delete configuration"
                    onClick={store.deleteConfiguration}
                  >
                    <Trash2 aria-hidden="true" />
                  </Button>
                </div>
              </div>

              {!store.selectedConnection.enabled ? (
                <div className="flex items-center justify-between gap-3 rounded-lg border px-3 py-2 text-sm text-secondary">
                  <span>This saved connection is disabled.</span>
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    onClick={() =>
                      store.updateConnection({ enabled: true })
                    }
                  >
                    Enable
                  </Button>
                </div>
              ) : null}

              <div className="grid gap-3 sm:grid-cols-2">
                <label className="grid gap-1 text-sm">
                  <span className="text-secondary">Provider</span>
                  <Select
                    value={store.selectedConnection.wireApi}
                    onValueChange={(wireApi) =>
                      store.setProviderWire(
                        wireApi as typeof store.selectedConnection.wireApi,
                      )
                    }
                  >
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {PROVIDER_PRESETS.map((preset) => (
                        <SelectItem
                          key={preset.wireApi}
                          value={preset.wireApi}
                        >
                          {preset.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </label>

                <label className="grid gap-1 text-sm">
                  <span className="text-secondary">
                    Configuration name
                  </span>
                  <Input
                    value={store.selectedProfile.displayName}
                    placeholder="Work model"
                    onChange={(event) =>
                      store.updateSelectedProfile({
                        displayName: event.target.value,
                      })
                    }
                  />
                </label>

                <label className="grid gap-1 text-sm">
                  <span className="text-secondary">Model</span>
                  <Input
                    value={store.selectedProfile.modelId}
                    placeholder="gpt-5"
                    spellCheck={false}
                    onChange={(event) =>
                      store.updateSelectedProfile({
                        modelId: event.target.value,
                      })
                    }
                  />
                </label>

                <label className="grid gap-1 text-sm">
                  <span className="text-secondary">
                    Context window · default 128K
                  </span>
                  <Input
                    type="number"
                    inputMode="numeric"
                    min={4096}
                    max={2097152}
                    placeholder="Default 131072"
                    value={rawContext}
                    aria-invalid={
                      rawContext.trim().length > 0 &&
                      contextSummary(rawContext) === null
                    }
                    onChange={(event) =>
                      store.setContextInput(event.target.value)
                    }
                  />
                  {rawContext.trim().length > 0 ? (
                    <span
                      className={
                        contextSummary(rawContext) === null
                          ? 'text-xs text-destructive'
                          : 'text-xs text-tertiary'
                      }
                    >
                      {contextSummary(rawContext) ??
                        'Enter an integer from 4,096 to 2,097,152.'}
                    </span>
                  ) : null}
                </label>
              </div>

              <label className="grid gap-1 text-sm">
                <span className="text-secondary">
                  Automatic compaction · Runtime managed
                </span>
                <Input
                  value="Managed automatically"
                  readOnly
                  className="text-secondary"
                />
              </label>

              <label className="grid gap-1 text-sm">
                <span className="text-secondary">Base URL</span>
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

              <label className="grid gap-1 text-sm">
                <span className="flex items-center gap-2 text-secondary">
                  <span>API key</span>
                  {credentialStatus === 'present' ? (
                    <span className="text-xs text-tertiary">Saved</span>
                  ) : null}
                </span>
                <div className="flex gap-2">
                  <Input
                    type="password"
                    value={store.credentialValue}
                    autoComplete="new-password"
                    spellCheck={false}
                    placeholder={
                      credentialStatus === 'present'
                        ? 'Leave blank to keep the saved key'
                        : 'Optional'
                    }
                    onChange={(event) =>
                      store.setCredentialValue(event.target.value)
                    }
                  />
                  {credentialStatus === 'present' ? (
                    <Button
                      type="button"
                      size="icon-lg"
                      variant="outline"
                      aria-label="Delete saved API key"
                      onClick={() =>
                        store.setDeleteCredentialOpen(true)
                      }
                    >
                      <KeyRound aria-hidden="true" />
                    </Button>
                  ) : null}
                </div>
              </label>

              <label className="flex min-h-11 items-center gap-3 rounded-lg border px-3.5 py-2.5 text-sm">
                <Checkbox
                  checked={store.selectedProfile.imageInput === 'enabled'}
                  onCheckedChange={(checked) =>
                    store.updateSelectedProfile({
                      imageInput: checked === true ? 'enabled' : 'auto',
                    })
                  }
                />
                <span>Supports image understanding (Vision)</span>
              </label>

              <div className="flex flex-col gap-3 border-t pt-4 sm:flex-row sm:items-center">
                <div
                  className="min-h-5 flex-1 text-xs text-secondary"
                  role="status"
                  aria-live="polite"
                >
                  {store.busy ? (
                    <span className="flex items-center gap-2">
                      <LoaderCircle
                        className="size-3.5 animate-spin motion-reduce:animate-none"
                        aria-hidden="true"
                      />
                      {store.phase === 'loading'
                        ? 'Loading configuration…'
                        : store.phase === 'deleting'
                          ? 'Deleting API key…'
                          : 'Saving configuration…'}
                    </span>
                  ) : (
                    store.notice ??
                    'Changes apply to new turns; active turns keep their current model.'
                  )}
                </div>
                <div className="flex gap-2 sm:justify-end">
                  {props.showCloseAction ? (
                    <DialogClose asChild>
                      <Button
                        type="button"
                        variant="ghost"
                        disabled={store.busy}
                      >
                        Close
                      </Button>
                    </DialogClose>
                  ) : null}
                  <Button
                    type="button"
                    size="lg"
                    disabled={store.busy || !store.inspection}
                    onClick={store.save}
                  >
                    <Check aria-hidden="true" />
                    Save configuration
                  </Button>
                </div>
              </div>
            </fieldset>
          </main>
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
              The model configuration and endpoint will remain. Active turns
              continue unchanged.
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
