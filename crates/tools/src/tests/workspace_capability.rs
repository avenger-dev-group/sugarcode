use super::WorkspaceTool;
use std::sync::Arc;
use std::time::Duration;

#[tokio::test]
async fn derived_scopes_share_one_serial_workspace_write_gate() {
    let directory = tempfile::tempdir().expect("create workspace");
    std::fs::create_dir(directory.path().join("nested")).expect("create nested scope");
    let workspace = Arc::new(WorkspaceTool::open(directory.path()).expect("open workspace"));
    let nested = Arc::new(
        workspace
            .derive_scope("nested")
            .expect("derive nested scope"),
    );
    let first = workspace.acquire_write_async().await;
    let (acquired_tx, mut acquired_rx) = tokio::sync::mpsc::channel(1);

    let waiting = tokio::spawn(async move {
        let _second = nested.acquire_write_async().await;
        acquired_tx.send(()).await.expect("report acquisition");
    });

    assert!(
        tokio::time::timeout(Duration::from_millis(50), acquired_rx.recv())
            .await
            .is_err(),
        "a sibling scope acquired the write gate concurrently"
    );
    drop(first);
    tokio::time::timeout(Duration::from_secs(1), acquired_rx.recv())
        .await
        .expect("write gate released")
        .expect("acquisition reported");
    waiting.await.expect("waiting task completed");
}
