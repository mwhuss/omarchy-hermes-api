//! Bounded HTTP: reqwest client (redirect:manual), total-timeout requests,
//! Content-Length pre-checks and bounded body reads.

use futures_util::StreamExt;
use reqwest::{Client, Response, StatusCode};
use std::pin::Pin;
use std::sync::Arc;
use std::time::Duration;

use crate::util::*;
use serde_json::Value;

type ByteStream =
    Pin<Box<dyn futures_util::stream::Stream<Item = reqwest::Result<bytes::Bytes>> + Send>>;

pub struct BoundedResponse {
    pub status: u16,
    pub content_length: Option<String>,
    body: Option<ByteStream>,
}

/// Client with redirects disabled (JS `redirect: 'manual'`).
pub fn client() -> Arc<Client> {
    Arc::new(
        Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .expect("client build"),
    )
}

/// JS boundedFetch: request with a total timeout armed from start through
/// full body consumption. The timeout is passed into body reads so it stays
/// armed until the body is consumed (JS `boundedRelease`).
pub async fn bounded_fetch(
    client: &Arc<Client>,
    url: &str,
    method: reqwest::Method,
    headers: Vec<(String, String)>,
    body: Option<String>,
    _max_bytes: usize,
    timeout_ms: u64,
) -> Result<(BoundedResponse, u64), String> {
    let mut req = client.request(method.clone(), url);
    for (k, v) in &headers {
        req = req.header(k.as_str(), v.as_str());
    }
    if let Some(b) = body {
        req = req.body(b);
    }
    let built = req.build().map_err(|e| format!("{e}"))?;

    let res: Response =
        tokio::time::timeout(Duration::from_millis(timeout_ms), client.execute(built))
            .await
            .map_err(|_| format!("Request timed out after {timeout_ms} ms"))?
            .map_err(|e| format!("{e}"))?;

    let status = res.status().as_u16();
    let content_length = res
        .headers()
        .get(reqwest::header::CONTENT_LENGTH)
        .and_then(|v| v.to_str().ok())
        .map(|s| s.to_string());
    let stream: ByteStream = Box::pin(res.bytes_stream());
    Ok((
        BoundedResponse {
            status,
            content_length,
            body: Some(stream),
        },
        timeout_ms,
    ))
}

pub fn is_ok(status: u16) -> bool {
    StatusCode::from_u16(status)
        .map(|s| s.is_success())
        .unwrap_or(false)
}

impl BoundedResponse {
    /// JS `res.boundedRelease()` + body cancel: drop the stream so the
    /// process can exit promptly without reading the body.
    pub fn release(&mut self) {
        self.body = None;
    }
}

/// Validate Content-Length like JS readBoundedText/readBoundedJson.
fn check_content_length(cl: &Option<String>, max_bytes: usize) -> Result<(), String> {
    if let Some(cl) = cl {
        if cl.is_empty() || !cl.bytes().all(|b| b.is_ascii_digit()) {
            return Err("Invalid Content-Length header".into());
        }
        if cl.parse::<u64>().unwrap_or(u64::MAX) > max_bytes as u64 {
            return Err(format!(
                "Content-Length {cl} exceeds {max_bytes} byte limit"
            ));
        }
    }
    Ok(())
}

/// Read the whole body with a byte cap, under the remaining request timeout.
pub async fn read_bounded_body(
    res: &mut BoundedResponse,
    max_bytes: usize,
    timeout_ms: Option<u64>,
) -> Result<String, String> {
    let mut total = 0usize;
    let mut bytes_acc: Vec<u8> = Vec::new();
    let body = res.body.take();
    let mut stream = match body {
        Some(b) => b,
        None => return Ok(String::new()),
    };
    let read_fut = async {
        while let Some(chunk) = stream.next().await {
            let chunk = chunk.map_err(|e| format!("{e}"))?;
            total += chunk.len();
            if total > max_bytes {
                return Err(format!("Response body exceeds {max_bytes} byte limit"));
            }
            bytes_acc.extend_from_slice(&chunk);
        }
        Ok(())
    };
    match timeout_ms {
        Some(ms) => tokio::time::timeout(Duration::from_millis(ms), read_fut)
            .await
            .map_err(|_| format!("Request timed out after {ms} ms"))?,
        None => read_fut.await,
    }?;
    Ok(String::from_utf8_lossy(&bytes_acc).into_owned())
}

/// JS readBoundedText: Content-Length pre-check, bounded body read.
#[allow(dead_code)] // parity with the Node bridge helper surface
pub async fn read_bounded_text(
    res: &mut BoundedResponse,
    max_bytes: usize,
    timeout_ms: Option<u64>,
) -> Result<String, String> {
    check_content_length(&res.content_length, max_bytes)?;
    read_bounded_body(res, max_bytes, timeout_ms).await
}

/// JS readBoundedJson: Content-Length pre-check, bounded body, JSON.parse.
pub async fn read_bounded_json(
    res: &mut BoundedResponse,
    max_bytes: usize,
    timeout_ms: Option<u64>,
) -> Result<Value, String> {
    check_content_length(&res.content_length, max_bytes)?;
    let text = read_bounded_body(res, max_bytes, timeout_ms).await?;
    js_parse(&text).map_err(|_| "Invalid JSON in response body".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn content_length_validation() {
        assert!(check_content_length(&None, 10).is_ok());
        assert!(check_content_length(&Some("abc".into()), 10).is_err());
        assert!(check_content_length(&Some("-1".into()), 10).is_err());
        assert!(check_content_length(&Some("200000".into()), 65536)
            .unwrap_err()
            .contains("Content-Length 200000 exceeds 65536 byte limit"));
        assert!(check_content_length(&Some("10".into()), 10).is_ok());
    }

    #[tokio::test]
    async fn status_ok_semantics() {
        assert!(is_ok(200));
        assert!(is_ok(204));
        assert!(!is_ok(301));
        assert!(!is_ok(404));
        assert!(!is_ok(500));
    }
}
