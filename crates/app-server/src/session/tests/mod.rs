use super::*;
use sugarcode_core::CoreError;
use sugarcode_core::CoreRuntime;
use sugarcode_protocol::CoreEvent;
use sugarcode_protocol::CoreItemKind;
use sugarcode_protocol::CoreItemSnapshot;
use sugarcode_protocol::ItemId;
use sugarcode_protocol::TurnId;

fn initialize_line(version: u32) -> String {
    json!({
        "jsonrpc": "2.0",
        "id": "init-1",
        "method": "initialize",
        "params": {
            "protocolVersion": version,
            "clientInfo": {
                "name": "test-client",
                "version": "1.0.0"
            }
        }
    })
    .to_string()
}

mod approval;
mod discovery;
mod initialization;
mod thread_lifecycle;
mod turns;
mod workspace;
mod workspace_git;

fn ready_session<C>(core: C) -> Session<C>
where
    C: CoreApi,
{
    let mut session = Session::with_core(core);
    assert_eq!(session.process_line(&initialize_line(1)).len(), 1);
    assert!(
        session
            .process_line(r#"{"jsonrpc":"2.0","method":"initialized"}"#)
            .is_empty()
    );
    assert_eq!(session.state(), SessionState::Ready);
    session
}

fn response_thread_id(messages: &[JsonRpcMessage]) -> &str {
    let JsonRpcMessage::Response(response) = &messages[0] else {
        panic!("expected response first");
    };
    response
        .result
        .get("thread")
        .and_then(|thread| thread.get("id"))
        .and_then(Value::as_str)
        .expect("response thread id")
}

fn response_turn_id(messages: &[JsonRpcMessage]) -> &str {
    let JsonRpcMessage::Response(response) = &messages[0] else {
        panic!("expected response first");
    };
    response
        .result
        .get("turn")
        .and_then(|turn| turn.get("id"))
        .and_then(Value::as_str)
        .expect("response turn id")
}

fn notification_thread_id(messages: &[JsonRpcMessage]) -> &str {
    let JsonRpcMessage::Notification(notification) = &messages[1] else {
        panic!("expected notification second");
    };
    notification
        .params
        .as_ref()
        .and_then(|params| params.get("threadId"))
        .and_then(Value::as_str)
        .expect("notification thread id")
}

struct FailingCore;

impl CoreApi for FailingCore {
    fn start_thread(&mut self, _request_id: CoreRequestId) -> Result<CoreEvent, CoreError> {
        Err(CoreError::Internal("sensitive failure".to_string()))
    }

    fn contains_thread(&self, _thread_id: &ThreadId) -> bool {
        false
    }

    fn list_threads(
        &mut self,
        _cursor: Option<&ThreadId>,
        _limit: usize,
    ) -> Result<sugarcode_state::DurableThreadPage, CoreError> {
        Ok(sugarcode_state::DurableThreadPage {
            data: Vec::new(),
            next_cursor: None,
        })
    }

    fn resume_thread(
        &mut self,
        thread_id: &ThreadId,
    ) -> Result<sugarcode_state::DurableThreadSnapshot, CoreError> {
        Err(CoreError::ThreadNotFound(thread_id.clone()))
    }

    fn start_turn(
        &mut self,
        _request_id: CoreRequestId,
        _thread_id: ThreadId,
    ) -> Result<Vec<CoreEvent>, CoreError> {
        Err(CoreError::Internal("sensitive failure".to_string()))
    }
}

struct MismatchedCore;

impl CoreApi for MismatchedCore {
    fn start_thread(&mut self, request_id: CoreRequestId) -> Result<CoreEvent, CoreError> {
        Ok(CoreEvent {
            request_id: CoreRequestId::new(request_id.get() + 1),
            kind: CoreEventKind::ThreadStarted {
                thread_id: ThreadId::new("thr_wrong_request"),
            },
        })
    }

    fn contains_thread(&self, _thread_id: &ThreadId) -> bool {
        false
    }

    fn list_threads(
        &mut self,
        _cursor: Option<&ThreadId>,
        _limit: usize,
    ) -> Result<sugarcode_state::DurableThreadPage, CoreError> {
        Ok(sugarcode_state::DurableThreadPage {
            data: Vec::new(),
            next_cursor: None,
        })
    }

    fn resume_thread(
        &mut self,
        thread_id: &ThreadId,
    ) -> Result<sugarcode_state::DurableThreadSnapshot, CoreError> {
        Err(CoreError::ThreadNotFound(thread_id.clone()))
    }

    fn start_turn(
        &mut self,
        _request_id: CoreRequestId,
        _thread_id: ThreadId,
    ) -> Result<Vec<CoreEvent>, CoreError> {
        Err(CoreError::Internal("unexpected turn request".to_string()))
    }
}

struct StateUnavailableCore;

impl CoreApi for StateUnavailableCore {
    fn start_thread(&mut self, _request_id: CoreRequestId) -> Result<CoreEvent, CoreError> {
        Err(CoreError::StateUnavailable)
    }

    fn contains_thread(&self, _thread_id: &ThreadId) -> bool {
        true
    }

    fn list_threads(
        &mut self,
        _cursor: Option<&ThreadId>,
        _limit: usize,
    ) -> Result<sugarcode_state::DurableThreadPage, CoreError> {
        Err(CoreError::StateUnavailable)
    }

    fn resume_thread(
        &mut self,
        _thread_id: &ThreadId,
    ) -> Result<sugarcode_state::DurableThreadSnapshot, CoreError> {
        Err(CoreError::StateUnavailable)
    }

    fn start_turn(
        &mut self,
        _request_id: CoreRequestId,
        _thread_id: ThreadId,
    ) -> Result<Vec<CoreEvent>, CoreError> {
        Err(CoreError::StateUnavailable)
    }
}

#[derive(Clone, Copy)]
enum TurnCoreBehavior {
    Fail,
    AdvanceFail,
    WrongRequest,
    WrongThread,
    WrongEvent,
    WrongCompletedText,
}

struct TurnCore {
    behavior: TurnCoreBehavior,
}

impl TurnCore {
    fn new(behavior: TurnCoreBehavior) -> Self {
        Self { behavior }
    }
}

impl CoreApi for TurnCore {
    fn start_thread(&mut self, request_id: CoreRequestId) -> Result<CoreEvent, CoreError> {
        Ok(CoreEvent {
            request_id,
            kind: CoreEventKind::ThreadStarted {
                thread_id: ThreadId::new("thr_existing"),
            },
        })
    }

    fn contains_thread(&self, thread_id: &ThreadId) -> bool {
        thread_id.as_str() == "thr_existing"
    }

    fn list_threads(
        &mut self,
        _cursor: Option<&ThreadId>,
        _limit: usize,
    ) -> Result<sugarcode_state::DurableThreadPage, CoreError> {
        Ok(sugarcode_state::DurableThreadPage {
            data: Vec::new(),
            next_cursor: None,
        })
    }

    fn resume_thread(
        &mut self,
        thread_id: &ThreadId,
    ) -> Result<sugarcode_state::DurableThreadSnapshot, CoreError> {
        Err(CoreError::ThreadNotFound(thread_id.clone()))
    }

    fn start_turn(
        &mut self,
        request_id: CoreRequestId,
        thread_id: ThreadId,
    ) -> Result<Vec<CoreEvent>, CoreError> {
        match self.behavior {
            TurnCoreBehavior::Fail => {
                Err(CoreError::Internal("sensitive turn failure".to_string()))
            }
            TurnCoreBehavior::AdvanceFail => Err(CoreError::Internal(
                "sensitive completion failure".to_string(),
            )),
            TurnCoreBehavior::WrongRequest => {
                let mut events = valid_turn_events(request_id, thread_id);
                events[2].request_id = CoreRequestId::new(request_id.get() + 1);
                Ok(events)
            }
            TurnCoreBehavior::WrongThread => {
                let mut events = valid_turn_events(request_id, thread_id);
                events[3].kind = CoreEventKind::ItemCompleted {
                    thread_id: ThreadId::new("thr_wrong"),
                    turn_id: TurnId::new("turn_test"),
                    item: completed_test_item(),
                };
                Ok(events)
            }
            TurnCoreBehavior::WrongEvent => {
                let mut events = valid_turn_events(request_id, thread_id);
                events.swap(3, 4);
                Ok(events)
            }
            TurnCoreBehavior::WrongCompletedText => {
                let mut events = valid_turn_events(request_id, thread_id);
                events[3].kind = CoreEventKind::ItemCompleted {
                    thread_id: ThreadId::new("thr_existing"),
                    turn_id: TurnId::new("turn_test"),
                    item: CoreItemSnapshot {
                        id: ItemId::new("item_test"),
                        kind: CoreItemKind::AgentMessage {
                            text: "contradictory text".to_string(),
                        },
                    },
                };
                Ok(events)
            }
        }
    }
}

fn valid_turn_events(request_id: CoreRequestId, thread_id: ThreadId) -> Vec<CoreEvent> {
    let turn_id = TurnId::new("turn_test");
    let mut events = vec![
        CoreEvent {
            request_id,
            kind: CoreEventKind::TurnStarted {
                thread_id: thread_id.clone(),
                turn_id: turn_id.clone(),
            },
        },
        CoreEvent {
            request_id,
            kind: CoreEventKind::ItemStarted {
                thread_id: thread_id.clone(),
                turn_id: turn_id.clone(),
                item: CoreItemSnapshot {
                    id: ItemId::new("item_test"),
                    kind: CoreItemKind::AgentMessage {
                        text: String::new(),
                    },
                },
            },
        },
        CoreEvent {
            request_id,
            kind: CoreEventKind::AgentMessageDelta {
                thread_id: thread_id.clone(),
                turn_id: turn_id.clone(),
                item_id: ItemId::new("item_test"),
                delta: "test response".to_string(),
            },
        },
    ];
    events.extend([
        CoreEvent {
            request_id,
            kind: CoreEventKind::ItemCompleted {
                thread_id: thread_id.clone(),
                turn_id: turn_id.clone(),
                item: completed_test_item(),
            },
        },
        CoreEvent {
            request_id,
            kind: CoreEventKind::TurnCompleted { thread_id, turn_id },
        },
    ]);
    events
}

fn completed_test_item() -> CoreItemSnapshot {
    CoreItemSnapshot {
        id: ItemId::new("item_test"),
        kind: CoreItemKind::AgentMessage {
            text: "test response".to_string(),
        },
    }
}
