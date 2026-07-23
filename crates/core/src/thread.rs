use std::collections::BTreeMap;
use std::error::Error;
use std::fmt;
use sugarcode_protocol::CoreEvent;
use sugarcode_protocol::CoreEventKind;
use sugarcode_protocol::CoreRequestId;
use sugarcode_protocol::ThreadId;

#[derive(Debug, Clone, PartialEq, Eq)]
struct Thread {
    id: ThreadId,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CoreError {
    ThreadIdExhausted,
    Internal(String),
}

impl fmt::Display for CoreError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::ThreadIdExhausted => formatter.write_str("thread ID sequence exhausted"),
            Self::Internal(message) => formatter.write_str(message),
        }
    }
}

impl Error for CoreError {}

pub trait CoreApi {
    fn start_thread(&mut self, request_id: CoreRequestId) -> Result<CoreEvent, CoreError>;
}

#[derive(Debug, Default)]
pub struct Core {
    threads: BTreeMap<ThreadId, Thread>,
    last_thread_sequence: u64,
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
        };

        self.threads.insert(thread_id.clone(), thread);
        self.last_thread_sequence = sequence;

        Ok(CoreEvent {
            request_id,
            kind: CoreEventKind::ThreadStarted { thread_id },
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
        } = first.kind;
        assert_eq!(first.request_id, first_request_id);
        assert_eq!(first_thread_id.as_str(), "thr_0000000000000001");
        assert!(core.contains_thread(&first_thread_id));

        let second_request_id = CoreRequestId::new(8);
        let second = core
            .start_thread(second_request_id)
            .expect("second thread starts");
        let CoreEventKind::ThreadStarted {
            thread_id: second_thread_id,
        } = second.kind;
        assert_eq!(second.request_id, second_request_id);
        assert_eq!(second_thread_id.as_str(), "thr_0000000000000002");
        assert!(core.contains_thread(&second_thread_id));
        assert_eq!(core.thread_count(), 2);
    }
}
