use futures_util::future::BoxFuture;
use sugarcode_core::CoreApi;
use sugarcode_core::CoreError;
use sugarcode_core::CoreUserContentPart;
use sugarcode_core::TurnInterruptOutcome;
use sugarcode_core::TurnStartOutcome;
use sugarcode_protocol::CoreEvent;
use sugarcode_protocol::CoreRequestId;
use sugarcode_protocol::ThreadId;
use sugarcode_protocol::TurnId;
use sugarcode_state::DurableThreadPage;
use sugarcode_state::DurableThreadSnapshot;

#[derive(Debug)]
pub struct AgentSurfaceSession<C> {
    core: C,
    last_request_sequence: u64,
}

impl<C> AgentSurfaceSession<C>
where
    C: CoreApi,
{
    pub fn new(core: C) -> Self {
        Self {
            core,
            last_request_sequence: 0,
        }
    }

    pub fn start_thread(&mut self) -> Result<CoreEvent, CoreError> {
        let request_id = self.next_request_id()?;
        let event = self.core.start_thread(request_id)?;
        if event.request_id != request_id {
            return Err(CoreError::Internal(
                "core thread event correlation mismatch".to_string(),
            ));
        }
        Ok(event)
    }

    pub fn contains_thread(&self, thread_id: &ThreadId) -> bool {
        self.core.contains_thread(thread_id)
    }

    pub fn list_threads(
        &mut self,
        cursor: Option<&ThreadId>,
        limit: usize,
    ) -> Result<DurableThreadPage, CoreError> {
        self.core.list_threads(cursor, limit)
    }

    pub fn search_threads(
        &mut self,
        query: &str,
        cursor: Option<&ThreadId>,
        limit: usize,
    ) -> Result<DurableThreadPage, CoreError> {
        self.core.search_threads(query, cursor, limit)
    }

    pub fn resume_thread(
        &mut self,
        thread_id: &ThreadId,
    ) -> Result<DurableThreadSnapshot, CoreError> {
        self.core.resume_thread(thread_id)
    }

    pub fn list_descendants(
        &mut self,
        thread_id: &ThreadId,
    ) -> Result<Vec<DurableThreadSnapshot>, CoreError> {
        self.core.list_descendants(thread_id)
    }

    pub fn archive_thread(&mut self, thread_id: &ThreadId) -> Result<(), CoreError> {
        self.core.archive_thread(thread_id)
    }

    pub fn unarchive_thread(&mut self, thread_id: &ThreadId) -> Result<(), CoreError> {
        self.core.unarchive_thread(thread_id)
    }

    pub fn delete_thread(&mut self, thread_id: &ThreadId) -> Result<(), CoreError> {
        self.core.delete_thread(thread_id)
    }

    pub fn fork_thread(
        &mut self,
        thread_id: &ThreadId,
    ) -> Result<DurableThreadSnapshot, CoreError> {
        self.core.fork_thread(thread_id)
    }

    pub fn start_text_turn(
        &mut self,
        thread_id: ThreadId,
        input: Option<String>,
    ) -> Result<(CoreRequestId, TurnStartOutcome), CoreError> {
        self.start_text_turn_with_model(thread_id, input, None)
    }

    pub fn start_text_turn_with_model(
        &mut self,
        thread_id: ThreadId,
        input: Option<String>,
        model_profile_id: Option<String>,
    ) -> Result<(CoreRequestId, TurnStartOutcome), CoreError> {
        let request_id = self.next_request_id()?;
        let outcome =
            self.core
                .start_text_turn_with_model(request_id, thread_id, input, model_profile_id)?;
        Ok((request_id, outcome))
    }

    pub fn start_content_turn_with_model(
        &mut self,
        thread_id: ThreadId,
        input: Option<Vec<CoreUserContentPart>>,
        model_profile_id: Option<String>,
    ) -> Result<(CoreRequestId, TurnStartOutcome), CoreError> {
        let request_id = self.next_request_id()?;
        let outcome = self.core.start_content_turn_with_model(
            request_id,
            thread_id,
            input,
            model_profile_id,
        )?;
        Ok((request_id, outcome))
    }

    pub fn interrupt_turn(
        &mut self,
        thread_id: &ThreadId,
        turn_id: &TurnId,
    ) -> Result<TurnInterruptOutcome, CoreError> {
        self.core.interrupt_turn(thread_id, turn_id)
    }

    pub fn shutdown(&mut self) -> BoxFuture<'static, Result<(), CoreError>> {
        self.core.shutdown()
    }

    fn next_request_id(&mut self) -> Result<CoreRequestId, CoreError> {
        let sequence = self
            .last_request_sequence
            .checked_add(1)
            .ok_or_else(|| CoreError::Internal("surface request sequence exhausted".to_string()))?;
        self.last_request_sequence = sequence;
        Ok(CoreRequestId::new(sequence))
    }
}
