use crate::Session;
use std::io;
use tokio::io::AsyncBufRead;
use tokio::io::AsyncBufReadExt;
use tokio::io::AsyncWrite;
use tokio::io::AsyncWriteExt;
use tokio::sync::mpsc;

const STDOUT_QUEUE_CAPACITY: usize = 64;

pub async fn serve<R, W>(reader: R, writer: W) -> io::Result<()>
where
    R: AsyncBufRead + Unpin,
    W: AsyncWrite + Unpin,
{
    serve_with_session(reader, writer, Session::new()).await
}

pub async fn serve_with_events<R, W, C>(
    reader: R,
    writer: W,
    mut session: Session<C>,
    mut events: mpsc::Receiver<sugarcode_protocol::CoreEvent>,
) -> io::Result<()>
where
    R: AsyncBufRead + Unpin,
    W: AsyncWrite + Unpin + Send + 'static,
    C: sugarcode_core::CoreApi,
{
    let (output_tx, mut output_rx) = mpsc::channel(STDOUT_QUEUE_CAPACITY);
    let writer_task = tokio::spawn(async move {
        let mut writer = writer;
        while let Some(message) = output_rx.recv().await {
            write_message(&mut writer, &message).await?;
        }
        writer.flush().await
    });
    let mut lines = reader.lines();
    let shutdown = loop {
        tokio::select! {
            line = lines.next_line() => {
                let Some(line) = line? else {
                    break session.shutdown();
                };
                for message in session.process_line(&line) {
                    output_tx.send(message).await.map_err(|_| {
                        io::Error::new(io::ErrorKind::BrokenPipe, "stdout writer closed")
                    })?;
                }
            }
            event = events.recv() => {
                let Some(event) = event else {
                    break session.shutdown();
                };
                let messages = session.process_core_event(event)
                    .map_err(|_| io::Error::other("core event mapping failed"))?;
                for message in messages {
                    output_tx.send(message).await.map_err(|_| {
                        io::Error::new(io::ErrorKind::BrokenPipe, "stdout writer closed")
                    })?;
                }
            }
        }
    };
    tokio::pin!(shutdown);
    loop {
        tokio::select! {
            result = &mut shutdown => {
                result.map_err(io::Error::other)?;
                while let Ok(event) = events.try_recv() {
                    for message in session
                        .process_core_event(event)
                        .map_err(|_| io::Error::other("core event mapping failed"))?
                    {
                        output_tx.send(message).await.map_err(|_| {
                            io::Error::new(io::ErrorKind::BrokenPipe, "stdout writer closed")
                        })?;
                    }
                }
                break;
            }
            event = events.recv() => {
                let Some(event) = event else {
                    continue;
                };
                for message in session
                    .process_core_event(event)
                    .map_err(|_| io::Error::other("core event mapping failed"))?
                {
                    output_tx.send(message).await.map_err(|_| {
                        io::Error::new(io::ErrorKind::BrokenPipe, "stdout writer closed")
                    })?;
                }
            }
        }
    }
    drop(output_tx);
    writer_task
        .await
        .map_err(|_| io::Error::other("stdout writer task failed"))?
}

pub async fn serve_with_session<R, W, C>(
    reader: R,
    mut writer: W,
    mut session: Session<C>,
) -> io::Result<()>
where
    R: AsyncBufRead + Unpin,
    W: AsyncWrite + Unpin,
    C: sugarcode_core::CoreApi,
{
    let mut lines = reader.lines();

    while let Some(line) = lines.next_line().await? {
        for message in session.process_line(&line) {
            write_message(&mut writer, &message).await?;
        }
    }

    writer.flush().await
}

async fn write_message<W>(
    writer: &mut W,
    message: &sugarcode_app_server_protocol::JsonRpcMessage,
) -> io::Result<()>
where
    W: AsyncWrite + Unpin,
{
    let encoded = serde_json::to_vec(message).map_err(io::Error::other)?;
    writer.write_all(&encoded).await?;
    writer.write_all(b"\n").await?;
    writer.flush().await
}

#[cfg(test)]
mod tests {
    use super::*;

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
}
