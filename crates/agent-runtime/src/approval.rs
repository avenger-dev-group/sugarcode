use futures_util::FutureExt;
use futures_util::future::BoxFuture;
use sugarcode_core::CommandApprovalOutcome;
use sugarcode_core::CommandApprovalRequest;
use sugarcode_core::CommandApprovalRequester;
use sugarcode_core::McpToolApprovalOutcome;
use sugarcode_core::McpToolApprovalRequest;
use sugarcode_core::McpToolApprovalRequester;
use tokio::sync::mpsc;
use tokio::sync::oneshot;

pub struct PendingCommandApproval {
    pub request: CommandApprovalRequest,
    pub response: oneshot::Sender<CommandApprovalOutcome>,
}

#[derive(Debug, Clone)]
pub(crate) struct ChannelCommandApprovalRequester {
    sender: mpsc::Sender<PendingCommandApproval>,
}

impl ChannelCommandApprovalRequester {
    pub(crate) fn channel(capacity: usize) -> (Self, mpsc::Receiver<PendingCommandApproval>) {
        let (sender, receiver) = mpsc::channel(capacity);
        (Self { sender }, receiver)
    }
}

impl CommandApprovalRequester for ChannelCommandApprovalRequester {
    fn request(
        &self,
        request: CommandApprovalRequest,
    ) -> BoxFuture<'static, CommandApprovalOutcome> {
        let sender = self.sender.clone();
        async move {
            let (response, receiver) = oneshot::channel();
            if sender
                .send(PendingCommandApproval { request, response })
                .await
                .is_err()
            {
                return CommandApprovalOutcome::ClientDisconnected;
            }
            receiver
                .await
                .unwrap_or(CommandApprovalOutcome::ClientDisconnected)
        }
        .boxed()
    }
}

pub struct PendingMcpToolApproval {
    pub request: McpToolApprovalRequest,
    pub response: oneshot::Sender<McpToolApprovalOutcome>,
}

#[derive(Debug, Clone)]
pub(crate) struct ChannelMcpToolApprovalRequester {
    sender: mpsc::Sender<PendingMcpToolApproval>,
}

impl ChannelMcpToolApprovalRequester {
    pub(crate) fn channel(capacity: usize) -> (Self, mpsc::Receiver<PendingMcpToolApproval>) {
        let (sender, receiver) = mpsc::channel(capacity);
        (Self { sender }, receiver)
    }
}

impl McpToolApprovalRequester for ChannelMcpToolApprovalRequester {
    fn request(
        &self,
        request: McpToolApprovalRequest,
    ) -> BoxFuture<'static, McpToolApprovalOutcome> {
        let sender = self.sender.clone();
        async move {
            let (response, receiver) = oneshot::channel();
            if sender
                .send(PendingMcpToolApproval { request, response })
                .await
                .is_err()
            {
                return McpToolApprovalOutcome::ClientDisconnected;
            }
            receiver
                .await
                .unwrap_or(McpToolApprovalOutcome::ClientDisconnected)
        }
        .boxed()
    }
}
