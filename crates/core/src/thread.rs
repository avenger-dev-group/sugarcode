use std::cmp::Reverse;
use std::collections::BTreeMap;
use std::error::Error;
use std::fmt;
use sugarcode_protocol::CoreEvent;
use sugarcode_protocol::CoreEventKind;
use sugarcode_protocol::CoreItemKind;
use sugarcode_protocol::CoreItemSnapshot;
use sugarcode_protocol::CoreRequestId;
use sugarcode_protocol::ItemId;
use sugarcode_protocol::ThreadId;
use sugarcode_protocol::TurnId;
use sugarcode_state::DurableItemSnapshot;
use sugarcode_state::DurableThreadLifecycle;
use sugarcode_state::DurableThreadPage;
use sugarcode_state::DurableThreadSnapshot;
use sugarcode_state::DurableThreadSummary;
use sugarcode_state::DurableTurnSnapshot;
use sugarcode_state::IdSequences;
use sugarcode_state::RolloutError;
use sugarcode_state::ThreadRepository;

const DETERMINISTIC_AGENT_MESSAGE: &str = "SugarCode deterministic response.";

#[derive(Debug, Clone, PartialEq, Eq)]
struct Thread {
    id: ThreadId,
    turns: BTreeMap<TurnId, Turn>,
    active_turn_id: Option<TurnId>,
    lifecycle: DurableThreadLifecycle,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum TurnState {
    InProgress,
    Completed,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct Turn {
    id: TurnId,
    request_id: CoreRequestId,
    state: TurnState,
    items: BTreeMap<ItemId, Item>,
    active_item_id: Option<ItemId>,
}

impl Turn {
    fn new(id: TurnId, request_id: CoreRequestId) -> Self {
        Self {
            id,
            request_id,
            state: TurnState::InProgress,
            items: BTreeMap::new(),
            active_item_id: None,
        }
    }

    fn add_item(&mut self, item: Item) -> Result<(), CoreError> {
        if self.state != TurnState::InProgress {
            return Err(CoreError::TurnNotInProgress(self.id.clone()));
        }
        if self.active_item_id.is_some() {
            return Err(CoreError::Internal(
                "cannot add an item while another item is active".to_string(),
            ));
        }
        self.active_item_id = Some(item.id.clone());
        self.items.insert(item.id.clone(), item);
        Ok(())
    }

    fn complete_active_item_and_turn(&mut self) -> Result<CoreItemSnapshot, CoreError> {
        if self.state != TurnState::InProgress {
            return Err(CoreError::TurnNotInProgress(self.id.clone()));
        }
        let item_id = self.active_item_id.clone().ok_or_else(|| {
            CoreError::Internal("cannot complete a turn without an active item".to_string())
        })?;
        let item = self.items.get_mut(&item_id).ok_or_else(|| {
            CoreError::Internal("active item is missing from its turn".to_string())
        })?;
        if item.state != ItemState::InProgress {
            return Err(CoreError::Internal(
                "active item is not in progress".to_string(),
            ));
        }

        item.complete()?;
        let snapshot = item.snapshot();
        self.active_item_id = None;
        self.state = TurnState::Completed;
        Ok(snapshot)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ItemState {
    InProgress,
    Completed,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct Item {
    id: ItemId,
    state: ItemState,
    kind: ItemKind,
}

#[derive(Debug, Clone, PartialEq, Eq)]
enum ItemKind {
    AgentMessage { text: String },
}

impl Item {
    fn new_agent_message(id: ItemId) -> Self {
        Self {
            id,
            state: ItemState::InProgress,
            kind: ItemKind::AgentMessage {
                text: String::new(),
            },
        }
    }

    fn append_agent_message_delta(&mut self, delta: &str) -> Result<(), CoreError> {
        if self.state != ItemState::InProgress {
            return Err(CoreError::ItemNotInProgress(self.id.clone()));
        }
        let ItemKind::AgentMessage { text } = &mut self.kind;
        text.push_str(delta);
        Ok(())
    }

    fn complete(&mut self) -> Result<(), CoreError> {
        if self.state != ItemState::InProgress {
            return Err(CoreError::ItemNotInProgress(self.id.clone()));
        }
        self.state = ItemState::Completed;
        Ok(())
    }

    fn snapshot(&self) -> CoreItemSnapshot {
        let kind = match &self.kind {
            ItemKind::AgentMessage { text } => CoreItemKind::AgentMessage { text: text.clone() },
        };
        CoreItemSnapshot {
            id: self.id.clone(),
            kind,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CoreError {
    ThreadIdExhausted,
    TurnIdExhausted,
    ItemIdExhausted,
    ThreadNotFound(ThreadId),
    NoActiveTurn(ThreadId),
    TurnAlreadyActive {
        thread_id: ThreadId,
        turn_id: TurnId,
    },
    TurnNotInProgress(TurnId),
    ItemNotInProgress(ItemId),
    StateUnavailable,
    Internal(String),
}

impl fmt::Display for CoreError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::ThreadIdExhausted => formatter.write_str("thread ID sequence exhausted"),
            Self::TurnIdExhausted => formatter.write_str("turn ID sequence exhausted"),
            Self::ItemIdExhausted => formatter.write_str("item ID sequence exhausted"),
            Self::ThreadNotFound(thread_id) => write!(formatter, "thread not found: {thread_id}"),
            Self::NoActiveTurn(thread_id) => {
                write!(formatter, "thread has no active turn: {thread_id}")
            }
            Self::TurnAlreadyActive { thread_id, turn_id } => write!(
                formatter,
                "thread {thread_id} already has an active turn: {turn_id}"
            ),
            Self::TurnNotInProgress(turn_id) => {
                write!(formatter, "turn is not in progress: {turn_id}")
            }
            Self::ItemNotInProgress(item_id) => {
                write!(formatter, "item is not in progress: {item_id}")
            }
            Self::StateUnavailable => formatter.write_str("durable state is unavailable"),
            Self::Internal(message) => formatter.write_str(message),
        }
    }
}

impl Error for CoreError {}

pub trait CoreApi {
    fn start_thread(&mut self, request_id: CoreRequestId) -> Result<CoreEvent, CoreError>;
    fn contains_thread(&self, thread_id: &ThreadId) -> bool;
    fn list_threads(
        &mut self,
        cursor: Option<&ThreadId>,
        limit: usize,
    ) -> Result<DurableThreadPage, CoreError>;
    fn search_threads(
        &mut self,
        _query: &str,
        _cursor: Option<&ThreadId>,
        _limit: usize,
    ) -> Result<DurableThreadPage, CoreError> {
        Err(CoreError::StateUnavailable)
    }
    fn archive_thread(&mut self, _thread_id: &ThreadId) -> Result<(), CoreError> {
        Err(CoreError::StateUnavailable)
    }
    fn unarchive_thread(&mut self, _thread_id: &ThreadId) -> Result<(), CoreError> {
        Err(CoreError::StateUnavailable)
    }
    fn delete_thread(&mut self, _thread_id: &ThreadId) -> Result<(), CoreError> {
        Err(CoreError::StateUnavailable)
    }
    fn resume_thread(&mut self, thread_id: &ThreadId) -> Result<DurableThreadSnapshot, CoreError>;
    fn start_turn(
        &mut self,
        request_id: CoreRequestId,
        thread_id: ThreadId,
    ) -> Result<Vec<CoreEvent>, CoreError>;
}

#[derive(Debug)]
pub struct Core {
    threads: BTreeMap<ThreadId, Thread>,
    last_thread_sequence: u64,
    last_turn_sequence: u64,
    last_item_sequence: u64,
    repository: Box<dyn ThreadRepository>,
}

impl Core {
    pub fn new() -> Self {
        Self::with_repository(Box::new(MemoryThreadRepository::default()))
    }

    pub fn with_repository(repository: Box<dyn ThreadRepository>) -> Self {
        let sequences = repository.id_sequences();
        Self {
            threads: BTreeMap::new(),
            last_thread_sequence: sequences.thread,
            last_turn_sequence: sequences.turn,
            last_item_sequence: sequences.item,
            repository,
        }
    }

    pub fn thread_count(&self) -> usize {
        self.threads.len()
    }

    pub fn contains_thread(&self, thread_id: &ThreadId) -> bool {
        self.threads.get(thread_id).is_some_and(|thread| {
            &thread.id == thread_id && thread.lifecycle == DurableThreadLifecycle::Active
        })
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

    fn materialize_snapshot(&mut self, snapshot: &DurableThreadSnapshot) {
        let mut turns = BTreeMap::new();
        for durable_turn in &snapshot.turns {
            let mut items = BTreeMap::new();
            for durable_item in &durable_turn.items {
                let item = match durable_item {
                    DurableItemSnapshot::AgentMessage { id, text } => Item {
                        id: id.clone(),
                        state: ItemState::Completed,
                        kind: ItemKind::AgentMessage { text: text.clone() },
                    },
                };
                items.insert(item.id.clone(), item);
            }
            let turn = Turn {
                id: durable_turn.id.clone(),
                request_id: CoreRequestId::new(0),
                state: TurnState::Completed,
                items,
                active_item_id: None,
            };
            turns.insert(turn.id.clone(), turn);
        }
        self.threads.insert(
            snapshot.id.clone(),
            Thread {
                id: snapshot.id.clone(),
                turns,
                active_turn_id: None,
                lifecycle: snapshot.lifecycle,
            },
        );
    }
}

impl Default for Core {
    fn default() -> Self {
        Self::new()
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
            active_turn_id: None,
            lifecycle: DurableThreadLifecycle::Active,
        };

        self.repository
            .create_thread(&thread_id)
            .map_err(map_repository_error)?;
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

    fn list_threads(
        &mut self,
        cursor: Option<&ThreadId>,
        limit: usize,
    ) -> Result<DurableThreadPage, CoreError> {
        self.repository
            .list_threads(cursor, limit)
            .map_err(map_repository_error)
    }

    fn search_threads(
        &mut self,
        query: &str,
        cursor: Option<&ThreadId>,
        limit: usize,
    ) -> Result<DurableThreadPage, CoreError> {
        self.repository
            .search_threads(query, cursor, limit)
            .map_err(map_repository_error)
    }

    fn archive_thread(&mut self, thread_id: &ThreadId) -> Result<(), CoreError> {
        let lifecycle = match self.threads.get(thread_id) {
            Some(thread) => thread.lifecycle,
            None => {
                self.repository
                    .load_thread(thread_id)
                    .map_err(map_repository_error)?
                    .ok_or_else(|| CoreError::ThreadNotFound(thread_id.clone()))?
                    .lifecycle
            }
        };
        if lifecycle == DurableThreadLifecycle::Archived {
            return Ok(());
        }
        if lifecycle == DurableThreadLifecycle::Deleted {
            return Err(CoreError::ThreadNotFound(thread_id.clone()));
        }
        self.repository
            .archive_thread(thread_id)
            .map_err(map_repository_error)?;
        if let Some(thread) = self.threads.get_mut(thread_id) {
            thread.lifecycle = DurableThreadLifecycle::Archived;
        }
        Ok(())
    }

    fn unarchive_thread(&mut self, thread_id: &ThreadId) -> Result<(), CoreError> {
        let mut snapshot = match self.threads.get(thread_id) {
            Some(thread) => durable_thread_snapshot(thread),
            None => self
                .repository
                .load_thread(thread_id)
                .map_err(map_repository_error)?
                .ok_or_else(|| CoreError::ThreadNotFound(thread_id.clone()))?,
        };
        if snapshot.lifecycle == DurableThreadLifecycle::Deleted {
            return Err(CoreError::ThreadNotFound(thread_id.clone()));
        }
        if snapshot.lifecycle == DurableThreadLifecycle::Archived {
            self.repository
                .unarchive_thread(thread_id)
                .map_err(map_repository_error)?;
            snapshot.lifecycle = DurableThreadLifecycle::Active;
        }
        self.materialize_snapshot(&snapshot);
        Ok(())
    }

    fn delete_thread(&mut self, thread_id: &ThreadId) -> Result<(), CoreError> {
        let lifecycle = match self.threads.get(thread_id) {
            Some(thread) => thread.lifecycle,
            None => {
                self.repository
                    .load_thread(thread_id)
                    .map_err(map_repository_error)?
                    .ok_or_else(|| CoreError::ThreadNotFound(thread_id.clone()))?
                    .lifecycle
            }
        };
        if lifecycle == DurableThreadLifecycle::Deleted {
            return Ok(());
        }
        self.repository
            .delete_thread(thread_id)
            .map_err(map_repository_error)?;
        if let Some(thread) = self.threads.get_mut(thread_id) {
            thread.lifecycle = DurableThreadLifecycle::Deleted;
        }
        Ok(())
    }

    fn resume_thread(&mut self, thread_id: &ThreadId) -> Result<DurableThreadSnapshot, CoreError> {
        if let Some(thread) = self.threads.get(thread_id) {
            if thread.lifecycle != DurableThreadLifecycle::Active {
                return Err(CoreError::ThreadNotFound(thread_id.clone()));
            }
            return Ok(durable_thread_snapshot(thread));
        }
        let snapshot = self
            .repository
            .load_thread(thread_id)
            .map_err(map_repository_error)?
            .ok_or_else(|| CoreError::ThreadNotFound(thread_id.clone()))?;
        if snapshot.lifecycle != DurableThreadLifecycle::Active {
            return Err(CoreError::ThreadNotFound(thread_id.clone()));
        }
        self.materialize_snapshot(&snapshot);
        Ok(snapshot)
    }

    fn start_turn(
        &mut self,
        request_id: CoreRequestId,
        thread_id: ThreadId,
    ) -> Result<Vec<CoreEvent>, CoreError> {
        let thread = self
            .threads
            .get(&thread_id)
            .ok_or_else(|| CoreError::ThreadNotFound(thread_id.clone()))?;
        if thread.lifecycle != DurableThreadLifecycle::Active {
            return Err(CoreError::ThreadNotFound(thread_id));
        }
        if let Some(turn_id) = &thread.active_turn_id {
            return Err(CoreError::TurnAlreadyActive {
                thread_id,
                turn_id: turn_id.clone(),
            });
        }

        let turn_sequence = self
            .last_turn_sequence
            .checked_add(1)
            .ok_or(CoreError::TurnIdExhausted)?;
        let item_sequence = self
            .last_item_sequence
            .checked_add(1)
            .ok_or(CoreError::ItemIdExhausted)?;
        let turn_id = TurnId::new(format!("turn_{turn_sequence:016}"));
        let item_id = ItemId::new(format!("item_{item_sequence:016}"));

        let mut turn = Turn::new(turn_id.clone(), request_id);
        let mut item = Item::new_agent_message(item_id.clone());
        let item_started = item.snapshot();
        item.append_agent_message_delta(DETERMINISTIC_AGENT_MESSAGE)?;
        let delta = DETERMINISTIC_AGENT_MESSAGE.to_string();
        turn.add_item(item)?;
        let item_completed = turn.complete_active_item_and_turn()?;
        let durable_turn = DurableTurnSnapshot {
            id: turn_id.clone(),
            items: vec![durable_item_snapshot(&item_completed)],
        };
        self.repository
            .append_completed_turn(&thread_id, &durable_turn)
            .map_err(map_repository_error)?;

        self.threads
            .get_mut(&thread_id)
            .ok_or_else(|| CoreError::ThreadNotFound(thread_id.clone()))?
            .turns
            .insert(turn_id.clone(), turn);
        self.last_turn_sequence = turn_sequence;
        self.last_item_sequence = item_sequence;

        Ok(vec![
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
                    item: item_started,
                },
            },
            CoreEvent {
                request_id,
                kind: CoreEventKind::AgentMessageDelta {
                    thread_id: thread_id.clone(),
                    turn_id: turn_id.clone(),
                    item_id,
                    delta,
                },
            },
            CoreEvent {
                request_id,
                kind: CoreEventKind::ItemCompleted {
                    thread_id: thread_id.clone(),
                    turn_id: turn_id.clone(),
                    item: item_completed,
                },
            },
            CoreEvent {
                request_id,
                kind: CoreEventKind::TurnCompleted {
                    thread_id: thread_id.clone(),
                    turn_id,
                },
            },
        ])
    }
}

fn durable_item_snapshot(item: &CoreItemSnapshot) -> DurableItemSnapshot {
    match &item.kind {
        CoreItemKind::AgentMessage { text } => DurableItemSnapshot::AgentMessage {
            id: item.id.clone(),
            text: text.clone(),
        },
    }
}

fn durable_thread_snapshot(thread: &Thread) -> DurableThreadSnapshot {
    DurableThreadSnapshot {
        id: thread.id.clone(),
        lifecycle: thread.lifecycle,
        turns: thread
            .turns
            .values()
            .map(|turn| DurableTurnSnapshot {
                id: turn.id.clone(),
                items: turn
                    .items
                    .values()
                    .map(|item| durable_item_snapshot(&item.snapshot()))
                    .collect(),
            })
            .collect(),
    }
}

fn map_repository_error(_error: RolloutError) -> CoreError {
    CoreError::StateUnavailable
}

#[derive(Debug, Default)]
struct MemoryThreadRepository {
    threads: BTreeMap<ThreadId, DurableThreadSnapshot>,
    sequences: IdSequences,
}

impl ThreadRepository for MemoryThreadRepository {
    fn id_sequences(&self) -> IdSequences {
        self.sequences
    }

    fn create_thread(&mut self, thread_id: &ThreadId) -> Result<(), RolloutError> {
        let sequence = thread_id
            .as_str()
            .strip_prefix("thr_")
            .and_then(|digits| digits.parse::<u64>().ok())
            .ok_or(RolloutError::InvalidId { kind: "thread" })?;
        if self.threads.contains_key(thread_id) {
            return Err(RolloutError::Collision { kind: "thread" });
        }
        self.threads.insert(
            thread_id.clone(),
            DurableThreadSnapshot {
                id: thread_id.clone(),
                turns: Vec::new(),
                lifecycle: DurableThreadLifecycle::Active,
            },
        );
        self.sequences.thread = sequence;
        Ok(())
    }

    fn append_completed_turn(
        &mut self,
        thread_id: &ThreadId,
        turn: &DurableTurnSnapshot,
    ) -> Result<(), RolloutError> {
        let thread = self
            .threads
            .get_mut(thread_id)
            .ok_or(RolloutError::InvalidId { kind: "thread" })?;
        if thread.lifecycle != DurableThreadLifecycle::Active {
            return Err(RolloutError::InvalidRecord {
                kind: if thread.lifecycle == DurableThreadLifecycle::Deleted {
                    "recordAfterThreadDelete"
                } else {
                    "recordAfterThreadArchive"
                },
            });
        }
        thread.turns.push(turn.clone());
        self.sequences.turn = turn
            .id
            .as_str()
            .strip_prefix("turn_")
            .and_then(|digits| digits.parse().ok())
            .ok_or(RolloutError::InvalidId { kind: "turn" })?;
        self.sequences.item = turn
            .items
            .last()
            .and_then(|item| item.id().as_str().strip_prefix("item_"))
            .and_then(|digits| digits.parse().ok())
            .ok_or(RolloutError::InvalidId { kind: "item" })?;
        Ok(())
    }

    fn load_thread(
        &self,
        thread_id: &ThreadId,
    ) -> Result<Option<DurableThreadSnapshot>, RolloutError> {
        Ok(self.threads.get(thread_id).cloned())
    }

    fn archive_thread(&mut self, thread_id: &ThreadId) -> Result<(), RolloutError> {
        let thread = self
            .threads
            .get_mut(thread_id)
            .ok_or(RolloutError::InvalidId { kind: "thread" })?;
        thread.lifecycle = DurableThreadLifecycle::Archived;
        Ok(())
    }

    fn unarchive_thread(&mut self, thread_id: &ThreadId) -> Result<(), RolloutError> {
        let thread = self
            .threads
            .get_mut(thread_id)
            .ok_or(RolloutError::InvalidId { kind: "thread" })?;
        thread.lifecycle = DurableThreadLifecycle::Active;
        Ok(())
    }

    fn delete_thread(&mut self, thread_id: &ThreadId) -> Result<(), RolloutError> {
        let thread = self
            .threads
            .get_mut(thread_id)
            .ok_or(RolloutError::InvalidId { kind: "thread" })?;
        thread.lifecycle = DurableThreadLifecycle::Deleted;
        Ok(())
    }

    fn list_threads(
        &mut self,
        cursor: Option<&ThreadId>,
        limit: usize,
    ) -> Result<DurableThreadPage, RolloutError> {
        let cursor_sequence = cursor.map(parse_thread_sequence).transpose()?;
        let mut threads = self
            .threads
            .values()
            .filter(|thread| thread.lifecycle == DurableThreadLifecycle::Active)
            .map(|thread| Ok((parse_thread_sequence(&thread.id)?, thread.id.clone())))
            .collect::<Result<Vec<_>, RolloutError>>()?;
        threads.sort_unstable_by_key(|thread| Reverse(thread.0));
        let mut ids = threads
            .into_iter()
            .filter(|(sequence, _)| cursor_sequence.is_none_or(|cursor| *sequence < cursor))
            .map(|(_, id)| id)
            .take(limit + 1)
            .collect::<Vec<_>>();
        let has_more = ids.len() > limit;
        ids.truncate(limit);
        Ok(DurableThreadPage {
            next_cursor: has_more.then(|| ids.last().cloned()).flatten(),
            data: ids
                .into_iter()
                .map(|id| DurableThreadSummary { id })
                .collect(),
        })
    }

    fn search_threads(
        &mut self,
        query: &str,
        cursor: Option<&ThreadId>,
        limit: usize,
    ) -> Result<DurableThreadPage, RolloutError> {
        if limit == 0 || limit > 100 {
            return Err(RolloutError::InvalidRecord {
                kind: "threadSearchLimit",
            });
        }
        let terms = validate_search_query(query)?;
        let cursor_sequence = cursor.map(parse_thread_sequence).transpose()?;
        let mut matches = self
            .threads
            .values()
            .filter(|thread| thread.lifecycle == DurableThreadLifecycle::Active)
            .filter(|thread| {
                thread
                    .turns
                    .iter()
                    .flat_map(|turn| &turn.items)
                    .any(|item| {
                        let DurableItemSnapshot::AgentMessage { text, .. } = item;
                        let text = text.to_lowercase();
                        terms.iter().all(|term| text.contains(term))
                    })
            })
            .map(|thread| {
                Ok((
                    parse_thread_sequence(&thread.id)?,
                    DurableThreadSummary {
                        id: thread.id.clone(),
                    },
                ))
            })
            .collect::<Result<Vec<_>, RolloutError>>()?;
        matches.sort_unstable_by_key(|(sequence, _)| Reverse(*sequence));
        let mut data = matches
            .into_iter()
            .filter(|(sequence, _)| cursor_sequence.is_none_or(|cursor| *sequence < cursor))
            .map(|(_, summary)| summary)
            .take(limit + 1)
            .collect::<Vec<_>>();
        let has_more = data.len() > limit;
        data.truncate(limit);
        Ok(DurableThreadPage {
            next_cursor: has_more
                .then(|| data.last().map(|thread| thread.id.clone()))
                .flatten(),
            data,
        })
    }
}

fn validate_search_query(query: &str) -> Result<Vec<String>, RolloutError> {
    if query.chars().any(char::is_control) {
        return Err(RolloutError::InvalidRecord {
            kind: "threadSearchQuery",
        });
    }
    let query = query.trim();
    let terms = query.split_whitespace().collect::<Vec<_>>();
    if query.is_empty() || query.len() > 256 || terms.len() > 16 {
        return Err(RolloutError::InvalidRecord {
            kind: "threadSearchQuery",
        });
    }
    Ok(terms.into_iter().map(str::to_lowercase).collect())
}

fn parse_thread_sequence(thread_id: &ThreadId) -> Result<u64, RolloutError> {
    thread_id
        .as_str()
        .strip_prefix("thr_")
        .and_then(|digits| digits.parse::<u64>().ok())
        .filter(|sequence| format!("{sequence:016}") == thread_id.as_str()[4..])
        .ok_or(RolloutError::InvalidId { kind: "thread" })
}

#[cfg(test)]
mod tests {
    use super::*;

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

    #[test]
    fn starts_deterministic_threads_and_correlates_events() {
        let mut core = Core::new();

        let first_request_id = CoreRequestId::new(7);
        let first_thread_id = start_thread(&mut core, first_request_id.get());
        assert_eq!(first_thread_id.as_str(), "thr_0000000000000001");
        assert!(core.contains_thread(&first_thread_id));

        let second_thread_id = start_thread(&mut core, 8);
        assert_eq!(second_thread_id.as_str(), "thr_0000000000000002");
        assert!(core.contains_thread(&second_thread_id));
        assert_eq!(core.thread_count(), 2);
    }

    #[test]
    fn search_returns_only_completed_matching_threads_in_descending_id_order() {
        let mut core = Core::new();
        let first = start_thread(&mut core, 1);
        core.start_turn(CoreRequestId::new(2), first.clone())
            .expect("first completed turn");
        let second = start_thread(&mut core, 3);
        core.start_turn(CoreRequestId::new(4), second.clone())
            .expect("second completed turn");
        let empty = start_thread(&mut core, 5);

        let page = core
            .search_threads("SugarCode response", None, 50)
            .expect("search");
        assert_eq!(
            page.data
                .iter()
                .map(|summary| summary.id.clone())
                .collect::<Vec<_>>(),
            [second, first]
        );
        assert!(
            page.data.iter().all(|summary| summary.id != empty),
            "empty threads are not searchable"
        );
    }

    #[test]
    fn archive_is_idempotent_and_hides_thread_without_reusing_ids() {
        let mut core = Core::new();
        let archived = start_thread(&mut core, 1);
        core.start_turn(CoreRequestId::new(2), archived.clone())
            .expect("completed turn");

        core.archive_thread(&archived).expect("archive");
        core.archive_thread(&archived).expect("idempotent archive");
        assert!(!core.contains_thread(&archived));
        assert_eq!(
            core.resume_thread(&archived),
            Err(CoreError::ThreadNotFound(archived.clone()))
        );
        assert_eq!(
            core.start_turn(CoreRequestId::new(3), archived.clone()),
            Err(CoreError::ThreadNotFound(archived.clone()))
        );
        assert!(core.list_threads(None, 50).expect("list").data.is_empty());
        assert!(
            core.search_threads("SugarCode", None, 50)
                .expect("search")
                .data
                .is_empty()
        );

        let next = start_thread(&mut core, 4);
        assert_eq!(next.as_str(), "thr_0000000000000002");
    }

    #[test]
    fn unarchive_is_idempotent_restores_history_and_allows_the_next_turn() {
        let mut core = Core::new();
        let thread_id = start_thread(&mut core, 1);
        core.start_turn(CoreRequestId::new(2), thread_id.clone())
            .expect("first turn");
        core.archive_thread(&thread_id).expect("archive");

        core.unarchive_thread(&thread_id).expect("unarchive");
        core.unarchive_thread(&thread_id)
            .expect("idempotent unarchive");
        assert!(core.contains_thread(&thread_id));
        assert_eq!(
            core.list_threads(None, 50).expect("list").data[0].id,
            thread_id
        );
        assert_eq!(
            core.search_threads("SugarCode", None, 50)
                .expect("search")
                .data[0]
                .id,
            thread_id
        );
        assert_eq!(
            core.resume_thread(&thread_id)
                .expect("resume restored history")
                .turns
                .len(),
            1
        );
        let events = core
            .start_turn(CoreRequestId::new(3), thread_id.clone())
            .expect("turn after unarchive");
        assert_eq!(turn_id(&events).as_str(), "turn_0000000000000002");
        assert_eq!(core.turn_count(&thread_id), 2);

        let missing = ThreadId::new("thr_0000000000000099");
        assert_eq!(
            core.unarchive_thread(&missing),
            Err(CoreError::ThreadNotFound(missing))
        );
    }

    #[test]
    fn delete_is_terminal_idempotent_and_preserves_id_sequences() {
        let mut core = Core::new();
        let active = start_thread(&mut core, 1);
        core.start_turn(CoreRequestId::new(2), active.clone())
            .expect("active turn");
        let archived = start_thread(&mut core, 3);
        core.start_turn(CoreRequestId::new(4), archived.clone())
            .expect("archived turn");
        core.archive_thread(&archived).expect("archive");

        core.delete_thread(&active).expect("delete active");
        core.delete_thread(&active).expect("idempotent delete");
        core.delete_thread(&archived).expect("delete archived");
        assert!(!core.contains_thread(&active));
        assert!(!core.contains_thread(&archived));
        for thread_id in [&active, &archived] {
            assert_eq!(
                core.resume_thread(thread_id),
                Err(CoreError::ThreadNotFound(thread_id.clone()))
            );
            assert_eq!(
                core.archive_thread(thread_id),
                Err(CoreError::ThreadNotFound(thread_id.clone()))
            );
            assert_eq!(
                core.unarchive_thread(thread_id),
                Err(CoreError::ThreadNotFound(thread_id.clone()))
            );
            assert_eq!(
                core.start_turn(CoreRequestId::new(5), thread_id.clone()),
                Err(CoreError::ThreadNotFound(thread_id.clone()))
            );
        }
        assert!(core.list_threads(None, 50).expect("list").data.is_empty());
        assert!(
            core.search_threads("SugarCode", None, 50)
                .expect("search")
                .data
                .is_empty()
        );

        let next = start_thread(&mut core, 6);
        assert_eq!(next.as_str(), "thr_0000000000000003");
        let events = core
            .start_turn(CoreRequestId::new(7), next)
            .expect("next turn");
        assert_eq!(turn_id(&events).as_str(), "turn_0000000000000003");
        let CoreEventKind::ItemStarted { item, .. } = &events[1].kind else {
            panic!("expected item started");
        };
        assert_eq!(item.id.as_str(), "item_0000000000000003");
    }

    #[test]
    fn commits_a_complete_deterministic_agent_message_lifecycle() {
        let mut core = Core::new();
        let thread_id = start_thread(&mut core, 1);
        let request_id = CoreRequestId::new(2);

        let events = core
            .start_turn(request_id, thread_id.clone())
            .expect("turn starts");

        assert_eq!(events.len(), 5);
        assert!(events.iter().all(|event| event.request_id == request_id));
        let turn_id = turn_id(&events);
        assert_eq!(turn_id.as_str(), "turn_0000000000000001");

        let CoreEventKind::ItemStarted {
            thread_id: started_thread_id,
            turn_id: started_turn_id,
            item: started_item,
        } = &events[1].kind
        else {
            panic!("expected item started second");
        };
        assert_eq!(started_thread_id, &thread_id);
        assert_eq!(started_turn_id, &turn_id);
        assert_eq!(started_item.id.as_str(), "item_0000000000000001");
        assert_eq!(
            started_item.kind,
            CoreItemKind::AgentMessage {
                text: String::new()
            }
        );

        let CoreEventKind::AgentMessageDelta {
            thread_id: delta_thread_id,
            turn_id: delta_turn_id,
            item_id,
            delta,
        } = &events[2].kind
        else {
            panic!("expected agent message delta third");
        };
        assert_eq!(delta_thread_id, &thread_id);
        assert_eq!(delta_turn_id, &turn_id);
        assert_eq!(item_id, &started_item.id);
        assert_eq!(delta, DETERMINISTIC_AGENT_MESSAGE);

        let CoreEventKind::ItemCompleted {
            thread_id: completed_thread_id,
            turn_id: completed_turn_id,
            item: completed_item,
        } = &events[3].kind
        else {
            panic!("expected item completed first");
        };
        assert_eq!(completed_thread_id, &thread_id);
        assert_eq!(completed_turn_id, &turn_id);
        assert_eq!(completed_item.id, started_item.id);
        assert_eq!(
            completed_item.kind,
            CoreItemKind::AgentMessage {
                text: DETERMINISTIC_AGENT_MESSAGE.to_string()
            }
        );

        assert_eq!(
            events[4].kind,
            CoreEventKind::TurnCompleted {
                thread_id: thread_id.clone(),
                turn_id: turn_id.clone()
            }
        );
        let stored_turn = &core.threads[&thread_id].turns[&turn_id];
        assert_eq!(stored_turn.state, TurnState::Completed);
        assert_eq!(
            stored_turn.items[&completed_item.id].state,
            ItemState::Completed
        );
        assert!(core.threads[&thread_id].active_turn_id.is_none());
    }

    #[test]
    fn starts_consecutive_turns_after_completion_and_isolates_threads() {
        let mut core = Core::new();
        let first_thread_id = start_thread(&mut core, 1);
        let second_thread_id = start_thread(&mut core, 2);

        let first = core
            .start_turn(CoreRequestId::new(3), first_thread_id.clone())
            .expect("first turn starts");
        let second = core
            .start_turn(CoreRequestId::new(4), first_thread_id.clone())
            .expect("second turn starts");
        let third = core
            .start_turn(CoreRequestId::new(5), second_thread_id.clone())
            .expect("third turn starts");

        assert_eq!(turn_id(&first).as_str(), "turn_0000000000000001");
        assert_eq!(turn_id(&second).as_str(), "turn_0000000000000002");
        assert_eq!(turn_id(&third).as_str(), "turn_0000000000000003");
        assert_eq!(core.turn_count(&first_thread_id), 2);
        assert_eq!(core.turn_count(&second_thread_id), 1);

        let item_ids = [&first, &second, &third]
            .map(|events| {
                let CoreEventKind::ItemStarted { item, .. } = &events[1].kind else {
                    panic!("expected item started");
                };
                item.id.as_str()
            })
            .to_vec();
        assert_eq!(
            item_ids,
            vec![
                "item_0000000000000001",
                "item_0000000000000002",
                "item_0000000000000003"
            ]
        );
    }

    #[test]
    fn consecutive_turns_are_allowed_after_each_durable_completion() {
        let mut core = Core::new();
        let thread_id = start_thread(&mut core, 1);
        let first = core
            .start_turn(CoreRequestId::new(2), thread_id.clone())
            .expect("turn starts");
        let second = core
            .start_turn(CoreRequestId::new(3), thread_id)
            .expect("next turn starts");
        assert_eq!(turn_id(&first).as_str(), "turn_0000000000000001");
        assert_eq!(turn_id(&second).as_str(), "turn_0000000000000002");
    }

    #[test]
    fn completed_turns_and_items_reject_additional_work() {
        let turn_id = TurnId::new("turn_completed");
        let item_id = ItemId::new("item_completed");
        let mut item = Item::new_agent_message(item_id.clone());
        item.complete().expect("item completes");
        assert_eq!(
            item.append_agent_message_delta("late"),
            Err(CoreError::ItemNotInProgress(item_id.clone()))
        );

        let mut turn = Turn::new(turn_id.clone(), CoreRequestId::new(1));
        turn.add_item(Item::new_agent_message(ItemId::new("item_active")))
            .expect("active item is stored");
        turn.complete_active_item_and_turn()
            .expect("turn completes");
        assert_eq!(
            turn.add_item(Item::new_agent_message(ItemId::new("item_late"))),
            Err(CoreError::TurnNotInProgress(turn_id))
        );
        assert_eq!(item.state, ItemState::Completed);
    }

    #[test]
    fn missing_thread_does_not_advance_turn_or_item_sequences() {
        let mut core = Core::new();
        let missing_thread_id = ThreadId::new("thr_missing");

        assert_eq!(
            core.start_turn(CoreRequestId::new(1), missing_thread_id.clone()),
            Err(CoreError::ThreadNotFound(missing_thread_id))
        );

        let thread_id = start_thread(&mut core, 2);
        let events = core
            .start_turn(CoreRequestId::new(3), thread_id)
            .expect("turn starts");
        assert_eq!(turn_id(&events).as_str(), "turn_0000000000000001");
        let CoreEventKind::ItemStarted { item, .. } = &events[1].kind else {
            panic!("expected item started");
        };
        assert_eq!(item.id.as_str(), "item_0000000000000001");
    }

    #[test]
    fn exhausted_turn_or_item_sequence_does_not_create_a_turn() {
        let mut turn_exhausted = Core::new();
        let thread_id = start_thread(&mut turn_exhausted, 1);
        turn_exhausted.last_turn_sequence = u64::MAX;
        assert_eq!(
            turn_exhausted.start_turn(CoreRequestId::new(2), thread_id.clone()),
            Err(CoreError::TurnIdExhausted)
        );
        assert_eq!(turn_exhausted.turn_count(&thread_id), 0);
        assert_eq!(turn_exhausted.last_item_sequence, 0);

        let mut item_exhausted = Core::new();
        let thread_id = start_thread(&mut item_exhausted, 1);
        item_exhausted.last_item_sequence = u64::MAX;
        assert_eq!(
            item_exhausted.start_turn(CoreRequestId::new(2), thread_id.clone()),
            Err(CoreError::ItemIdExhausted)
        );
        assert_eq!(item_exhausted.turn_count(&thread_id), 0);
        assert_eq!(item_exhausted.last_turn_sequence, 0);
    }

    #[test]
    fn resumes_a_persisted_completed_history() {
        let mut core = Core::new();
        let thread_id = start_thread(&mut core, 1);
        core.start_turn(CoreRequestId::new(2), thread_id.clone())
            .expect("turn starts");
        let snapshot = core
            .resume_thread(&thread_id)
            .expect("resume loaded thread");
        assert_eq!(snapshot.id, thread_id);
        assert_eq!(snapshot.turns.len(), 1);
        assert_eq!(snapshot.turns[0].id.as_str(), "turn_0000000000000001");
    }

    #[test]
    fn lists_durable_threads_without_loading_history_into_core_memory() {
        let mut core = Core::new();
        for request_id in 1..=3 {
            start_thread(&mut core, request_id);
        }
        let first = core.list_threads(None, 2).expect("first page");
        assert_eq!(
            first
                .data
                .iter()
                .map(|thread| thread.id.as_str())
                .collect::<Vec<_>>(),
            ["thr_0000000000000003", "thr_0000000000000002"]
        );
        let second = core
            .list_threads(first.next_cursor.as_ref(), 2)
            .expect("second page");
        assert_eq!(
            second
                .data
                .iter()
                .map(|thread| thread.id.as_str())
                .collect::<Vec<_>>(),
            ["thr_0000000000000001"]
        );
    }

    #[test]
    fn failed_thread_write_does_not_commit_memory_or_advance_ids() {
        let mut core = Core::with_repository(Box::new(FailingRepository {
            fail_create: true,
            fail_append: false,
            ..Default::default()
        }));

        assert_eq!(
            core.start_thread(CoreRequestId::new(1)),
            Err(CoreError::StateUnavailable)
        );
        assert_eq!(core.thread_count(), 0);
        assert_eq!(core.last_thread_sequence, 0);
    }

    #[test]
    fn failed_turn_write_does_not_commit_memory_or_advance_ids() {
        let mut core = Core::with_repository(Box::new(FailingRepository {
            fail_create: false,
            fail_append: true,
            ..Default::default()
        }));
        let thread_id = start_thread(&mut core, 1);

        assert_eq!(
            core.start_turn(CoreRequestId::new(2), thread_id.clone()),
            Err(CoreError::StateUnavailable)
        );
        assert_eq!(core.turn_count(&thread_id), 0);
        assert_eq!(core.last_turn_sequence, 0);
        assert_eq!(core.last_item_sequence, 0);
    }

    #[test]
    fn failed_archive_write_does_not_hide_the_in_memory_thread() {
        let mut core = Core::with_repository(Box::new(FailingRepository {
            fail_create: false,
            fail_append: false,
            ..Default::default()
        }));
        let thread_id = start_thread(&mut core, 1);

        assert_eq!(
            core.archive_thread(&thread_id),
            Err(CoreError::StateUnavailable)
        );
        assert!(core.contains_thread(&thread_id));
        core.start_turn(CoreRequestId::new(2), thread_id)
            .expect("thread stays active");
    }

    #[test]
    fn failed_unarchive_write_does_not_restore_the_thread_in_memory() {
        let thread_id = ThreadId::new("thr_0000000000000001");
        let mut threads = BTreeMap::new();
        threads.insert(
            thread_id.clone(),
            DurableThreadSnapshot {
                id: thread_id.clone(),
                turns: Vec::new(),
                lifecycle: DurableThreadLifecycle::Archived,
            },
        );
        let mut core = Core::with_repository(Box::new(FailingRepository {
            threads,
            ..Default::default()
        }));

        assert_eq!(
            core.unarchive_thread(&thread_id),
            Err(CoreError::StateUnavailable)
        );
        assert!(!core.contains_thread(&thread_id));
    }

    #[test]
    fn failed_delete_write_does_not_hide_the_in_memory_thread() {
        let mut core = Core::with_repository(Box::new(FailingRepository {
            fail_create: false,
            fail_append: false,
            ..Default::default()
        }));
        let thread_id = start_thread(&mut core, 1);

        assert_eq!(
            core.delete_thread(&thread_id),
            Err(CoreError::StateUnavailable)
        );
        assert!(core.contains_thread(&thread_id));
        core.start_turn(CoreRequestId::new(2), thread_id)
            .expect("thread stays active");
    }

    #[derive(Debug, Default)]
    struct FailingRepository {
        fail_create: bool,
        fail_append: bool,
        threads: BTreeMap<ThreadId, DurableThreadSnapshot>,
        sequences: IdSequences,
    }

    impl ThreadRepository for FailingRepository {
        fn id_sequences(&self) -> IdSequences {
            self.sequences
        }

        fn create_thread(&mut self, thread_id: &ThreadId) -> Result<(), RolloutError> {
            if self.fail_create {
                return Err(RolloutError::Poisoned);
            }
            self.threads.insert(
                thread_id.clone(),
                DurableThreadSnapshot {
                    id: thread_id.clone(),
                    turns: Vec::new(),
                    lifecycle: DurableThreadLifecycle::Active,
                },
            );
            Ok(())
        }

        fn append_completed_turn(
            &mut self,
            _thread_id: &ThreadId,
            _turn: &DurableTurnSnapshot,
        ) -> Result<(), RolloutError> {
            if self.fail_append {
                Err(RolloutError::Poisoned)
            } else {
                Ok(())
            }
        }

        fn archive_thread(&mut self, _thread_id: &ThreadId) -> Result<(), RolloutError> {
            Err(RolloutError::Poisoned)
        }

        fn unarchive_thread(&mut self, _thread_id: &ThreadId) -> Result<(), RolloutError> {
            Err(RolloutError::Poisoned)
        }

        fn delete_thread(&mut self, _thread_id: &ThreadId) -> Result<(), RolloutError> {
            Err(RolloutError::Poisoned)
        }

        fn load_thread(
            &self,
            thread_id: &ThreadId,
        ) -> Result<Option<DurableThreadSnapshot>, RolloutError> {
            Ok(self.threads.get(thread_id).cloned())
        }

        fn list_threads(
            &mut self,
            _cursor: Option<&ThreadId>,
            _limit: usize,
        ) -> Result<DurableThreadPage, RolloutError> {
            Err(RolloutError::Poisoned)
        }

        fn search_threads(
            &mut self,
            _query: &str,
            _cursor: Option<&ThreadId>,
            _limit: usize,
        ) -> Result<DurableThreadPage, RolloutError> {
            Err(RolloutError::Poisoned)
        }
    }
}
