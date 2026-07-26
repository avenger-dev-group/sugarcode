use crate::Session;
use crate::approval::PendingCommandApproval;
use std::io;
use tokio::io::AsyncBufRead;
use tokio::io::AsyncBufReadExt;
use tokio::io::AsyncWrite;
use tokio::io::AsyncWriteExt;
use tokio::sync::mpsc;

const STDOUT_QUEUE_CAPACITY: usize = 64;
const STDOUT_STALL_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(30);

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
    session: Session<C>,
    events: mpsc::Receiver<sugarcode_protocol::CoreEvent>,
) -> io::Result<()>
where
    R: AsyncBufRead + Unpin,
    W: AsyncWrite + Unpin + Send + 'static,
    C: sugarcode_core::CoreApi,
{
    serve_with_optional_approvals(reader, writer, session, events, None).await
}

pub(crate) async fn serve_with_events_and_approvals<R, W, C>(
    reader: R,
    writer: W,
    session: Session<C>,
    events: mpsc::Receiver<sugarcode_protocol::CoreEvent>,
    approvals: mpsc::Receiver<PendingCommandApproval>,
) -> io::Result<()>
where
    R: AsyncBufRead + Unpin,
    W: AsyncWrite + Unpin + Send + 'static,
    C: sugarcode_core::CoreApi,
{
    serve_with_optional_approvals(reader, writer, session, events, Some(approvals)).await
}

async fn serve_with_optional_approvals<R, W, C>(
    reader: R,
    writer: W,
    mut session: Session<C>,
    mut events: mpsc::Receiver<sugarcode_protocol::CoreEvent>,
    mut approvals: Option<mpsc::Receiver<PendingCommandApproval>>,
) -> io::Result<()>
where
    R: AsyncBufRead + Unpin,
    W: AsyncWrite + Unpin + Send + 'static,
    C: sugarcode_core::CoreApi,
{
    let (output_tx, mut output_rx) = mpsc::channel(STDOUT_QUEUE_CAPACITY);
    let mut writer_task = tokio::spawn(async move {
        let mut writer = writer;
        while let Some(message) = output_rx.recv().await {
            write_message(&mut writer, &message).await?;
        }
        writer.flush().await
    });
    let mut lines = reader.lines();
    let shutdown = loop {
        tokio::select! {
            biased;
            line = lines.next_line() => {
                let line = match line {
                    Ok(line) => line,
                    Err(error) => {
                        writer_task.abort();
                        let _ = shutdown_discard_events(&mut session, &mut events).await;
                        return Err(error);
                    }
                };
                let Some(line) = line else { break session.shutdown(); };
                for message in session.process_line(&line) {
                    if let Err(error) = queue_message(&output_tx, message).await {
                        writer_task.abort();
                        let _ = shutdown_discard_events(&mut session, &mut events).await;
                        return Err(error);
                    }
                }
            }
            event = events.recv() => {
                let Some(event) = event else {
                    break session.shutdown();
                };
                let messages = session.process_core_event(event)
                    .map_err(|_| io::Error::other("core event mapping failed"))?;
                for message in messages {
                    if let Err(error) = queue_message(&output_tx, message).await {
                        writer_task.abort();
                        let _ = shutdown_discard_events(&mut session, &mut events).await;
                        return Err(error);
                    }
                }
            }
            approval = receive_approval(&mut approvals) => {
                match approval {
                    Some(approval) => {
                        if let Some(message) = session.process_approval_request(approval)
                            && let Err(error) = queue_message(&output_tx, message).await
                        {
                            writer_task.abort();
                            let _ = shutdown_discard_events(&mut session, &mut events).await;
                            return Err(error);
                        }
                    }
                    None => approvals = None,
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
                        if let Err(error) = queue_message(&output_tx, message).await {
                            writer_task.abort();
                            let _ = shutdown_discard_events(&mut session, &mut events).await;
                            return Err(error);
                        }
                    }
                }
                break;
            }
            event = events.recv() => {
                let Some(event) = event else {
                    (&mut shutdown).await.map_err(io::Error::other)?;
                    break;
                };
                for message in session
                    .process_core_event(event)
                    .map_err(|_| io::Error::other("core event mapping failed"))?
                {
                    if let Err(error) = queue_message(&output_tx, message).await {
                        writer_task.abort();
                        let _ = shutdown_discard_events(&mut session, &mut events).await;
                        return Err(error);
                    }
                }
            }
        }
    }
    drop(output_tx);
    match tokio::time::timeout(STDOUT_STALL_TIMEOUT, &mut writer_task).await {
        Ok(result) => result.map_err(|_| io::Error::other("stdout writer task failed"))?,
        Err(_) => {
            writer_task.abort();
            Err(io::Error::new(
                io::ErrorKind::TimedOut,
                "stdout writer stalled",
            ))
        }
    }
}

async fn receive_approval(
    approvals: &mut Option<mpsc::Receiver<PendingCommandApproval>>,
) -> Option<PendingCommandApproval> {
    match approvals {
        Some(approvals) => approvals.recv().await,
        None => futures_util::future::pending().await,
    }
}

async fn queue_message(
    output: &mpsc::Sender<sugarcode_app_server_protocol::JsonRpcMessage>,
    message: sugarcode_app_server_protocol::JsonRpcMessage,
) -> io::Result<()> {
    match tokio::time::timeout(STDOUT_STALL_TIMEOUT, output.send(message)).await {
        Ok(Ok(())) => Ok(()),
        Ok(Err(_)) => Err(io::Error::new(
            io::ErrorKind::BrokenPipe,
            "stdout writer closed",
        )),
        Err(_) => Err(io::Error::new(
            io::ErrorKind::TimedOut,
            "stdout writer stalled",
        )),
    }
}

async fn shutdown_discard_events<C>(
    session: &mut Session<C>,
    events: &mut mpsc::Receiver<sugarcode_protocol::CoreEvent>,
) -> Result<(), sugarcode_core::CoreError>
where
    C: sugarcode_core::CoreApi,
{
    let shutdown = session.shutdown();
    tokio::pin!(shutdown);
    loop {
        tokio::select! {
            result = &mut shutdown => {
                while let Ok(event) = events.try_recv() {
                    let _ = session.process_core_event(event);
                }
                return result;
            }
            event = events.recv() => {
                let Some(event) = event else {
                    return (&mut shutdown).await;
                };
                let _ = session.process_core_event(event);
            }
        }
    }
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
#[path = "tests/stdio.rs"]
mod tests;
