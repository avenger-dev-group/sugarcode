use super::super::*;

impl<C> Session<C>
where
    C: CoreApi,
{
    pub(in crate::session) fn list_workspace(
        &mut self,
        id: RequestId,
        params: Option<Value>,
    ) -> JsonRpcMessage {
        let params = match params.ok_or(()).and_then(|value| {
            serde_json::from_value::<PublicWorkspaceListParams>(value).map_err(|_| ())
        }) {
            Ok(params) => params,
            Err(()) => return error(Some(id), ERROR_INVALID_PARAMS, "Invalid params", None),
        };
        let Some(workspace) = self.workspace.as_ref() else {
            return error(
                Some(id),
                ERROR_WORKSPACE_UNAVAILABLE,
                "Workspace unavailable",
                None,
            );
        };
        let tool_path = if params.path.is_empty() {
            ".".to_string()
        } else {
            params.path.clone()
        };
        match workspace.list_now(&WorkspaceListArguments { path: tool_path }) {
            WorkspaceListOutcome::Entries { entries, .. } => {
                let entries = entries
                    .into_iter()
                    .map(|entry| {
                        let path = if params.path.is_empty() {
                            entry.name.clone()
                        } else {
                            format!("{}/{}", params.path, entry.name)
                        };
                        WorkspaceEntry {
                            name: entry.name,
                            path,
                            kind: match entry.kind {
                                WorkspaceListEntryKind::File => WorkspaceEntryKind::File,
                                WorkspaceListEntryKind::Directory => WorkspaceEntryKind::Directory,
                                WorkspaceListEntryKind::Link => WorkspaceEntryKind::Link,
                                WorkspaceListEntryKind::Other => WorkspaceEntryKind::Other,
                            },
                        }
                    })
                    .collect();
                response(
                    id,
                    WorkspaceListResponse {
                        path: params.path,
                        entries,
                    },
                )
            }
            WorkspaceListOutcome::Error { kind } => error(
                Some(id),
                ERROR_WORKSPACE_UNAVAILABLE,
                "Workspace list unavailable",
                Some(json!({ "kind": format!("{kind:?}") })),
            ),
        }
    }

    pub(in crate::session) fn inspect_workspace(
        &mut self,
        id: RequestId,
        params: Option<Value>,
    ) -> JsonRpcMessage {
        let params = match params.ok_or(()).and_then(|value| {
            serde_json::from_value::<WorkspaceInspectParams>(value).map_err(|_| ())
        }) {
            Ok(params) => params,
            Err(()) => return error(Some(id), ERROR_INVALID_PARAMS, "Invalid params", None),
        };
        let Some(workspace) = self.workspace.as_ref() else {
            return error(
                Some(id),
                ERROR_WORKSPACE_UNAVAILABLE,
                "Workspace unavailable",
                None,
            );
        };
        let result = match workspace.inspect_now(&WorkspaceInspectArguments {
            path: params.path.clone(),
        }) {
            WorkspaceInspectOutcome::Complete {
                content,
                bytes,
                lines,
                has_utf8_bom,
            } => WorkspaceInspectResponse::Complete {
                path: params.path,
                content,
                bytes: bytes as u32,
                lines: lines as u32,
                has_utf8_bom,
            },
            WorkspaceInspectOutcome::Truncated {
                content,
                bytes,
                returned_bytes,
                lines,
                has_utf8_bom,
            } => WorkspaceInspectResponse::Truncated {
                path: params.path,
                content,
                bytes: bytes as u32,
                returned_bytes: returned_bytes as u32,
                lines: lines as u32,
                has_utf8_bom,
            },
            WorkspaceInspectOutcome::Error { kind } => WorkspaceInspectResponse::Error {
                path: params.path,
                kind: map_inspect_error(kind),
            },
        };
        response(id, result)
    }
}

fn response<T: serde::Serialize>(id: RequestId, result: T) -> JsonRpcMessage {
    JsonRpcMessage::Response(JsonRpcResponse {
        jsonrpc: JsonRpcVersion::V2,
        id,
        result: serde_json::to_value(result).expect("workspace response must serialize"),
    })
}

fn map_inspect_error(kind: WorkspaceInspectErrorKind) -> PublicWorkspaceInspectErrorKind {
    match kind {
        WorkspaceInspectErrorKind::InvalidPath => PublicWorkspaceInspectErrorKind::InvalidPath,
        WorkspaceInspectErrorKind::NotFound => PublicWorkspaceInspectErrorKind::NotFound,
        WorkspaceInspectErrorKind::AccessDenied => PublicWorkspaceInspectErrorKind::AccessDenied,
        WorkspaceInspectErrorKind::PathNotAllowed => {
            PublicWorkspaceInspectErrorKind::PathNotAllowed
        }
        WorkspaceInspectErrorKind::NotRegularFile => {
            PublicWorkspaceInspectErrorKind::NotRegularFile
        }
        WorkspaceInspectErrorKind::Oversized => PublicWorkspaceInspectErrorKind::Oversized,
        WorkspaceInspectErrorKind::Binary => PublicWorkspaceInspectErrorKind::Binary,
        WorkspaceInspectErrorKind::InvalidEncoding => {
            PublicWorkspaceInspectErrorKind::InvalidEncoding
        }
        WorkspaceInspectErrorKind::LongLine => PublicWorkspaceInspectErrorKind::LongLine,
        WorkspaceInspectErrorKind::Changed => PublicWorkspaceInspectErrorKind::Changed,
        WorkspaceInspectErrorKind::Unavailable => PublicWorkspaceInspectErrorKind::Unavailable,
    }
}
