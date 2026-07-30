import {
  AlertTriangle,
  KeyRound,
  LoaderCircle,
  Settings2,
  Trash2,
  X,
} from 'lucide-react';
import {
  type FormEvent,
  useEffect,
  useRef,
  useState,
} from 'react';

import {
  type ModelConfigActionResult,
  type ModelConfigInspection,
  type ModelConfigValue,
} from '@/shared/model-config';
import {
  deleteModelCredential,
  getModelConfig,
  retryModelConnection,
  saveModelConfig,
} from '@/renderer/services/model-config';
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
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogTitle,
  DialogTrigger,
} from '@/renderer/components/ui/dialog';
import { Input } from '@/renderer/components/ui/input';

type Phase =
  | 'idle'
  | 'loading'
  | 'saving'
  | 'reconnecting'
  | 'deleting'
  | 'retrying';

const EMPTY_CONFIG: ModelConfigValue = {
  apiFormat: 'openai-chat-completions',
  endpoint: 'https://api.openai.com/v1/chat/completions',
  model: '',
  credentialReference: null,
};

const MODEL_CREDENTIAL_REFERENCE = 'model-api-token';

const statusLabel = (
  inspection: ModelConfigInspection | null,
): string => {
  switch (inspection?.credentialStatus) {
    case 'present':
      return 'API key saved';
    case 'missing':
      return 'API key missing';
    case 'unavailable':
      return 'API key status unavailable';
    default:
      return 'API key not configured';
  }
};

const usesPlaintextHttp = (endpoint: string): boolean => {
  try {
    return new URL(endpoint).protocol === 'http:';
  } catch {
    return false;
  }
};

const noticeFor = (result: ModelConfigActionResult): string => {
  if (result.state === 'active') {
    return 'Saved and active. The exact current Thread was restored.';
  }
  if (result.state === 'savedNotActive') {
    return 'Saved, but the new local Agent connection is not active.';
  }
  if (result.state === 'credentialStoredConfigUnchanged') {
    return 'The credential was stored, but configuration was not changed.';
  }
  if (result.reason === 'turnActive') {
    return 'Finish or stop the active Turn before reconnecting.';
  }
  if (result.reason === 'approvalPending') {
    return 'Resolve the pending approval before reconnecting.';
  }
  if (result.reason === 'navigationPending') {
    return 'Wait for Thread navigation to finish before reconnecting.';
  }
  if (result.reason === 'reconnectPending') {
    return 'Another reconnect is already in progress.';
  }
  if (result.reason === 'stale') {
    return 'Configuration changed elsewhere. Reload before saving.';
  }
  if (result.reason === 'invalid') {
    return 'The configuration was rejected by SugarCode validation.';
  }
  return 'The model configuration action could not be completed.';
};

export const ModelConfigWorkbench = () => {
  const [open, setOpen] = useState(false);
  const [phase, setPhase] = useState<Phase>('idle');
  const [inspection, setInspection] =
    useState<ModelConfigInspection | null>(null);
  const [config, setConfig] = useState<ModelConfigValue>(EMPTY_CONFIG);
  const [notice, setNotice] = useState<string | null>(null);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const passwordRef = useRef<HTMLInputElement>(null);
  const endpointRef = useRef<HTMLInputElement>(null);
  const cancelDeleteRef = useRef<HTMLButtonElement>(null);
  const busy = phase !== 'idle';

  useEffect(() => {
    if (!open) {
      if (passwordRef.current) {
        passwordRef.current.value = '';
      }
      return;
    }
    let active = true;
    setPhase('loading');
    setNotice(null);
    void getModelConfig()
      .then((next) => {
        if (!active) {
          return;
        }
        setInspection(next);
        setConfig(next.config ?? EMPTY_CONFIG);
        setPhase('idle');
      })
      .catch(() => {
        if (active) {
          setNotice('The saved model configuration is unavailable.');
          setPhase('idle');
        }
      });
    return () => {
      active = false;
    };
  }, [open]);

  const applyResult = (result: ModelConfigActionResult): void => {
    if (result.inspection) {
      setInspection(result.inspection);
      setConfig(result.inspection.config ?? EMPTY_CONFIG);
    }
    setNotice(noticeFor(result));
    setPhase('idle');
  };

  const submit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    if (!inspection || busy) {
      return;
    }
    const credential = passwordRef.current?.value ?? '';
    if (passwordRef.current) {
      passwordRef.current.value = '';
    }
    setNotice(null);
    setPhase('saving');
    const submittedConfig =
      credential.length > 0
        ? {
            ...config,
            credentialReference: MODEL_CREDENTIAL_REFERENCE,
          }
        : config;
    void saveModelConfig({
      expectedRevision: inspection.revision,
      config: submittedConfig,
      ...(credential.length > 0 ? { credential } : {}),
    })
      .then((result) => {
        setPhase('reconnecting');
        applyResult(result);
      })
      .catch(() => {
        setNotice('The model configuration could not be saved.');
        setPhase('idle');
      });
  };

  const removeCredential = (): void => {
    if (!inspection || busy) {
      return;
    }
    setDeleteOpen(false);
    setNotice(null);
    setPhase('deleting');
    void deleteModelCredential(inspection.revision)
      .then(applyResult)
      .catch(() => {
        setNotice('The credential could not be deleted.');
        setPhase('idle');
      });
  };

  const retry = (): void => {
    if (busy) {
      return;
    }
    setNotice(null);
    setPhase('retrying');
    void retryModelConnection()
      .then(applyResult)
      .catch(() => {
        setNotice('The saved configuration is still not active.');
        setPhase('idle');
      });
  };

  return (
    <>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogTrigger asChild>
          <Button
            type="button"
            size="icon"
            variant="ghost"
            aria-label="Open model settings"
            title="Model settings"
          >
            <Settings2 aria-hidden="true" />
          </Button>
        </DialogTrigger>
        <DialogContent
          onOpenAutoFocus={(event) => {
            event.preventDefault();
            endpointRef.current?.focus();
          }}
        >
          <div className="flex items-start gap-4 border-b px-5 py-4">
            <div className="min-w-0 flex-1">
              <DialogTitle className="text-lg font-semibold tracking-[-0.02em]">
                Model connection
              </DialogTitle>
              <DialogDescription className="mt-1 text-sm text-secondary">
                Configure the OpenAI-compatible endpoint used by the packaged
                local Agent.
              </DialogDescription>
            </div>
            <DialogClose asChild>
              <Button
                type="button"
                size="icon"
                variant="ghost"
                aria-label="Close model settings"
              >
                <X aria-hidden="true" />
              </Button>
            </DialogClose>
          </div>

          <form
            className="min-h-0 overflow-y-auto px-5 py-5"
            onSubmit={submit}
          >
            <fieldset
              className="grid gap-4"
              disabled={busy || !inspection}
            >
              <legend className="sr-only">Model configuration</legend>
              <label className="grid gap-1.5 text-sm" htmlFor="model-endpoint">
                <span>Endpoint</span>
                <Input
                  ref={endpointRef}
                  id="model-endpoint"
                  value={config.endpoint}
                  inputMode="url"
                  spellCheck={false}
                  onChange={(event) =>
                    setConfig((current) => ({
                      ...current,
                      endpoint: event.target.value,
                    }))
                  }
                />
                {usesPlaintextHttp(config.endpoint) ? (
                  <span
                    className="flex items-start gap-1.5 text-xs text-destructive"
                    role="alert"
                  >
                    <AlertTriangle
                      className="mt-0.5 size-3.5 shrink-0"
                      aria-hidden="true"
                    />
                    HTTP sends prompts and API credentials without transport
                    encryption. Use it only with a trusted endpoint and network.
                  </span>
                ) : null}
              </label>
              <label className="grid gap-1.5 text-sm" htmlFor="model-name">
                <span>Model</span>
                <Input
                  id="model-name"
                  value={config.model}
                  spellCheck={false}
                  onChange={(event) =>
                    setConfig((current) => ({
                      ...current,
                      model: event.target.value,
                    }))
                  }
                />
              </label>

              <div className="mt-1 rounded-xl border bg-surface p-4">
                <div className="flex flex-wrap items-center gap-2">
                  <KeyRound className="size-4 text-secondary" aria-hidden="true" />
                  <p className="text-sm font-medium">
                    {statusLabel(inspection)}
                  </p>
                </div>
                <label
                  className="mt-3 grid gap-1.5 text-sm"
                  htmlFor="model-credential"
                >
                  <span>API key (optional)</span>
                  <Input
                    ref={passwordRef}
                    id="model-credential"
                    type="password"
                    autoComplete="new-password"
                    spellCheck={false}
                    aria-describedby="model-credential-help"
                  />
                </label>
                <p
                  id="model-credential-help"
                  className="mt-2 text-xs text-tertiary"
                >
                  Paste a key to save or replace it. Leave blank to keep the
                  saved key, or for endpoints that do not require
                  authentication. SugarCode never reveals stored keys.
                </p>
                {inspection?.credentialStatus === 'present' ? (
                  <Button
                    className="mt-3"
                    type="button"
                    size="sm"
                    variant="destructive"
                    onClick={() => setDeleteOpen(true)}
                  >
                    <Trash2 aria-hidden="true" />
                    Delete API key
                  </Button>
                ) : null}
              </div>
            </fieldset>

            <div
              className="mt-4 min-h-10 rounded-lg border px-3 py-2 text-sm text-secondary"
              role="status"
              aria-live="polite"
            >
              {busy ? (
                <span className="flex items-center gap-2">
                  <LoaderCircle
                    className="size-4 animate-spin motion-reduce:animate-none"
                    aria-hidden="true"
                  />
                  {phase === 'loading'
                    ? 'Loading saved configuration…'
                    : phase === 'deleting'
                      ? 'Deleting credential and reconnecting…'
                      : phase === 'retrying'
                        ? 'Retrying the saved connection…'
                        : 'Saving and reconnecting…'}
                </span>
              ) : (
                notice ??
                'Saving reconnects the local Agent, restores this Thread, and leaves MCP disabled.'
              )}
            </div>

            <div className="mt-5 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
              {notice?.startsWith('Saved, but') ? (
                <Button
                  type="button"
                  variant="outline"
                  disabled={busy}
                  onClick={retry}
                >
                  Retry connection
                </Button>
              ) : null}
              <DialogClose asChild>
                <Button type="button" variant="ghost" disabled={busy}>
                  Close
                </Button>
              </DialogClose>
              <Button type="submit" disabled={busy || !inspection}>
                Save and reconnect
              </Button>
            </div>
          </form>
        </DialogContent>
      </Dialog>

      <AlertDialog open={deleteOpen} onOpenChange={setDeleteOpen}>
        <AlertDialogContent
          className="max-w-md p-5"
          onOpenAutoFocus={(event) => {
            event.preventDefault();
            cancelDeleteRef.current?.focus();
          }}
        >
          <AlertDialogHeader>
            <AlertDialogTitle>Delete saved API key?</AlertDialogTitle>
            <AlertDialogDescription>
              The model endpoint and model name will remain configured. The
              local Agent will reconnect without an API key and with MCP
              disabled.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter className="mt-5">
            <AlertDialogCancel asChild>
              <Button ref={cancelDeleteRef} type="button" variant="outline">
                Cancel
              </Button>
            </AlertDialogCancel>
            <AlertDialogAction asChild>
              <Button
                type="button"
                variant="destructive"
                onClick={removeCredential}
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
