use super::*;

const LARGE_AGENT_OUTPUT_BYTES: usize = 600 * 1024;

fn start_thread(core: &mut Core, request_id: u64) -> ThreadId {
    let event = core
        .start_thread(CoreRequestId::new(request_id))
        .expect("thread starts");
    let CoreEventKind::ThreadStarted { thread_id } = event.kind else {
        panic!("expected thread started event");
    };
    thread_id
}

fn turn_id(events: &[CoreEvent]) -> TurnId {
    let CoreEventKind::TurnStarted { turn_id, .. } = &events[0].kind else {
        panic!("expected turn started event first");
    };
    turn_id.clone()
}

mod failures;
mod lifecycle;
mod turns;
