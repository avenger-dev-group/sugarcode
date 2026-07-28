use crate::DiscoveryErrorKind;
use crate::MAX_SERVER_TOOLS;
use crate::MAX_TOOL_DESCRIPTION_BYTES;
use crate::MAX_TOOL_SCHEMA_BYTES;
use crate::inventory::McpServerInventory;
use serde_json::json;

#[test]
fn canonical_inventory_sorts_tools_by_raw_ascii_name() {
    let inventory = McpServerInventory::from_protocol(
        "fixture",
        "fixture-server".to_owned(),
        "1.0.0".to_owned(),
        vec![
            json!({"name": "z.tool", "inputSchema": {"type": "object"}}),
            json!({"name": "A-tool", "inputSchema": {"type": "object"}}),
        ],
    )
    .expect("inventory");

    assert_eq!(
        inventory
            .tools()
            .iter()
            .map(|tool| tool.name())
            .collect::<Vec<_>>(),
        vec!["A-tool", "z.tool"]
    );
}

#[test]
fn duplicate_names_and_remote_schema_references_are_rejected() {
    let duplicate = McpServerInventory::from_protocol(
        "fixture",
        "fixture-server".to_owned(),
        "1.0.0".to_owned(),
        vec![
            json!({"name": "same", "inputSchema": {"type": "object"}}),
            json!({"name": "same", "inputSchema": {"type": "object"}}),
        ],
    )
    .expect_err("duplicate");
    assert_eq!(duplicate.kind(), DiscoveryErrorKind::InvalidToolInventory);

    let remote_reference = McpServerInventory::from_protocol(
        "fixture",
        "fixture-server".to_owned(),
        "1.0.0".to_owned(),
        vec![json!({
            "name": "remote",
            "inputSchema": {"$ref": "https://example.com/schema.json"}
        })],
    )
    .expect_err("remote reference");
    assert_eq!(
        remote_reference.kind(),
        DiscoveryErrorKind::InvalidToolInventory
    );
}

#[test]
fn tool_count_description_and_schema_budgets_fail_closed() {
    let too_many = (0..=MAX_SERVER_TOOLS)
        .map(|index| {
            json!({
                "name": format!("tool-{index}"),
                "inputSchema": {"type": "object"}
            })
        })
        .collect();
    assert_invalid(too_many);

    assert_invalid(vec![json!({
        "name": "description",
        "description": "x".repeat(MAX_TOOL_DESCRIPTION_BYTES + 1),
        "inputSchema": {"type": "object"}
    })]);

    assert_invalid(vec![json!({
        "name": "schema",
        "inputSchema": {
            "type": "object",
            "description": "x".repeat(MAX_TOOL_SCHEMA_BYTES)
        }
    })]);
}

#[test]
fn definition_inventory_and_schema_depth_budgets_fail_closed() {
    let nearly_full_input = largest_valid_schema('x');
    let nearly_full_output = largest_valid_schema('y');
    assert_invalid(vec![json!({
        "name": "definition",
        "inputSchema": nearly_full_input,
        "outputSchema": nearly_full_output
    })]);

    let aggregate = (0..MAX_SERVER_TOOLS)
        .map(|index| {
            json!({
                "name": format!("aggregate-{index}"),
                "description": "d".repeat(1024),
                "inputSchema": {
                    "type": "object",
                    "description": "x".repeat(8 * 1024)
                }
            })
        })
        .collect();
    assert_invalid(aggregate);

    let mut nested = json!({"type": "string"});
    for _ in 0..20 {
        nested = json!({"properties": {"nested": nested}});
    }
    assert_invalid(vec![json!({
        "name": "deep",
        "inputSchema": nested
    })]);
}

fn assert_invalid(tools: Vec<serde_json::Value>) {
    let result = McpServerInventory::from_protocol(
        "fixture",
        "fixture-server".to_owned(),
        "1.0.0".to_owned(),
        tools,
    );
    let Err(error) = result else {
        panic!("inventory must be rejected");
    };
    assert_eq!(error.kind(), DiscoveryErrorKind::InvalidToolInventory);
}

fn largest_valid_schema(fill: char) -> serde_json::Value {
    for length in (0..=MAX_TOOL_SCHEMA_BYTES).rev() {
        let schema = json!({
            "type": "object",
            "description": fill.to_string().repeat(length)
        });
        if serde_json::to_vec(&schema).expect("serialize").len() <= MAX_TOOL_SCHEMA_BYTES {
            return schema;
        }
    }
    unreachable!("empty schema fits")
}
