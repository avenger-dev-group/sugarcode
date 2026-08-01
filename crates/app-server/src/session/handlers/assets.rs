use super::super::*;
use base64::Engine;

impl<C> Session<C>
where
    C: CoreApi,
{
    pub(in crate::session) fn import_asset(
        &mut self,
        id: RequestId,
        params: Option<Value>,
    ) -> JsonRpcMessage {
        let params = match params
            .ok_or(())
            .and_then(|value| serde_json::from_value::<AssetImportParams>(value).map_err(|_| ()))
        {
            Ok(params) => params,
            Err(()) => return error(Some(id), ERROR_INVALID_PARAMS, "Invalid params", None),
        };
        let Some(store) = self.content_store.as_ref() else {
            return error(
                Some(id),
                ERROR_STATE_UNAVAILABLE,
                "Content store unavailable",
                None,
            );
        };
        let bytes = match base64::engine::general_purpose::STANDARD.decode(params.data.as_bytes()) {
            Ok(bytes) => bytes,
            Err(_) => {
                return error(
                    Some(id),
                    ERROR_INVALID_PARAMS,
                    "Invalid asset data",
                    Some(json!({"kind": "invalidBase64"})),
                );
            }
        };
        match store.import(params.file_name, params.media_type.as_deref(), &bytes) {
            Ok(asset) => response(
                id,
                AssetImportResponse {
                    asset: AssetDescriptor {
                        asset_id: asset.asset_id,
                        sha256: asset.sha256,
                        media_type: asset.media_type,
                        original_name: asset.original_name,
                        size_bytes: u32::try_from(asset.size_bytes)
                            .expect("validated asset size fits u32"),
                        kind: match asset.kind {
                            ContentAssetKind::Image => AssetKind::Image,
                            ContentAssetKind::Pdf => AssetKind::Pdf,
                            ContentAssetKind::Text => AssetKind::Text,
                        },
                        pdf_pages: asset.pdf_pages,
                    },
                },
            ),
            Err(error_kind) => {
                let state_error = matches!(
                    error_kind,
                    ContentStoreError::Io(_) | ContentStoreError::UnsafeStore
                );
                error(
                    Some(id),
                    if state_error {
                        ERROR_STATE_UNAVAILABLE
                    } else {
                        ERROR_INVALID_PARAMS
                    },
                    if state_error {
                        "Content store unavailable"
                    } else {
                        "Invalid asset"
                    },
                    Some(json!({"kind": content_error_kind(&error_kind)})),
                )
            }
        }
    }
}

fn content_error_kind(error: &ContentStoreError) -> &'static str {
    match error {
        ContentStoreError::InvalidAsset => "invalidAsset",
        ContentStoreError::InvalidName => "invalidName",
        ContentStoreError::UnsupportedMediaType => "unsupportedMediaType",
        ContentStoreError::MediaTypeMismatch => "mediaTypeMismatch",
        ContentStoreError::TooLarge => "tooLarge",
        ContentStoreError::InvalidUtf8 => "invalidUtf8",
        ContentStoreError::AnimatedImage => "animatedImage",
        ContentStoreError::InvalidPdf => "invalidPdf",
        ContentStoreError::PdfPageLimit => "pdfPageLimit",
        ContentStoreError::Missing => "missing",
        ContentStoreError::HashMismatch => "hashMismatch",
        ContentStoreError::UnsafeStore => "unsafeStore",
        ContentStoreError::Io(_) => "io",
    }
}

fn response<T: serde::Serialize>(id: RequestId, result: T) -> JsonRpcMessage {
    JsonRpcMessage::Response(JsonRpcResponse {
        jsonrpc: JsonRpcVersion::V2,
        id,
        result: serde_json::to_value(result).expect("asset response must serialize"),
    })
}
