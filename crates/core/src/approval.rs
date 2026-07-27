use futures_util::future::BoxFuture;
use std::fmt;
use sugarcode_protocol::ThreadId;
use sugarcode_protocol::TurnId;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CommandApprovalRequest {
    pub approval_id: String,
    pub thread_id: ThreadId,
    pub turn_id: TurnId,
    pub call_id: String,
    pub command: String,
    pub arguments: Vec<String>,
    pub cwd: String,
    pub environment_policy: String,
    pub sandboxed: bool,
    pub sandbox_policy: sugarcode_protocol::CoreCommandSandboxPolicy,
    pub workspace_write_policy: Option<sugarcode_protocol::CoreCommandWorkspaceWritePolicy>,
    pub network_policy: sugarcode_protocol::CoreCommandNetworkPolicy,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CommandApprovalOutcome {
    Approved,
    Denied,
    TimedOut,
    Unsupported,
    ClientDisconnected,
}

pub trait CommandApprovalRequester: fmt::Debug + Send + Sync {
    fn request(
        &self,
        request: CommandApprovalRequest,
    ) -> BoxFuture<'static, CommandApprovalOutcome>;
}
