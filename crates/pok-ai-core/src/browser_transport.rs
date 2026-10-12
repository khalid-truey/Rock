//! One reusable, sequential CDP connection per browser session/tab.
//!
//! A command is never replayed after a transport error: input may already have
//! happened. Taking the socket out of the cache also makes cancellation safe;
//! a timed-out command cannot leave an unread response in the next call.
use futures::{SinkExt, StreamExt};
use serde_json::{Value, json};
use tokio::net::TcpStream;
use tokio_tungstenite::{MaybeTlsStream, WebSocketStream, connect_async, tungstenite::Message};

use crate::{PokError, Result};

#[derive(Default)]
pub(crate) struct CdpTransport {
    connection: Option<(String, WebSocketStream<MaybeTlsStream<TcpStream>>)>,
    sequence: u64,
}

impl CdpTransport {
    pub(crate) async fn call(
        &mut self,
        endpoint: &str,
        method: &str,
        params: Value,
    ) -> Result<Value> {
        let mut socket = match self.connection.take() {
            Some((cached, socket)) if cached == endpoint => socket,
            _ => {
                connect_async(endpoint)
                    .await
                    .map_err(|error| PokError::Tool(format!("CDP connection failed: {error}")))?
                    .0
            }
        };
        self.sequence += 1;
        let id = self.sequence;
        socket
            .send(Message::Text(
                serde_json::to_string(&json!({
                    "id": id, "method": method, "params": params,
                }))?
                .into(),
            ))
            .await
            .map_err(|error| PokError::Tool(format!("CDP request failed: {error}")))?;
        while let Some(message) = socket.next().await {
            let message =
                message.map_err(|error| PokError::Tool(format!("CDP response failed: {error}")))?;
            let Message::Text(text) = message else {
                continue;
            };
            let value: Value = serde_json::from_str(&text)?;
            if value.get("id").and_then(Value::as_u64) != Some(id) {
                continue;
            }
            // A protocol error is a completed response, so the transport is
            // still synchronized. Connection errors above discard it.
            self.connection = Some((endpoint.to_owned(), socket));
            if let Some(error) = value.get("error") {
                return Err(PokError::Tool(format!("CDP {method} failed: {error}")));
            }
            return Ok(value.get("result").cloned().unwrap_or(Value::Null));
        }
        Err(PokError::Tool(
            "CDP connection closed without a response; inspect the page before retrying input"
                .into(),
        ))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        sync::{
            Arc,
            atomic::{AtomicUsize, Ordering},
        },
        time::Duration,
    };

    async fn server() -> (String, Arc<AtomicUsize>, tokio::task::JoinHandle<()>) {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = format!("ws://{}", listener.local_addr().unwrap());
        let connections = Arc::new(AtomicUsize::new(0));
        let count = connections.clone();
        let task = tokio::spawn(async move {
            while let Ok((stream, _)) = listener.accept().await {
                count.fetch_add(1, Ordering::SeqCst);
                tokio::spawn(async move {
                    let mut socket = tokio_tungstenite::accept_async(stream).await.unwrap();
                    while let Some(Ok(Message::Text(text))) = socket.next().await {
                        let request: Value = serde_json::from_str(&text).unwrap();
                        if request["method"] == "Disconnect" {
                            break;
                        }
                        if request["method"] == "Slow" {
                            tokio::time::sleep(Duration::from_millis(100)).await;
                        }
                        let event = json!({"method":"Page.frameNavigated","params":{}});
                        if socket
                            .send(Message::Text(event.to_string().into()))
                            .await
                            .is_err()
                        {
                            break;
                        }
                        let response = if request["method"] == "Invalid" {
                            json!({"id":request["id"],"error":{"message":"unsupported"}})
                        } else {
                            json!({"id":request["id"],"result":{"method":request["method"]}})
                        };
                        if socket
                            .send(Message::Text(response.to_string().into()))
                            .await
                            .is_err()
                        {
                            break;
                        }
                    }
                });
            }
        });
        (address, connections, task)
    }

    #[tokio::test]
    async fn reuses_connections_skips_events_and_handles_protocol_errors() {
        let (url, count, task) = server().await;
        let mut transport = CdpTransport::default();
        for _ in 0..3 {
            assert_eq!(
                transport.call(&url, "Read", json!({})).await.unwrap()["method"],
                "Read"
            );
        }
        assert!(transport.call(&url, "Invalid", json!({})).await.is_err());
        assert!(transport.call(&url, "Read", json!({})).await.is_ok());
        assert_eq!(count.load(Ordering::SeqCst), 1);
        task.abort();
    }

    #[tokio::test]
    async fn cancelled_or_failed_commands_are_not_replayed_or_reused() {
        let (url, count, task) = server().await;
        let mut transport = CdpTransport::default();
        assert!(transport.call(&url, "Disconnect", json!({})).await.is_err());
        assert_eq!(
            count.load(Ordering::SeqCst),
            1,
            "failed command was replayed"
        );
        assert!(
            tokio::time::timeout(
                Duration::from_millis(20),
                transport.call(&url, "Slow", json!({}))
            )
            .await
            .is_err()
        );
        assert!(transport.connection.is_none());
        assert_eq!(
            transport.call(&url, "Read", json!({})).await.unwrap()["method"],
            "Read"
        );
        assert_eq!(count.load(Ordering::SeqCst), 3);
        task.abort();
    }

    #[tokio::test]
    async fn changing_tabs_uses_the_new_endpoint() {
        let (a, count_a, task_a) = server().await;
        let (b, count_b, task_b) = server().await;
        let mut transport = CdpTransport::default();
        for url in [&a, &b, &a] {
            transport.call(url, "Read", json!({})).await.unwrap();
        }
        assert_eq!(count_a.load(Ordering::SeqCst), 2);
        assert_eq!(count_b.load(Ordering::SeqCst), 1);
        task_a.abort();
        task_b.abort();
    }
}
