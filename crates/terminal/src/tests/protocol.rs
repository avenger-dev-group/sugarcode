use super::protocol::InputCommand;
use super::protocol::{ExitReason, OutputEvent};

#[test]
fn rejects_unknown_command_fields() {
    let command = br#"{"type":"terminate","sequence":1,"command":"whoami"}"#;
    assert!(serde_json::from_slice::<InputCommand>(command).is_err());
}

#[test]
fn validates_bounded_terminal_dimensions() {
    let command = serde_json::from_str::<InputCommand>(
        r#"{"type":"resize","sequence":1,"columns":501,"rows":24}"#,
    )
    .expect("resize command");
    assert!(command.validate().is_err());
}

#[test]
fn serializes_bridge_fields_in_the_main_owned_camel_case_contract() {
    let ready = serde_json::to_value(OutputEvent::Ready {
        version: 1,
        shell: "/bin/zsh",
        encoding: "utf-8-replacement",
        process_group_id: Some(42),
    })
    .expect("ready event");
    assert_eq!(ready["processGroupId"], 42);
    assert!(ready.get("process_group_id").is_none());

    let exit = serde_json::to_value(OutputEvent::Exit {
        exit_code: 7,
        signal: None,
        reason: ExitReason::Natural,
    })
    .expect("exit event");
    assert_eq!(exit["exitCode"], 7);
    assert!(exit.get("exit_code").is_none());
    assert!(exit.get("signal").is_none());
}
