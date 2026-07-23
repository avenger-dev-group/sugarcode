use serde_json::json;
use sugarcode_app_server_protocol::ERROR_PARSE;
use sugarcode_app_server_protocol::JsonRpcError;
use sugarcode_app_server_protocol::JsonRpcErrorObject;
use sugarcode_app_server_protocol::JsonRpcMessage;
use sugarcode_app_server_protocol::JsonRpcVersion;
use sugarcode_app_server_protocol::RequestId;

#[test]
fn error_envelope_uses_json_rpc_2_and_null_unknown_id() {
    let message = JsonRpcMessage::Error(JsonRpcError {
        jsonrpc: JsonRpcVersion::V2,
        id: None,
        error: JsonRpcErrorObject {
            code: ERROR_PARSE,
            message: "Parse error".to_string(),
            data: None,
        },
    });

    assert_eq!(
        serde_json::to_value(message).expect("message serializes"),
        json!({
            "jsonrpc": "2.0",
            "id": null,
            "error": {
                "code": -32700,
                "message": "Parse error"
            }
        })
    );
}

#[test]
fn request_ids_support_strings_and_integers() {
    for id in [
        RequestId::String("request-1".to_string()),
        RequestId::Integer(7),
    ] {
        let encoded = serde_json::to_string(&id).expect("id serializes");
        let decoded = serde_json::from_str::<RequestId>(&encoded).expect("id deserializes");
        assert_eq!(decoded, id);
    }
}
