use crate::EXEC_EXIT_INPUT;
use crate::ExecErrorCategoryV1;
use crate::ExecOutputFormat;
use crate::ExecRunModeV1;
use crate::ExecRunStatusV1;
use crate::belongs_to_exec_request;
use crate::output::OutputEmitter;
use crate::output::write_standalone_error;
use sugarcode_protocol::CoreEvent;
use sugarcode_protocol::CoreEventKind;
use sugarcode_protocol::CoreRequestId;
use sugarcode_protocol::ItemId;
use sugarcode_protocol::ThreadId;
use sugarcode_protocol::TurnId;

#[test]
fn json_lines_contract_matches_the_committed_v1_golden() {
    let thread_id =
        ThreadId::parse("00000000-0000-7000-8000-000000000001").expect("valid thread UUIDv7");
    let turn_id = TurnId::parse("00000000-0001-7000-8000-000000000001").expect("valid turn UUIDv7");
    let request_id = CoreRequestId::new(2);
    let events = [
        CoreEvent {
            request_id: CoreRequestId::new(1),
            kind: CoreEventKind::ThreadStarted {
                thread_id: thread_id.clone(),
            },
        },
        CoreEvent {
            request_id,
            kind: CoreEventKind::TurnStarted {
                thread_id: thread_id.clone(),
                turn_id: turn_id.clone(),
            },
        },
        CoreEvent {
            request_id,
            kind: CoreEventKind::AgentMessageDelta {
                thread_id: thread_id.clone(),
                turn_id: turn_id.clone(),
                item_id: ItemId::parse("00000000-0002-7000-8000-000000000002")
                    .expect("valid item UUIDv7"),
                delta: "Hello, 世界".to_string(),
            },
        },
        CoreEvent {
            request_id,
            kind: CoreEventKind::TurnCompleted {
                thread_id: thread_id.clone(),
                turn_id: turn_id.clone(),
            },
        },
    ];
    let mut bytes = Vec::new();
    let mut output = OutputEmitter::new(ExecOutputFormat::JsonLines, &mut bytes);
    output
        .run_started(thread_id.as_str(), ExecRunModeV1::New)
        .expect("run start");
    for event in &events {
        output.event(event).expect("event");
    }
    output
        .finished(
            thread_id.as_str(),
            Some(turn_id.as_str()),
            ExecRunStatusV1::Completed,
        )
        .expect("run finish");
    assert_eq!(
        std::str::from_utf8(&bytes).expect("UTF-8 output"),
        include_str!("../../../../protocol-fixtures/exec-v1/success.jsonl")
    );
}

#[test]
fn machine_error_is_versioned_and_human_error_keeps_stdout_empty() {
    let mut machine = Vec::new();
    write_standalone_error(
        &mut machine,
        ExecOutputFormat::JsonLines,
        EXEC_EXIT_INPUT,
        ExecErrorCategoryV1::Input,
        "invalid prompt",
    )
    .expect("machine error");
    assert_eq!(
        std::str::from_utf8(&machine).expect("UTF-8 output"),
        include_str!("../../../../protocol-fixtures/exec-v1/input-error.jsonl")
    );

    let mut human = Vec::new();
    write_standalone_error(
        &mut human,
        ExecOutputFormat::Human,
        EXEC_EXIT_INPUT,
        ExecErrorCategoryV1::Input,
        "invalid prompt",
    )
    .expect("human error");
    assert!(human.is_empty());
}

#[test]
fn exec_request_filter_hides_internal_collaboration_events() {
    let root_request = CoreRequestId::new(2);
    let root = CoreEvent {
        request_id: root_request,
        kind: CoreEventKind::ThreadStarted {
            thread_id: ThreadId::parse("00000000-0000-7000-8000-000000000001")
                .expect("valid thread UUIDv7"),
        },
    };
    let child = CoreEvent {
        request_id: CoreRequestId::new(1u64 << 63),
        kind: CoreEventKind::ThreadStarted {
            thread_id: ThreadId::parse("00000000-0000-7000-8000-000000000002")
                .expect("valid thread UUIDv7"),
        },
    };
    assert!(belongs_to_exec_request(&root, root_request));
    assert!(!belongs_to_exec_request(&child, root_request));
}
