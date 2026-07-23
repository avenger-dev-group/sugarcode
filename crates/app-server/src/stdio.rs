use crate::Session;
use std::io;
use tokio::io::AsyncBufRead;
use tokio::io::AsyncBufReadExt;
use tokio::io::AsyncWrite;
use tokio::io::AsyncWriteExt;

pub async fn serve<R, W>(reader: R, mut writer: W) -> io::Result<()>
where
    R: AsyncBufRead + Unpin,
    W: AsyncWrite + Unpin,
{
    let mut lines = reader.lines();
    let mut session = Session::new();

    while let Some(line) = lines.next_line().await? {
        if let Some(message) = session.process_line(&line) {
            let encoded = serde_json::to_vec(&message).map_err(io::Error::other)?;
            writer.write_all(&encoded).await?;
            writer.write_all(b"\n").await?;
            writer.flush().await?;
        }
    }

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
