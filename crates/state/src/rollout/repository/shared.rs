use super::*;
use std::sync::Arc;
use std::sync::Mutex;

#[derive(Clone, Debug)]
pub struct RolloutRepositoryStore {
    inner: Arc<Mutex<RolloutRepository>>,
}

impl RolloutRepositoryStore {
    pub fn open(home: &SugarCodeHome) -> Result<Self, RolloutError> {
        Ok(Self {
            inner: Arc::new(Mutex::new(RolloutRepository::open(home)?)),
        })
    }

    pub fn diagnostics(&self) -> Vec<String> {
        let repository = self
            .inner
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        repository
            .diagnostics()
            .iter()
            .map(ToString::to_string)
            .chain(
                repository
                    .projection_diagnostics()
                    .iter()
                    .map(ToString::to_string),
            )
            .chain(
                repository
                    .search_projection_diagnostics()
                    .iter()
                    .map(ToString::to_string),
            )
            .collect()
    }

    pub fn workspace(&self, binding_id: Option<&str>) -> WorkspaceRolloutRepository {
        WorkspaceRolloutRepository {
            store: self.clone(),
            binding_id: binding_id.map(str::to_owned),
        }
    }
}

#[derive(Clone, Debug)]
pub struct WorkspaceRolloutRepository {
    store: RolloutRepositoryStore,
    binding_id: Option<String>,
}

impl WorkspaceRolloutRepository {
    fn with_repository<T>(
        &self,
        operation: impl FnOnce(&mut RolloutRepository) -> Result<T, RolloutError>,
    ) -> Result<T, RolloutError> {
        let mut repository = self
            .store
            .inner
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let previous = repository.active_workspace_binding_id.clone();
        repository.set_active_workspace_binding(self.binding_id.as_deref());
        let result = operation(&mut repository);
        repository.set_active_workspace_binding(previous.as_deref());
        result
    }
}

impl ThreadRepository for WorkspaceRolloutRepository {
    fn create_thread(&mut self, thread_id: &ThreadId) -> Result<(), RolloutError> {
        self.with_repository(|repository| repository.create_thread(thread_id))
    }

    fn create_thread_with_origin(
        &mut self,
        thread_id: &ThreadId,
        origin: &DurableThreadOrigin,
    ) -> Result<(), RolloutError> {
        self.with_repository(|repository| repository.create_thread_with_origin(thread_id, origin))
    }

    fn create_thread_snapshot(
        &mut self,
        snapshot: &DurableThreadSnapshot,
    ) -> Result<(), RolloutError> {
        self.with_repository(|repository| repository.create_thread_snapshot(snapshot))
    }

    fn append_completed_turn(
        &mut self,
        thread_id: &ThreadId,
        turn: &DurableTurnSnapshot,
    ) -> Result<(), RolloutError> {
        self.with_repository(|repository| repository.append_completed_turn(thread_id, turn))
    }

    fn begin_turn(
        &mut self,
        thread_id: &ThreadId,
        turn: &DurableTurnSnapshot,
    ) -> Result<(), RolloutError> {
        self.with_repository(|repository| repository.begin_turn(thread_id, turn))
    }

    fn finish_turn(
        &mut self,
        thread_id: &ThreadId,
        turn: &DurableTurnSnapshot,
    ) -> Result<(), RolloutError> {
        self.with_repository(|repository| repository.finish_turn(thread_id, turn))
    }

    fn append_turn_item(
        &mut self,
        thread_id: &ThreadId,
        turn_id: &sugarcode_protocol::TurnId,
        item: &DurableItemSnapshot,
    ) -> Result<(), RolloutError> {
        self.with_repository(|repository| repository.append_turn_item(thread_id, turn_id, item))
    }

    fn complete_turn_item(
        &mut self,
        thread_id: &ThreadId,
        turn_id: &sugarcode_protocol::TurnId,
        item: &DurableItemSnapshot,
    ) -> Result<(), RolloutError> {
        self.with_repository(|repository| repository.complete_turn_item(thread_id, turn_id, item))
    }

    fn archive_thread(&mut self, thread_id: &ThreadId) -> Result<(), RolloutError> {
        self.with_repository(|repository| repository.archive_thread(thread_id))
    }

    fn unarchive_thread(&mut self, thread_id: &ThreadId) -> Result<(), RolloutError> {
        self.with_repository(|repository| repository.unarchive_thread(thread_id))
    }

    fn delete_thread(&mut self, thread_id: &ThreadId) -> Result<(), RolloutError> {
        self.with_repository(|repository| repository.delete_thread(thread_id))
    }

    fn load_thread(
        &self,
        thread_id: &ThreadId,
    ) -> Result<Option<DurableThreadSnapshot>, RolloutError> {
        self.with_repository(|repository| repository.load_thread(thread_id))
    }

    fn list_descendants(
        &self,
        parent_thread_id: &ThreadId,
    ) -> Result<Vec<DurableThreadSnapshot>, RolloutError> {
        self.with_repository(|repository| repository.list_descendants(parent_thread_id))
    }

    fn list_threads(
        &mut self,
        cursor: Option<&ThreadId>,
        limit: usize,
    ) -> Result<DurableThreadPage, RolloutError> {
        self.with_repository(|repository| repository.list_threads(cursor, limit))
    }

    fn search_threads(
        &mut self,
        query: &str,
        cursor: Option<&ThreadId>,
        limit: usize,
    ) -> Result<DurableThreadPage, RolloutError> {
        self.with_repository(|repository| repository.search_threads(query, cursor, limit))
    }
}
