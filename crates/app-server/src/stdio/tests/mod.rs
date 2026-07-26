use super::*;
use std::pin::Pin;
use std::task::Context;
use std::task::Poll;

struct StalledWriter;

impl AsyncWrite for StalledWriter {
    fn poll_write(
        self: Pin<&mut Self>,
        _context: &mut Context<'_>,
        _buffer: &[u8],
    ) -> Poll<io::Result<usize>> {
        Poll::Pending
    }

    fn poll_flush(self: Pin<&mut Self>, _context: &mut Context<'_>) -> Poll<io::Result<()>> {
        Poll::Pending
    }

    fn poll_shutdown(self: Pin<&mut Self>, _context: &mut Context<'_>) -> Poll<io::Result<()>> {
        Poll::Ready(Ok(()))
    }
}

#[tokio::test]
async fn malformed_json_returns_error_and_processing_continues() {
    let input = b"{broken\n{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"thread/start\"}\n";
    let reader = tokio::io::BufReader::new(&input[..]);
    let mut output = Vec::new();
    serve(reader, &mut output).await.expect("serve succeeds");
    let output = String::from_utf8(output).expect("UTF-8 output");
    let lines = output.lines().collect::<Vec<_>>();
    assert_eq!(lines.len(), 2);
    assert!(lines[0].contains(r#""code":-32700"#));
    assert!(lines[1].contains(r#""code":-32001"#));
}

#[tokio::test]
async fn stalled_stdout_times_out_instead_of_deadlocking_after_eof() {
    tokio::time::pause();
    let input = b"{broken\n";
    let reader = tokio::io::BufReader::new(&input[..]);
    let (runtime, events) = sugarcode_core::CoreRuntime::without_model(sugarcode_core::Core::new());
    let task = tokio::spawn(serve_with_events(
        reader,
        StalledWriter,
        Session::with_core(runtime),
        events,
    ));
    tokio::task::yield_now().await;
    tokio::time::advance(STDOUT_STALL_TIMEOUT + std::time::Duration::from_secs(1)).await;
    let error = task
        .await
        .expect("server task")
        .expect_err("stdout timeout");
    assert_eq!(error.kind(), io::ErrorKind::TimedOut);
}
