use super::*;
use base64::Engine;
use sugarcode_state::HomeResolutionInputs;
use sugarcode_state::resolve_sugarcode_home;

#[test]
fn asset_import_validates_base64_mime_and_returns_content_address() {
    let directory = tempfile::tempdir().expect("home");
    let home = resolve_sugarcode_home(HomeResolutionInputs {
        cli_override: Some(directory.path().to_path_buf()),
        ..Default::default()
    })
    .expect("home");
    let store = Arc::new(ContentStore::open(&home).expect("content store"));
    let mut session = ready_session(Core::new()).with_content_store(Arc::clone(&store));
    let encoded = base64::engine::general_purpose::STANDARD.encode(b"hello");

    let mut messages = session.process_line(
        &json!({
            "jsonrpc": "2.0",
            "id": "asset-1",
            "method": "asset/import",
            "params": {
                "fileName": "notes.txt",
                "mediaType": "text/plain",
                "data": encoded
            }
        })
        .to_string(),
    );
    let JsonRpcMessage::Response(response) = messages.pop().expect("response") else {
        panic!("asset response");
    };
    assert_eq!(response.result["asset"]["kind"], "text");
    assert_eq!(response.result["asset"]["mediaType"], "text/plain");
    assert_eq!(response.result["asset"]["sizeBytes"], 5);
    let asset_id = response.result["asset"]["assetId"]
        .as_str()
        .expect("asset ID");
    assert!(asset_id.starts_with("ast_"));

    let mut errors = session.process_line(
        &json!({
            "jsonrpc": "2.0",
            "id": "asset-2",
            "method": "asset/import",
            "params": {
                "fileName": "spoof.png",
                "mediaType": "image/png",
                "data": base64::engine::general_purpose::STANDARD.encode(b"plain text")
            }
        })
        .to_string(),
    );
    let JsonRpcMessage::Error(error) = errors.pop().expect("error") else {
        panic!("asset error");
    };
    assert_eq!(error.error.code, ERROR_INVALID_PARAMS);
    assert_eq!(
        error.error.data.expect("error data")["kind"],
        "mediaTypeMismatch"
    );
}
