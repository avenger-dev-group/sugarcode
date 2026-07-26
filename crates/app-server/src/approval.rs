use futures_util::FutureExt;
use futures_util::future::BoxFuture;
use sugarcode_core::CommandApprovalOutcome;
use sugarcode_core::CommandApprovalRequest;
use sugarcode_core::CommandApprovalRequester;
use tokio::sync::mpsc;
use tokio::sync::oneshot;

pub(crate) struct PendingCommandApproval {
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
