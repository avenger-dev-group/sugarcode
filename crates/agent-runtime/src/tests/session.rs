use crate::AgentSurfaceSession;
use sugarcode_core::Core;
use sugarcode_core::TurnStartOutcome;
use sugarcode_protocol::CoreEventKind;

#[test]
fn surface_session_owns_request_correlation_and_durable_thread_operations() {
    let mut session = AgentSurfaceSession::new(Core::new());
    let started = session.start_thread().expect("start thread");
    assert_eq!(started.request_id.get(), 1);
    let thread_id = match started.kind {
        CoreEventKind::ThreadStarted { thread_id } => thread_id,
        kind => panic!("unexpected start event: {kind:?}"),
    };

    let (request_id, outcome) = session
        .start_text_turn(thread_id.clone(), Some("hello".to_string()))
        .expect("start turn");
    assert_eq!(request_id.get(), 2);
    let TurnStartOutcome::Immediate(events) = outcome else {
        panic!("memory core must complete immediately");
    };
    assert_eq!(events.len(), 5);
    assert!(events.iter().all(|event| event.request_id == request_id));

    let resumed = session.resume_thread(&thread_id).expect("resume thread");
    assert_eq!(resumed.id, thread_id);
    assert_eq!(resumed.turns.len(), 1);
}
