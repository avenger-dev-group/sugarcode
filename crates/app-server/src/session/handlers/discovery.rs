use super::super::*;

impl<C> Session<C>
where
    C: CoreApi,
{
    pub(in crate::session) fn list_threads(
        &mut self,
        id: RequestId,
        params: Option<Value>,
    ) -> Vec<JsonRpcMessage> {
        let params = match params {
            Some(value) => match serde_json::from_value::<ThreadListParams>(value) {
                Ok(params) => params,
                Err(_) => {
                    return vec![error(
                        Some(id),
                        ERROR_INVALID_PARAMS,
                        "Invalid params",
                        None,
                    )];
                }
            },
            None => ThreadListParams::default(),
        };
        if self.accepted_request_ids.contains(&id) {
            return vec![error(
                Some(id),
                ERROR_DUPLICATE_REQUEST,
                "Duplicate request id",
                None,
            )];
        }

        let cursor = params.cursor.as_deref().map(ThreadId::new);
        let limit = params.limit.unwrap_or(DEFAULT_THREAD_LIST_LIMIT) as usize;
        let page = match self.agent.list_threads(cursor.as_ref(), limit) {
            Ok(page) => page,
            Err(CoreError::StateUnavailable) => {
                return vec![error(
                    Some(id),
                    ERROR_STATE_UNAVAILABLE,
                    "State unavailable",
                    None,
                )];
            }
            Err(_) => {
                return vec![error(Some(id), ERROR_INTERNAL, "Internal error", None)];
            }
        };
        self.accepted_request_ids.insert(id.clone());
        let response = ThreadListResponse {
            data: page
                .data
                .into_iter()
                .map(|summary| PublicThread {
                    id: summary.id.into_string(),
                    title: summary.title,
                    origin: None,
                })
                .collect(),
            next_cursor: page.next_cursor.map(ThreadId::into_string),
        };
        vec![JsonRpcMessage::Response(JsonRpcResponse {
            jsonrpc: JsonRpcVersion::V2,
            id,
            result: serde_json::to_value(response).expect("thread/list response must serialize"),
        })]
    }

    pub(in crate::session) fn search_threads(
        &mut self,
        id: RequestId,
        params: Option<Value>,
    ) -> Vec<JsonRpcMessage> {
        let params = match params
            .ok_or(())
            .and_then(|value| serde_json::from_value::<ThreadSearchParams>(value).map_err(|_| ()))
        {
            Ok(params) => params,
            Err(()) => {
                return vec![error(
                    Some(id),
                    ERROR_INVALID_PARAMS,
                    "Invalid params",
                    None,
                )];
            }
        };
        if self.accepted_request_ids.contains(&id) {
            return vec![error(
                Some(id),
                ERROR_DUPLICATE_REQUEST,
                "Duplicate request id",
                None,
            )];
        }

        let cursor = params.cursor.as_deref().map(ThreadId::new);
        let limit = params.limit.unwrap_or(DEFAULT_THREAD_SEARCH_LIMIT) as usize;
        let page = match self
            .agent
            .search_threads(&params.query, cursor.as_ref(), limit)
        {
            Ok(page) => page,
            Err(CoreError::StateUnavailable) => {
                return vec![error(
                    Some(id),
                    ERROR_STATE_UNAVAILABLE,
                    "State unavailable",
                    None,
                )];
            }
            Err(_) => {
                return vec![error(Some(id), ERROR_INTERNAL, "Internal error", None)];
            }
        };
        self.accepted_request_ids.insert(id.clone());
        let response = ThreadSearchResponse {
            data: page
                .data
                .into_iter()
                .map(|summary| PublicThread {
                    id: summary.id.into_string(),
                    title: summary.title,
                    origin: None,
                })
                .collect(),
            next_cursor: page.next_cursor.map(ThreadId::into_string),
        };
        vec![JsonRpcMessage::Response(JsonRpcResponse {
            jsonrpc: JsonRpcVersion::V2,
            id,
            result: serde_json::to_value(response).expect("thread/search response must serialize"),
        })]
    }
}
