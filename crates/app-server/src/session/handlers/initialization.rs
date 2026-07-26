use super::super::*;

impl<C> Session<C>
where
    C: CoreApi,
{
    pub(in crate::session) fn initialize(
        &mut self,
        id: RequestId,
        params: Option<Value>,
    ) -> JsonRpcMessage {
        if self.state != SessionState::Uninitialized {
            return error(
                Some(id),
                ERROR_ALREADY_INITIALIZED,
                "Already initialized",
                None,
            );
        }

        let params = match params
            .ok_or(())
            .and_then(|value| serde_json::from_value::<InitializeParams>(value).map_err(|_| ()))
        {
            Ok(params) => params,
            Err(()) => {
                return error(Some(id), ERROR_INVALID_PARAMS, "Invalid params", None);
            }
        };

        if params.protocol_version != PROTOCOL_VERSION {
            return error(
                Some(id),
                ERROR_UNSUPPORTED_PROTOCOL_VERSION,
                "Unsupported protocol version",
                Some(json!({
                    "requested": params.protocol_version,
                    "supported": [PROTOCOL_VERSION],
                })),
            );
        }

        if params.client_info.name.trim().is_empty() || params.client_info.version.trim().is_empty()
        {
            return error(Some(id), ERROR_INVALID_PARAMS, "Invalid params", None);
        }
        self.command_approvals = params
            .capabilities
            .as_ref()
            .is_some_and(|capabilities| capabilities.command_approvals);

        let response = InitializeResponse {
            protocol_version: PROTOCOL_VERSION,
            server_info: ServerInfo {
                name: "sugarcode".to_string(),
                version: SUGARCODE_PRODUCT_VERSION.to_string(),
            },
            platform: PlatformInfo {
                family: std::env::consts::FAMILY.to_string(),
                os: std::env::consts::OS.to_string(),
                arch: std::env::consts::ARCH.to_string(),
            },
            capabilities: ServerCapabilities {
                command_approvals: true,
            },
        };
        let result = serde_json::to_value(response).expect("initialize response must serialize");
        self.state = SessionState::AwaitingInitialized;
        JsonRpcMessage::Response(JsonRpcResponse {
            jsonrpc: JsonRpcVersion::V2,
            id,
            result,
        })
    }
}
