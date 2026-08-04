use crate::CoreItemSnapshot;
use crate::ItemId;
use crate::ThreadId;
use crate::TurnId;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct CoreRequestId(u64);

impl CoreRequestId {
    pub const fn new(value: u64) -> Self {
        Self(value)
    }

    pub const fn get(self) -> u64 {
        self.0
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CoreEvent {
    pub request_id: CoreRequestId,
    pub kind: CoreEventKind,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CoreEventKind {
    ThreadStarted {
        thread_id: ThreadId,
    },
    ThreadTitleUpdated {
        thread_id: ThreadId,
        title: String,
    },
    TurnStarted {
        thread_id: ThreadId,
        turn_id: TurnId,
    },
    ItemStarted {
        thread_id: ThreadId,
        turn_id: TurnId,
        item: CoreItemSnapshot,
    },
    AgentOutputDelta {
        thread_id: ThreadId,
        turn_id: TurnId,
        output: CoreAgentOutputRef,
        delta: String,
    },
    AgentOutputResolved {
        thread_id: ThreadId,
        turn_id: TurnId,
        output: CoreAgentOutputRef,
        item: CoreItemSnapshot,
    },
    AgentOutputDiscarded {
        thread_id: ThreadId,
        turn_id: TurnId,
        output: CoreAgentOutputRef,
    },
    AgentMessageDelta {
        thread_id: ThreadId,
        turn_id: TurnId,
        item_id: ItemId,
        delta: String,
    },
    ItemCompleted {
        thread_id: ThreadId,
        turn_id: TurnId,
        item: CoreItemSnapshot,
    },
    TokenUsageUpdated {
        thread_id: ThreadId,
        turn_id: TurnId,
        usage: CoreTokenUsage,
    },
    Warning {
        thread_id: ThreadId,
        turn_id: TurnId,
        code: CoreWarningCode,
    },
    TurnCompleted {
        thread_id: ThreadId,
        turn_id: TurnId,
    },
    TurnFailed {
        thread_id: ThreadId,
        turn_id: TurnId,
        error: CoreTurnError,
    },
    TurnInterrupted {
        thread_id: ThreadId,
        turn_id: TurnId,
    },
    RuntimeFailed,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CoreWarningCode {
    ProviderManagedContinuationFallback,
    HistoricalContextDowngraded,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CoreTokenUsageSource {
    Provider,
    Estimated,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct CoreTokenUsageSample {
    pub input_tokens: Option<u64>,
    pub cached_input_tokens: Option<u64>,
    pub output_tokens: Option<u64>,
    pub reasoning_tokens: Option<u64>,
    pub total_tokens: Option<u64>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CoreTokenUsage {
    pub last_request: CoreTokenUsageSample,
    pub turn_total: CoreTokenUsageSample,
    pub request_count: u64,
    pub context_window_tokens: u32,
    pub source: CoreTokenUsageSource,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct CoreAgentOutputRef {
    pub response_ordinal: u64,
    pub output_index: u32,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CoreTurnError {
    pub kind: CoreTurnErrorKind,
    pub retryable: bool,
    pub provider: Option<CoreProviderErrorMetadata>,
    pub protocol: Option<CoreModelProtocolDiagnostic>,
    pub tool_schema: Option<CoreToolSchemaError>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CoreModelProtocolDiagnostic {
    pub stage: CoreModelProtocolStage,
    pub code: CoreModelProtocolCode,
    pub event_type: Option<String>,
    pub shape_sha256: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CoreModelProtocolStage {
    StreamEvent,
    ResponseAssembly,
    OutputNormalization,
    RuntimeClassification,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CoreModelProtocolCode {
    WireMismatch,
    InvalidEventShape,
    AmbiguousOutputReconciliation,
    MalformedToolCall,
    TerminalLifecycleViolation,
    ContinuationOutputMismatch,
    OutputIndexMismatch,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CoreProviderErrorMetadata {
    pub http_status: u16,
    pub code: Option<String>,
    pub request_id: Option<String>,
    pub retry_after: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CoreToolSchemaError {
    pub tool_name: String,
    pub reason: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CoreTurnErrorKind {
    Authentication,
    ContextWindowExceeded,
    InvalidRequest,
    RateLimited,
    Timeout,
    Transport,
    Disconnected,
    Server,
    Protocol,
    Incomplete,
    Filtered,
    UnsupportedOutput,
    UnsupportedToolArguments,
    ProviderRequestTooLarge,
    ProviderResponseTooLarge,
    OutputTooLarge,
    StateUnavailable,
}
