use crate::app::App;
use crate::app::Focus;
use crate::app::PendingApproval;
use sugarcode_core::CommandApprovalOutcome;
use tokio::sync::oneshot;

#[test]
fn unicode_paste_is_retained_and_wrong_focus_is_inert() {
    let mut app = App::fixture();
    app.handle_paste("你好 👋");
    assert_eq!(app.input, "你好 👋");

    app.focus = Focus::Threads;
    app.handle_paste("ignored");
    assert_eq!(app.input, "你好 👋");
}

#[tokio::test]
async fn pending_approval_is_denied_by_default() {
    let mut app = App::fixture();
    let (response, receiver) = oneshot::channel();
    app.approval = Some(PendingApproval::Command {
        detail: "dangerous command".to_string(),
        response,
    });

    app.deny_pending_approval();

    assert_eq!(receiver.await, Ok(CommandApprovalOutcome::Denied));
    assert!(app.approval.is_none());
    assert_eq!(app.status, "Denied");
}

#[test]
fn runtime_disconnect_is_recoverable_ui_state() {
    let mut app = App::fixture();
    app.runtime_disconnected();
    assert_eq!(app.status, "Runtime event stream disconnected");
    assert!(!app.should_quit());
}
