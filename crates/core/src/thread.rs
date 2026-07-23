use std::collections::BTreeMap;
use std::error::Error;
use std::fmt;
use sugarcode_protocol::CoreEvent;
use sugarcode_protocol::CoreEventKind;
use sugarcode_protocol::CoreRequestId;
use sugarcode_protocol::ThreadId;
use sugarcode_protocol::TurnId;

#[derive(Debug, Clone, PartialEq, Eq)]
struct Thread {
    id: ThreadId,
    turns: BTreeMap<TurnId, Turn>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct Turn {
    id: TurnId,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CoreError {
    ThreadIdExhausted,
    TurnIdExhausted,
    ThreadNotFound(ThreadId),
    Internal(String),
}

impl fmt::Display for CoreError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::ThreadIdExhausted => formatter.write_str("thread ID sequence exhausted"),
            Self::TurnIdExhausted => formatter.write_str("turn ID sequence exhausted"),
            Self::ThreadNotFound(thread_id) => write!(formatter, "thread not found: {thread_id}"),
            Self::Internal(message) => formatter.write_str(message),
        }
    }
}

impl Error for CoreError {}

pub trait CoreApi {
    fn start_thread(&mut self, request_id: CoreRequestId) -> Result<CoreEvent, CoreError>;
    fn contains_thread(&self, thread_id: &ThreadId) -> bool;
    fn start_turn(
        &mut self,
        request_id: CoreRequestId,
        thread_id: ThreadId,
    ) -> Result<CoreEvent, CoreError>;
}

#[derive(Debug, Default)]
pub struct Core {
    threads: BTreeMap<ThreadId, Thread>,
    last_thread_sequence: u64,
    last_turn_sequence: u64,
}

impl Core {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn thread_count(&self) -> usize {
        self.threads.len()
    }

    pub fn contains_thread(&self, thread_id: &ThreadId) -> bool {
        self.threads
            .get(thread_id)
            .is_some_and(|thread| &thread.id == thread_id)
    }

    pub fn turn_count(&self, thread_id: &ThreadId) -> usize {
        self.threads
            .get(thread_id)
            .map_or(0, |thread| thread.turns.len())
    }

    pub fn contains_turn(&self, thread_id: &ThreadId, turn_id: &TurnId) -> bool {
        self.threads
            .get(thread_id)
            .and_then(|thread| thread.turns.get(turn_id))
            .is_some_and(|turn| &turn.id == turn_id)
    }
}

impl CoreApi for Core {
    fn start_thread(&mut self, request_id: CoreRequestId) -> Result<CoreEvent, CoreError> {
        let sequence = self
            .last_thread_sequence
            .checked_add(1)
            .ok_or(CoreError::ThreadIdExhausted)?;
        let thread_id = ThreadId::new(format!("thr_{sequence:016}"));
        let thread = Thread {
            id: thread_id.clone(),
            turns: BTreeMap::new(),
        };

        self.threads.insert(thread_id.clone(), thread);
        self.last_thread_sequence = sequence;

        Ok(CoreEvent {
            request_id,
            kind: CoreEventKind::ThreadStarted { thread_id },
        })
    }

    fn contains_thread(&self, thread_id: &ThreadId) -> bool {
        Self::contains_thread(self, thread_id)
    }

    fn start_turn(
        &mut self,
        request_id: CoreRequestId,
        thread_id: ThreadId,
    ) -> Result<CoreEvent, CoreError> {
        if !self.contains_thread(&thread_id) {
            return Err(CoreError::ThreadNotFound(thread_id));
        }

        let sequence = self
            .last_turn_sequence
            .checked_add(1)
            .ok_or(CoreError::TurnIdExhausted)?;
        let turn_id = TurnId::new(format!("turn_{sequence:016}"));
        let turn = Turn {
            id: turn_id.clone(),
        };

        let thread = self
            .threads
            .get_mut(&thread_id)
            .ok_or_else(|| CoreError::ThreadNotFound(thread_id.clone()))?;
        thread.turns.insert(turn_id.clone(), turn);
        self.last_turn_sequence = sequence;

        Ok(CoreEvent {
            request_id,
            kind: CoreEventKind::TurnStarted { thread_id, turn_id },
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn starts_deterministic_threads_and_correlates_events() {
        let mut core = Core::new();

        let first_request_id = CoreRequestId::new(7);
        let first = core
            .start_thread(first_request_id)
            .expect("first thread starts");
        let CoreEventKind::ThreadStarted {
            thread_id: first_thread_id,
        } = first.kind
        else {
            panic!("expected thread started event");
        };
        assert_eq!(first.request_id, first_request_id);
        assert_eq!(first_thread_id.as_str(), "thr_0000000000000001");
        assert!(core.contains_thread(&first_thread_id));

        let second_request_id = CoreRequestId::new(8);
        let second = core
            .start_thread(second_request_id)
            .expect("second thread starts");
        let CoreEventKind::ThreadStarted {
            thread_id: second_thread_id,
        } = second.kind
        else {
            panic!("expected thread started event");
        };
        assert_eq!(second.request_id, second_request_id);
        assert_eq!(second_thread_id.as_str(), "thr_0000000000000002");
        assert!(core.contains_thread(&second_thread_id));
        assert_eq!(core.thread_count(), 2);
    }

    #[test]
    fn starts_deterministic_turns_in_the_requested_threads() {
        let mut core = Core::new();
        let first_thread = core
            .start_thread(CoreRequestId::new(1))
            .expect("first thread starts");
        let CoreEventKind::ThreadStarted {
            thread_id: first_thread_id,
        } = first_thread.kind
        else {
            panic!("expected thread started event");
        };
        let second_thread = core
            .start_thread(CoreRequestId::new(2))
            .expect("second thread starts");
        let CoreEventKind::ThreadStarted {
            thread_id: second_thread_id,
        } = second_thread.kind
        else {
            panic!("expected thread started event");
        };

        let first_request_id = CoreRequestId::new(3);
        let first_turn = core
            .start_turn(first_request_id, first_thread_id.clone())
            .expect("first turn starts");
        let CoreEventKind::TurnStarted {
            thread_id,
            turn_id: first_turn_id,
        } = first_turn.kind
        else {
            panic!("expected turn started event");
        };
        assert_eq!(first_turn.request_id, first_request_id);
        assert_eq!(thread_id, first_thread_id);
        assert_eq!(first_turn_id.as_str(), "turn_0000000000000001");
        assert!(core.contains_turn(&thread_id, &first_turn_id));

        let second_turn = core
            .start_turn(CoreRequestId::new(4), first_thread_id.clone())
            .expect("second turn starts");
        let CoreEventKind::TurnStarted {
            thread_id,
            turn_id: second_turn_id,
        } = second_turn.kind
        else {
            panic!("expected turn started event");
        };
        assert_eq!(thread_id, first_thread_id);
        assert_eq!(second_turn_id.as_str(), "turn_0000000000000002");
        assert_eq!(core.turn_count(&first_thread_id), 2);

        let third_turn = core
            .start_turn(CoreRequestId::new(5), second_thread_id.clone())
            .expect("third turn starts");
        let CoreEventKind::TurnStarted {
            thread_id,
            turn_id: third_turn_id,
        } = third_turn.kind
        else {
            panic!("expected turn started event");
        };
        assert_eq!(thread_id, second_thread_id);
        assert_eq!(third_turn_id.as_str(), "turn_0000000000000003");
        assert!(core.contains_turn(&second_thread_id, &third_turn_id));
        assert_eq!(core.turn_count(&second_thread_id), 1);
    }

    #[test]
    fn missing_thread_does_not_advance_the_turn_sequence() {
        let mut core = Core::new();
        let missing_thread_id = ThreadId::new("thr_missing");

        assert_eq!(
            core.start_turn(CoreRequestId::new(1), missing_thread_id.clone()),
            Err(CoreError::ThreadNotFound(missing_thread_id))
        );

        let thread = core
            .start_thread(CoreRequestId::new(2))
            .expect("thread starts");
        let CoreEventKind::ThreadStarted { thread_id } = thread.kind else {
            panic!("expected thread started event");
        };
        let turn = core
            .start_turn(CoreRequestId::new(3), thread_id)
            .expect("turn starts");
        let CoreEventKind::TurnStarted { turn_id, .. } = turn.kind else {
            panic!("expected turn started event");
        };
        assert_eq!(turn_id.as_str(), "turn_0000000000000001");
    }

    #[test]
    fn exhausted_turn_sequence_does_not_create_a_turn() {
        let mut core = Core::new();
        let thread = core
            .start_thread(CoreRequestId::new(1))
            .expect("thread starts");
        let CoreEventKind::ThreadStarted { thread_id } = thread.kind else {
            panic!("expected thread started event");
        };
        core.last_turn_sequence = u64::MAX;

        assert_eq!(
            core.start_turn(CoreRequestId::new(2), thread_id.clone()),
            Err(CoreError::TurnIdExhausted)
        );
        assert_eq!(core.turn_count(&thread_id), 0);
    }
}
