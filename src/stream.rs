//! stream-chat: OpenAI-compatible SSE streaming with Hermes custom events,
//! idle/duration ceilings, and bounded tool-progress forwarding.

use crate::config::*;
use crate::util::*;
use futures_util::StreamExt;
use reqwest::Method;
use serde_json::{json, Value};
use std::time::Duration;
use tokio::time::Instant;

pub struct StreamOptions {
    pub session_id: Option<String>,
    pub prompt: String,
    pub model: String,
    pub history: Vec<Value>,
    pub system_prompt: String,
    pub endpoint: Option<String>,
    pub profile: Option<String>,
}

fn env_ms(key: &str, default: u64) -> u64 {
    std::env::var(key)
        .ok()
        .and_then(|s| js_parse_int(&json!(s)))
        .filter(|v| *v > 0.0)
        .map(|v| v as u64)
        .unwrap_or(default)
}

pub async fn handle_stream_chat(opts: StreamOptions) -> Result<(), String> {
    if opts.prompt.is_empty() {
        json_line(&obj(vec![
            ("type", json!("error")),
            ("error", json!("Prompt is required")),
        ]));
        return Ok(());
    }

    let sid = parse_session_identifier(
        opts.session_id.as_deref(),
        opts.endpoint.as_deref(),
        opts.profile.as_deref(),
    );
    let cfg = resolve_config(sid.endpoint_id.as_deref(), sid.profile_name.as_deref())?;

    let mut resolved_session_id = sid.raw_session_id.clone();
    if resolved_session_id.trim().is_empty() {
        resolved_session_id = format!("api-{}-{}", to_base36(now_ms()), rand_base36(5));
    }

    let composite_id = format!(
        "{}:{}:{}",
        cfg.endpoint_id, cfg.profile_name, resolved_session_id
    );

    let mut messages: Vec<Value> = Vec::new();
    let sys = opts.system_prompt.trim().to_string();
    if !sys.is_empty() {
        messages.push(obj(vec![
            ("role", json!("system")),
            ("content", json!(sys)),
        ]));
    }
    for m in &opts.history {
        let role = m
            .get("role")
            .filter(|r| truthy(r))
            .cloned()
            .unwrap_or(Value::Null);
        let content = m
            .get("content")
            .filter(|c| truthy(c))
            .cloned()
            .unwrap_or(Value::Null);
        if truthy(&role) && truthy(&content) {
            messages.push(obj(vec![("role", role), ("content", content)]));
        }
    }
    messages.push(obj(vec![
        ("role", json!("user")),
        ("content", json!(opts.prompt.clone())),
    ]));

    let is_explicit_composite = opts
        .session_id
        .as_ref()
        .map(|s| s.contains(':'))
        .unwrap_or(false);
    let emit_session_id = if is_explicit_composite {
        composite_id.clone()
    } else {
        resolved_session_id.clone()
    };

    json_line(&obj(vec![
        ("type", json!("start")),
        ("session_id", json!(emit_session_id.clone())),
        ("raw_session_id", json!(resolved_session_id.clone())),
        ("endpoint_id", json!(cfg.endpoint_id.clone())),
        ("endpoint_name", json!(cfg.endpoint_name.clone())),
        ("profile_name", json!(cfg.profile_name.clone())),
        ("composite_id", json!(composite_id.clone())),
        (
            "model",
            json!(if opts.model.is_empty() {
                "hermes-agent".to_string()
            } else {
                opts.model.clone()
            }),
        ),
    ]));

    let run = run_stream(
        &opts,
        &cfg,
        &emit_session_id,
        &resolved_session_id,
        &composite_id,
        messages,
    )
    .await;
    match run {
        Ok(()) => {}
        Err(err) => {
            json_line(&obj(vec![
                ("type", json!("error")),
                ("session_id", json!(emit_session_id.clone())),
                ("raw_session_id", json!(resolved_session_id.clone())),
                ("composite_id", json!(composite_id.clone())),
                ("error", json!(err)),
            ]));
        }
    }
    Ok(())
}

struct StreamState {
    full_text: String,
    full_reasoning: String,
    usage: Option<Value>,
    tool_event_count: usize,
    tool_events_truncated: bool,
    current_event_type: String,
    line_buffer: String,
}

fn emit_tool_progress(
    st: &mut StreamState,
    emit_session_id: &str,
    resolved_session_id: &str,
    composite_id: &str,
    ev: &Value,
) {
    if st.tool_events_truncated {
        return;
    }
    if st.tool_event_count >= MAX_TOOL_EVENTS {
        st.tool_events_truncated = true;
        json_line(&obj(vec![
            ("type", json!("tool_progress")),
            ("session_id", json!(emit_session_id)),
            ("raw_session_id", json!(resolved_session_id)),
            ("composite_id", json!(composite_id)),
            ("tool", json!("tool")),
            ("status", json!("truncated")),
            ("label", json!("Tool event limit reached")),
            ("emoji", json!("")),
            ("id", json!("")),
        ]));
        return;
    }
    let get_str = |v: &Value, keys: &[&str], default: &str| -> String {
        for k in keys {
            if let Some(v) = v.get(*k).filter(|v| truthy(v)) {
                return js_string(v);
            }
        }
        default.to_string()
    };
    let tool = get_str(ev, &["tool", "name"], "tool");
    let emoji = get_str(ev, &["emoji"], "");
    let mut label = get_str(ev, &["label", "detail", "message"], "");
    let mut status = get_str(ev, &["status"], "running");
    let mut id = get_str(ev, &["toolCallId", "id"], "");

    let fixed = tool.len() + emoji.len();
    let mut total = fixed + label.len() + status.len() + id.len();
    if total > MAX_TOOL_EVENT_BYTES {
        if fixed > MAX_TOOL_EVENT_BYTES {
            return;
        }
        label = truncate_to_bytes(
            &label,
            MAX_TOOL_EVENT_BYTES.saturating_sub(fixed + status.len() + id.len()),
        );
        total = fixed + label.len() + status.len() + id.len();
        if total > MAX_TOOL_EVENT_BYTES {
            status = truncate_to_bytes(
                &status,
                MAX_TOOL_EVENT_BYTES.saturating_sub(fixed + label.len() + id.len()),
            );
            total = fixed + label.len() + status.len() + id.len();
        }
        if total > MAX_TOOL_EVENT_BYTES {
            id = truncate_to_bytes(
                &id,
                MAX_TOOL_EVENT_BYTES.saturating_sub(fixed + label.len() + status.len()),
            );
            total = fixed + label.len() + status.len() + id.len();
            if total > MAX_TOOL_EVENT_BYTES {
                return;
            }
        }
    }
    st.tool_event_count += 1;
    json_line(&obj(vec![
        ("type", json!("tool_progress")),
        ("session_id", json!(emit_session_id)),
        ("raw_session_id", json!(resolved_session_id)),
        ("composite_id", json!(composite_id)),
        ("tool", json!(tool)),
        ("status", json!(status)),
        ("label", json!(label)),
        ("emoji", json!(emoji)),
        ("id", json!(id)),
    ]));
}

fn emit_reasoning_delta(
    st: &mut StreamState,
    emit_session_id: &str,
    resolved_session_id: &str,
    composite_id: &str,
    reasoning_text: &str,
) {
    if st.full_reasoning.chars().count() < MAX_STREAM_CHARS {
        st.full_reasoning.push_str(reasoning_text);
        json_line(&obj(vec![
            ("type", json!("reasoning_delta")),
            ("session_id", json!(emit_session_id)),
            ("raw_session_id", json!(resolved_session_id)),
            ("composite_id", json!(composite_id)),
            ("content", json!(reasoning_text)),
        ]));
    }
}

fn process_sse_line(
    st: &mut StreamState,
    emit_session_id: &str,
    resolved_session_id: &str,
    composite_id: &str,
    line: &str,
) {
    let trimmed = line.trim();
    if trimmed.is_empty() {
        st.current_event_type = "message".to_string();
        return;
    }
    if trimmed.starts_with(':') {
        return;
    }
    if trimmed.starts_with("event:") {
        st.current_event_type = trimmed
            .strip_prefix("event:")
            .unwrap_or("")
            .trim()
            .to_string();
        return;
    }
    if !trimmed.starts_with("data:") {
        return;
    }
    let data_str = trimmed.strip_prefix("data:").unwrap_or("").trim();
    if data_str == "[DONE]" {
        return;
    }
    let chunk = match js_parse(data_str) {
        Ok(c) => c,
        Err(_) => return,
    };

    // Usage capture from any chunk.
    let usage_candidate: Option<Value> = chunk
        .get("usage")
        .filter(|u| u.is_object())
        .cloned()
        .or_else(|| {
            chunk
                .get("choices")
                .and_then(|c| c.as_array())
                .and_then(|a| a.first())
                .and_then(|c0| c0.get("usage"))
                .filter(|u| u.is_object())
                .cloned()
        });
    if let Some(uc) = usage_candidate {
        let cap = |k: &str, fallback: Option<i64>| -> i64 {
            match uc.get(k).and_then(|v| v.as_f64()) {
                Some(f) if f.is_finite() && f >= 0.0 => f.floor() as i64,
                _ => fallback.unwrap_or(0),
            }
        };
        let pt = cap("prompt_tokens", None);
        let ct = cap("completion_tokens", None);
        let tt = cap("total_tokens", Some(pt + ct));
        st.usage = Some(obj(vec![
            ("prompt_tokens", json!(pt)),
            ("completion_tokens", json!(ct)),
            ("total_tokens", json!(tt)),
        ]));
    }

    let chunk_event_str = chunk.get("event").and_then(|e| e.as_str()).unwrap_or("");
    let chunk_event_is_object = chunk.get("event").map(|e| e.is_object()).unwrap_or(false);
    let is_tool_progress = st.current_event_type == "hermes.tool.progress"
        || st.current_event_type == "tool_progress"
        || chunk_event_str == "hermes.tool.progress"
        || chunk_event_str == "tool_progress";

    let event_data: Option<Value> = chunk
        .get("data")
        .filter(|d| truthy(d))
        .cloned()
        .or_else(|| chunk.get("hermes_event").filter(|d| truthy(d)).cloned())
        .or_else(|| {
            if chunk_event_is_object {
                Some(chunk["event"].clone())
            } else if is_tool_progress {
                Some(chunk.clone())
            } else {
                None
            }
        });

    if is_tool_progress {
        if let Some(ev) = event_data {
            emit_tool_progress(st, emit_session_id, resolved_session_id, composite_id, &ev);
            return;
        }
    }

    let is_reasoning_event = st.current_event_type == "hermes.reasoning.delta"
        || chunk_event_str == "hermes.reasoning.delta";
    if is_reasoning_event {
        let ev = chunk
            .get("data")
            .filter(|d| truthy(d))
            .cloned()
            .unwrap_or_else(|| {
                chunk
                    .get("hermes_event")
                    .filter(|d| truthy(d))
                    .cloned()
                    .unwrap_or(chunk.clone())
            });
        let reasoning_text = first_truthy(
            [
                ev.get("text").cloned().unwrap_or(Value::Null),
                ev.get("content").cloned().unwrap_or(Value::Null),
                ev.get("reasoning").cloned().unwrap_or(Value::Null),
            ],
            Value::Null,
        );
        if let Some(s) = reasoning_text.as_str() {
            if !s.is_empty() {
                emit_reasoning_delta(st, emit_session_id, resolved_session_id, composite_id, s);
            }
        }
        return;
    }

    // Standard OpenAI chunk structure.
    let choice = chunk
        .get("choices")
        .and_then(|c| c.as_array())
        .and_then(|a| a.first())
        .cloned();
    let delta = choice
        .as_ref()
        .and_then(|c| c.get("delta"))
        .filter(|d| truthy(d))
        .cloned()
        .or_else(|| chunk.get("delta").filter(|d| truthy(d)).cloned());

    if let Some(delta) = delta {
        if let Some(content) = delta.get("content").filter(|c| truthy(c)) {
            let content = js_string(content);
            if st.full_text.chars().count() < MAX_STREAM_CHARS {
                st.full_text.push_str(&content);
                json_line(&obj(vec![
                    ("type", json!("delta")),
                    ("session_id", json!(emit_session_id)),
                    ("raw_session_id", json!(resolved_session_id)),
                    ("composite_id", json!(composite_id)),
                    ("content", json!(content)),
                ]));
            }
        }

        let reasoning_chunk = delta
            .get("reasoning_content")
            .and_then(|r| r.as_str())
            .map(|s| s.to_string())
            .or_else(|| {
                delta
                    .get("reasoning")
                    .and_then(|r| r.as_str())
                    .map(|s| s.to_string())
            })
            .unwrap_or_default();
        if !reasoning_chunk.is_empty() {
            emit_reasoning_delta(
                st,
                emit_session_id,
                resolved_session_id,
                composite_id,
                &reasoning_chunk,
            );
        }

        if let Some(tcs) = delta.get("tool_calls").and_then(|t| t.as_array()) {
            for tc in tcs {
                let fn_name = tc
                    .pointer("/function/name")
                    .and_then(|n| n.as_str())
                    .unwrap_or("");
                if !fn_name.is_empty() {
                    let label = tc
                        .pointer("/function/arguments")
                        .filter(|a| truthy(a))
                        .map(js_string)
                        .unwrap_or_default();
                    let id = first_truthy(
                        [
                            tc.get("id").cloned().unwrap_or(Value::Null),
                            tc.get("call_id").cloned().unwrap_or(Value::Null),
                        ],
                        json!(""),
                    );
                    let ev = obj(vec![
                        ("tool", json!(fn_name)),
                        ("status", json!("running")),
                        ("label", json!(label)),
                        ("id", id),
                    ]);
                    emit_tool_progress(st, emit_session_id, resolved_session_id, composite_id, &ev);
                }
            }
        }
    }
}

async fn run_stream(
    opts: &StreamOptions,
    cfg: &ResolvedConfig,
    emit_session_id: &str,
    resolved_session_id: &str,
    composite_id: &str,
    messages: Vec<Value>,
) -> Result<(), String> {
    let idle_ms: u64 = 60000;
    let duration_ms = env_ms("HERMES_STREAM_DURATION_MS", 600000);
    let start = Instant::now();
    let deadline = start + Duration::from_millis(duration_ms);

    let endpoint_url = {
        let base = cfg.base_url.trim_end_matches('/');
        format!("{base}/chat/completions")
    };
    let headers = vec![
        ("Content-Type".to_string(), "application/json".to_string()),
        (
            "Authorization".to_string(),
            format!("Bearer {}", cfg.api_key),
        ),
        ("Accept".to_string(), "text/event-stream".to_string()),
        (
            "X-Hermes-Session-Id".to_string(),
            resolved_session_id.to_string(),
        ),
        ("X-Hermes-Source".to_string(), "omarchy-bar".to_string()),
    ];
    let req_body = serde_json::to_string(&obj(vec![
        (
            "model",
            json!(if opts.model.is_empty() {
                "hermes-agent".to_string()
            } else {
                opts.model.clone()
            }),
        ),
        (
            "messages",
            Value::Array(
                messages
                    .iter()
                    .map(|m| {
                        obj(vec![
                            ("role", m.get("role").cloned().unwrap_or(Value::Null)),
                            ("content", m.get("content").cloned().unwrap_or(Value::Null)),
                        ])
                    })
                    .collect(),
            ),
        ),
        ("stream", json!(true)),
        ("stream_options", obj(vec![("include_usage", json!(true))])),
    ]))
    .unwrap();

    let client = crate::http::client();
    let mut req = client.request(Method::POST, &endpoint_url);
    for (k, v) in &headers {
        req = req.header(k.as_str(), v.as_str());
    }
    req = req.body(req_body);
    let built = req.build().map_err(|e| format!("{e}"))?;

    let res = {
        let remaining = deadline.saturating_duration_since(Instant::now());
        let window = remaining.min(Duration::from_millis(idle_ms));
        match tokio::time::timeout(window, client.execute(built)).await {
            Err(_) => {
                if Instant::now() >= deadline {
                    return Err("Stream request exceeded 10m total duration".into());
                }
                return Err("Stream request timed out due to 60s inactivity".into());
            }
            Ok(r) => r.map_err(|e| format!("{e}"))?,
        }
    };

    let status = res.status().as_u16();
    if !crate::http::is_ok(status) {
        // Keep a timeout armed through error-body consumption.
        let error_body_timeout_ms = env_ms("HERMES_ERROR_BODY_TIMEOUT_MS", 10000);
        let res = res;
        let cl = res
            .headers()
            .get(reqwest::header::CONTENT_LENGTH)
            .and_then(|v| v.to_str().ok())
            .map(|s| s.to_string());
        let mut stream = Box::pin(res.bytes_stream());
        let mut raw_text = String::new();
        let mut read_err: Option<String> = None;
        let mut aborted = false;
        let read_fut = async {
            let mut total = 0usize;
            let mut acc: Vec<u8> = Vec::new();
            while let Some(chunk) = stream.next().await {
                let chunk = chunk.map_err(|e| format!("{e}"))?;
                total += chunk.len();
                if total > 32768 {
                    return Err("Response body exceeds 32768 byte limit".to_string());
                }
                acc.extend_from_slice(&chunk);
            }
            Ok(String::from_utf8_lossy(&acc).into_owned())
        };
        // Content-Length pre-check (JS readBoundedText).
        let cl_check: Result<(), String> = match &cl {
            Some(cl) => {
                if cl.is_empty() || !cl.bytes().all(|b| b.is_ascii_digit()) {
                    Err("Invalid Content-Length header".into())
                } else if cl.parse::<u64>().unwrap_or(u64::MAX) > 32768 {
                    Err(format!("Content-Length {cl} exceeds 32768 byte limit"))
                } else {
                    Ok(())
                }
            }
            None => Ok(()),
        };
        match cl_check {
            Err(e) => read_err = Some(e),
            Ok(()) => {
                match tokio::time::timeout(Duration::from_millis(error_body_timeout_ms), read_fut)
                    .await
                {
                    Err(_) => {
                        aborted = true;
                        read_err = Some(format!(
                            "Error response body timed out after {error_body_timeout_ms}ms"
                        ));
                    }
                    Ok(Ok(text)) => raw_text = text,
                    Ok(Err(e)) => read_err = Some(e),
                }
            }
        }
        if let Some(e) = read_err {
            // JS rethrows aborts and byte-limit errors; swallows other read errors.
            if aborted || e.contains("exceeds") && e.contains("byte limit") {
                return Err(e);
            }
        }
        let mut err_detail = String::new();
        if !raw_text.is_empty() {
            match js_parse(&raw_text) {
                Ok(err_json) => {
                    let msg = first_truthy(
                        [
                            err_json
                                .pointer("/error/message")
                                .cloned()
                                .unwrap_or(Value::Null),
                            err_json.get("message").cloned().unwrap_or(Value::Null),
                        ],
                        Value::Null,
                    );
                    err_detail = if msg.is_null() {
                        serde_json::to_string(&err_json).unwrap_or_default()
                    } else {
                        js_string(&msg)
                    };
                }
                Err(_) => err_detail = slice_chars(&raw_text, 512),
            }
        }
        return Err(if err_detail.is_empty() {
            format!("HTTP {status}")
        } else {
            format!("HTTP {status}: {err_detail}")
        });
    }

    let mut st = StreamState {
        full_text: String::new(),
        full_reasoning: String::new(),
        usage: None,
        tool_event_count: 0,
        tool_events_truncated: false,
        current_event_type: "message".to_string(),
        line_buffer: String::new(),
    };

    let mut stream = res.bytes_stream();
    loop {
        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            return Err("Stream request exceeded 10m total duration".into());
        }
        let window = remaining.min(Duration::from_millis(idle_ms));
        match tokio::time::timeout(window, stream.next()).await {
            Err(_) => {
                if Instant::now() >= deadline {
                    return Err("Stream request exceeded 10m total duration".into());
                }
                return Err("Stream request timed out due to 60s inactivity".into());
            }
            Ok(None) => break,
            Ok(Some(Err(e))) => return Err(format!("{e}")),
            Ok(Some(Ok(chunk))) => {
                st.line_buffer.push_str(&String::from_utf8_lossy(&chunk));
                if st.line_buffer.chars().count() > MAX_SSE_LINE_CHARS {
                    return Err(format!(
                        "SSE line exceeds {MAX_SSE_LINE_CHARS} character limit"
                    ));
                }
                let mut lines: Vec<String> = st
                    .line_buffer
                    .split('\n')
                    .map(|l| l.trim_end_matches('\r').to_string())
                    .collect();
                st.line_buffer = lines.pop().unwrap_or_default();
                for line in lines {
                    process_sse_line(
                        &mut st,
                        emit_session_id,
                        resolved_session_id,
                        composite_id,
                        &line,
                    );
                }
            }
        }
    }

    if !st.line_buffer.trim().is_empty() {
        let tail = st.line_buffer.clone();
        process_sse_line(
            &mut st,
            emit_session_id,
            resolved_session_id,
            composite_id,
            &tail,
        );
    }

    json_line(&obj(vec![
        ("type", json!("done")),
        ("session_id", json!(emit_session_id)),
        ("raw_session_id", json!(resolved_session_id)),
        ("composite_id", json!(composite_id)),
        ("endpoint_id", json!(cfg.endpoint_id)),
        ("profile_name", json!(cfg.profile_name)),
        ("full_text", json!(st.full_text)),
        ("full_reasoning", json!(st.full_reasoning)),
        ("finish_reason", json!("stop")),
        ("usage", st.usage.unwrap_or(Value::Null)),
    ]));
    Ok(())
}
