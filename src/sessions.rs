//! Session/target commands: status, list-targets, list-sessions, get-session,
//! rename-session, delete-session.

use crate::config::*;
use crate::http::*;
use crate::util::*;
use reqwest::Method;
use serde_json::{json, Value};
use std::sync::Arc;

fn auth_headers(api_key: &str) -> Vec<(String, String)> {
    let mut h = vec![("Accept".to_string(), "application/json".to_string())];
    if !api_key.is_empty() {
        h.push(("Authorization".to_string(), format!("Bearer {api_key}")));
    }
    h
}

pub async fn handle_status(endpoint: Option<&str>, profile: Option<&str>) {
    let cfg = match resolve_config(endpoint, profile) {
        Ok(c) => c,
        Err(err) => {
            json_line(&obj(vec![
                ("success", json!(false)),
                ("connected", json!(false)),
                ("error", json!(err)),
            ]));
            return;
        }
    };
    let client = client();
    match bounded_fetch(
        &client,
        &format!("{}/models", cfg.base_url),
        Method::GET,
        auth_headers(&cfg.api_key),
        None,
        65536,
        10000,
    )
    .await
    {
        Ok((mut res, timeout)) => {
            if is_ok(res.status) {
                match read_bounded_json(&mut res, 65536, Some(timeout)).await {
                    Ok(data) => {
                        let models: Vec<Value> = data
                            .get("data")
                            .and_then(|d| d.as_array())
                            .map(|arr| {
                                arr.iter()
                                    .map(|m| m.get("id").cloned().unwrap_or(Value::Null))
                                    .collect()
                            })
                            .unwrap_or_else(|| vec![json!("hermes-agent")]);
                        let models = if models.is_empty() {
                            vec![json!("hermes-agent")]
                        } else {
                            models
                        };
                        json_line(&obj(vec![
                            ("success", json!(true)),
                            ("connected", json!(true)),
                            ("endpointId", json!(cfg.endpoint_id)),
                            ("profileName", json!(cfg.profile_name)),
                            ("rootUrl", json!(cfg.root_url)),
                            ("baseUrl", json!(cfg.base_url)),
                            ("models", Value::Array(models)),
                            ("serverName", json!(cfg.server_name)),
                        ]));
                    }
                    Err(e) => {
                        json_line(&obj(vec![
                            ("success", json!(false)),
                            ("connected", json!(false)),
                            ("endpointId", json!(cfg.endpoint_id)),
                            ("profileName", json!(cfg.profile_name)),
                            ("baseUrl", json!(cfg.base_url)),
                            ("error", json!(e)),
                            ("serverName", json!(cfg.server_name)),
                        ]));
                    }
                }
            } else {
                json_line(&obj(vec![
                    ("success", json!(false)),
                    ("connected", json!(false)),
                    ("endpointId", json!(cfg.endpoint_id)),
                    ("profileName", json!(cfg.profile_name)),
                    ("statusCode", json!(res.status)),
                    ("baseUrl", json!(cfg.base_url)),
                    (
                        "error",
                        json!(format!("Server returned HTTP {}", res.status)),
                    ),
                    ("serverName", json!(cfg.server_name)),
                ]));
            }
        }
        Err(e) => {
            json_line(&obj(vec![
                ("success", json!(false)),
                ("connected", json!(false)),
                ("endpointId", json!(cfg.endpoint_id)),
                ("profileName", json!(cfg.profile_name)),
                ("baseUrl", json!(cfg.base_url)),
                ("error", json!(e)),
                ("serverName", json!(cfg.server_name)),
            ]));
        }
    }
}

pub fn extract_token_metrics(s: &Value) -> Value {
    let get_num =
        |k: &str| -> Option<f64> { s.get(k).and_then(|v| v.as_f64()).filter(|f| f.is_finite()) };
    let in_tok = get_num("input_tokens").unwrap_or(0.0);
    let out_tok = get_num("output_tokens").unwrap_or(0.0);
    let total_tok = if in_tok != 0.0 || out_tok != 0.0 {
        in_tok + out_tok
    } else {
        get_num("total_tokens").unwrap_or(0.0)
    };
    obj(vec![
        ("input_tokens", json!(total_num(in_tok))),
        ("output_tokens", json!(total_num(out_tok))),
        ("total_tokens", json!(total_num(total_tok))),
    ])
}

fn total_num(f: f64) -> Value {
    if f == f.trunc() && f.abs() < i64::MAX as f64 {
        json!(f as i64)
    } else {
        json!(f)
    }
}

pub async fn fetch_sessions_for_config(cfg: ResolvedConfig) -> Vec<Value> {
    let client = client();
    let headers = auth_headers(&cfg.api_key);
    let url1 = format!("{}{}/sessions", cfg.root_url, cfg.api_prefix);
    let url2 = format!("{}/sessions", cfg.base_url);

    let mut res = match bounded_fetch(
        &client,
        &url1,
        Method::GET,
        headers.clone(),
        None,
        MAX_FETCH_BYTES,
        10000,
    )
    .await
    {
        Ok(r) => r,
        Err(_) => return Vec::new(),
    };
    if !is_ok(res.0.status) {
        res = match bounded_fetch(
            &client,
            &url2,
            Method::GET,
            headers,
            None,
            MAX_FETCH_BYTES,
            10000,
        )
        .await
        {
            Ok(r) => r,
            Err(_) => return Vec::new(),
        };
    }
    if !is_ok(res.0.status) {
        return Vec::new();
    }
    let raw = match read_bounded_json(&mut res.0, MAX_FETCH_BYTES, Some(res.1)).await {
        Ok(v) => v,
        Err(_) => return Vec::new(),
    };
    let list: Vec<Value> = if raw.is_array() {
        raw.as_array().unwrap().clone()
    } else if raw.get("sessions").map(|s| s.is_array()).unwrap_or(false) {
        raw["sessions"].as_array().unwrap().clone()
    } else if raw.get("data").map(|d| d.is_array()).unwrap_or(false) {
        raw["data"].as_array().unwrap().clone()
    } else {
        Vec::new()
    };

    list.into_iter()
        .take(500)
        .enumerate()
        .map(|(idx, s)| {
            let mut created_at = first_truthy(
                [
                    s.get("created_at").cloned().unwrap_or(Value::Null),
                    s.get("createdAt").cloned().unwrap_or(Value::Null),
                    s.get("started_at").cloned().unwrap_or(Value::Null),
                ],
                Value::Null,
            );
            if created_at.is_number() {
                created_at = match iso_from_epoch_secs(&created_at) {
                    Some(iso) => json!(iso),
                    None => json!(now_iso()),
                };
            } else if !truthy(&created_at) {
                created_at = json!(now_iso());
            }
            let mut updated_at = first_truthy(
                [
                    s.get("updated_at").cloned().unwrap_or(Value::Null),
                    s.get("updatedAt").cloned().unwrap_or(Value::Null),
                    s.get("last_active").cloned().unwrap_or(Value::Null),
                    s.get("started_at").cloned().unwrap_or(Value::Null),
                ],
                Value::Null,
            );
            if updated_at.is_number() {
                updated_at = match iso_from_epoch_secs(&updated_at) {
                    Some(iso) => json!(iso),
                    None => created_at.clone(),
                };
            } else if !truthy(&updated_at) {
                updated_at = created_at.clone();
            }

            let raw_id_val = first_truthy(
                [
                    s.get("id").cloned().unwrap_or(Value::Null),
                    s.get("session_id").cloned().unwrap_or(Value::Null),
                ],
                json!(format!("session-{idx}")),
            );
            let raw_id = slice_chars(&js_string(&raw_id_val), 128);
            let composite_id = format!("{}:{}:{}", cfg.endpoint_id, cfg.profile_name, raw_id);
            let tok = extract_token_metrics(&s);

            let title_val = first_truthy(
                [
                    s.get("title").cloned().unwrap_or(Value::Null),
                    s.get("preview").cloned().unwrap_or(Value::Null),
                    s.get("name").cloned().unwrap_or(Value::Null),
                ],
                json!(format!("Session {raw_id}")),
            );
            let title = slice_chars(&js_string(&title_val), 200);

            let source = first_truthy(
                [
                    s.get("source").cloned().unwrap_or(Value::Null),
                    s.get("platform").cloned().unwrap_or(Value::Null),
                ],
                json!("hermes"),
            );

            let message_count = if s
                .get("message_count")
                .map(|m| m.is_number())
                .unwrap_or(false)
            {
                s["message_count"].clone()
            } else {
                let n = s
                    .get("messages")
                    .and_then(|m| m.as_array())
                    .map(|a| a.len())
                    .unwrap_or(0);
                json!(n)
            };

            let model = first_truthy(
                [s.get("model").cloned().unwrap_or(Value::Null)],
                json!("hermes-agent"),
            );

            let name_for_avatar = if cfg.profile_name != "default" {
                cfg.profile_name.clone()
            } else {
                cfg.endpoint_name.clone()
            };

            obj(vec![
                ("id", json!(composite_id)),
                ("raw_id", json!(raw_id)),
                ("endpoint_id", json!(cfg.endpoint_id)),
                ("endpoint_name", json!(cfg.endpoint_name)),
                ("profile_name", json!(cfg.profile_name)),
                (
                    "target_id",
                    json!(format!("{}:{}", cfg.endpoint_id, cfg.profile_name)),
                ),
                ("title", json!(title)),
                ("created_at", created_at),
                ("updated_at", updated_at),
                ("source", source),
                ("message_count", message_count),
                ("model", model),
                ("monogram", json!(get_agent_monogram(&name_for_avatar))),
                ("color", json!(get_agent_color(&name_for_avatar))),
                ("input_tokens", tok["input_tokens"].clone()),
                ("output_tokens", tok["output_tokens"].clone()),
                ("total_tokens", tok["total_tokens"].clone()),
            ])
        })
        .collect()
}

pub async fn handle_list_sessions(endpoint: Option<&str>, profile: Option<&str>) {
    let result: Result<Vec<Value>, String> = async {
        let settings = load_settings_file();
        let is_all = endpoint.is_none() || endpoint == Some("all");
        let mut all_sessions: Vec<Value> = Vec::new();

        if !is_all {
            let cfg = resolve_config(endpoint, profile)?;
            all_sessions = fetch_sessions_for_config(cfg).await;
        } else {
            let default_endpoint = get_default_endpoint();
            let endpoints: Vec<Value> = settings
                .as_ref()
                .and_then(|s| s.get("endpoints"))
                .and_then(|e| e.as_array())
                .filter(|e| !e.is_empty())
                .cloned()
                .unwrap_or_else(|| vec![default_endpoint.clone()]);

            let local_profiles = discover_local_hermes_profiles();

            let mut fetches = Vec::new();
            for ep in &endpoints {
                let ep_id = ep
                    .get("id")
                    .and_then(|v| v.as_str())
                    .unwrap_or("endpoint-default");
                let default_cfg = resolve_config(Some(ep_id), Some("default"))?;
                fetches.push(fetch_sessions_for_config(default_cfg));

                let mut seen: Vec<String> = vec!["default".into()];
                if let Some(profs) = ep.get("profiles").and_then(|p| p.as_array()) {
                    for p in profs {
                        let p_name = match p {
                            Value::String(s) => Some(s.clone()),
                            Value::Object(_) => {
                                p.get("name").filter(|n| n.is_string()).map(js_string)
                            }
                            _ => None,
                        };
                        if let Some(p_name) = p_name {
                            if !p_name.is_empty() && !seen.contains(&p_name.to_lowercase()) {
                                seen.push(p_name.to_lowercase());
                                let prof_cfg = resolve_config(Some(ep_id), Some(&p_name))?;
                                fetches.push(fetch_sessions_for_config(prof_cfg));
                            }
                        }
                    }
                }

                let ep_url = ep
                    .get("url")
                    .and_then(|u| u.as_str())
                    .or_else(|| ep.get("rootUrl").and_then(|u| u.as_str()))
                    .unwrap_or("");
                let is_local = ep_url.contains("127.0.0.1") || ep_url.contains("localhost");
                if is_local {
                    for (lp_name, _) in &local_profiles {
                        if !seen.contains(&lp_name.to_lowercase()) {
                            seen.push(lp_name.to_lowercase());
                            let prof_cfg = resolve_config(Some(ep_id), Some(lp_name))?;
                            fetches.push(fetch_sessions_for_config(prof_cfg));
                        }
                    }
                }
            }

            for batch in futures_util::future::join_all(fetches).await {
                all_sessions.extend(batch);
            }
        }

        Ok(all_sessions)
    }
    .await;

    match result {
        Ok(mut all_sessions) => {
            // Sort newest updated first (JS Date parse of updated_at).
            all_sessions.sort_by(|a, b| {
                let ta = js_date_ms(a.get("updated_at").cloned().unwrap_or(Value::Null));
                let tb = js_date_ms(b.get("updated_at").cloned().unwrap_or(Value::Null));
                tb.partial_cmp(&ta).unwrap_or(std::cmp::Ordering::Equal)
            });
            json_line(&obj(vec![
                ("success", json!(true)),
                ("sessions", Value::Array(all_sessions)),
            ]));
        }
        Err(err) => {
            json_line(&obj(vec![
                ("success", json!(false)),
                ("error", json!(err)),
                ("sessions", json!([])),
            ]));
        }
    }
}

/// JS `new Date(v).getTime()` for string/number values (NaN -> f64::NAN).
fn js_date_ms(v: Value) -> f64 {
    match v {
        Value::Number(n) => n.as_f64().unwrap_or(f64::NAN) * 1000.0,
        Value::String(s) => chrono_parse_iso(&s).unwrap_or(f64::NAN),
        _ => f64::NAN,
    }
}

/// Minimal ISO-8601 parser sufficient for the bridge's own ISO strings.
fn chrono_parse_iso(s: &str) -> Result<f64, ()> {
    // Format: YYYY-MM-DDTHH:MM:SS.mmmZ (what the bridge emits)
    let bytes = s.as_bytes();
    if bytes.len() < 24
        || bytes[4] != b'-'
        || bytes[7] != b'-'
        || bytes[10] != b'T'
        || bytes[13] != b':'
        || bytes[16] != b':'
    {
        return Err(());
    }
    let num = |a: usize, b: usize| -> Result<i64, ()> { s[a..b].parse::<i64>().map_err(|_| ()) };
    let (y, mo, d) = (num(0, 4)?, num(5, 7)?, num(8, 10)?);
    let (h, mi, sec) = (num(11, 13)?, num(14, 16)?, num(17, 19)?);
    let ms = num(20, 23).unwrap_or(0);
    let days = days_from_civil(y, mo, d);
    Ok((days * 86400 + h * 3600 + mi * 60 + sec) as f64 * 1000.0 + ms as f64)
}

fn days_from_civil(y: i64, m: i64, d: i64) -> i64 {
    let y = if m <= 2 { y - 1 } else { y };
    let era = if y >= 0 { y } else { y - 399 } / 400;
    let yoe = y - era * 400;
    let mp = (m + 9) % 12;
    let doy = (153 * mp + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146097 + doe - 719468
}

/// JS formatToolContent.
pub fn format_tool_content(raw: Value) -> (String, String) {
    if raw.is_null() {
        return (String::new(), String::new());
    }
    let str_val = match &raw {
        Value::String(s) => s.trim().to_string(),
        _ => serde_json::to_string(&raw).unwrap_or_default(),
    };
    if let Ok(parsed) = js_parse(&str_val) {
        if parsed.is_object() {
            let out = first_truthy(
                [
                    parsed.get("output").cloned().unwrap_or(Value::Null),
                    parsed.get("stdout").cloned().unwrap_or(Value::Null),
                    parsed.get("result").cloned().unwrap_or(Value::Null),
                ],
                parsed.clone(),
            );
            let out = if out.is_string() {
                js_parse(js_string(&out).trim()).unwrap_or(out.clone())
            } else {
                out
            };
            if out.is_object() || out.is_array() {
                return (
                    serde_json::to_string(&out).unwrap_or_default(),
                    serde_json::to_string_pretty(&out).unwrap_or_default(),
                );
            }
            let s = js_string(&out);
            let preview = s.trim().split('\n').next().unwrap_or("").to_string();
            return (preview, s.trim().to_string());
        }
    }
    (
        str_val.split('\n').next().unwrap_or("").to_string(),
        str_val,
    )
}

fn enc(s: &str) -> String {
    // JS encodeURIComponent for path segments.
    percent_encode_profile(s)
}

pub async fn handle_get_session(
    session_id: Option<&str>,
    opt_endpoint: Option<&str>,
    opt_profile: Option<&str>,
) {
    let sid = parse_session_identifier(session_id, opt_endpoint, opt_profile);
    if sid.raw_session_id.is_empty() {
        json_line(&obj(vec![
            ("success", json!(false)),
            ("error", json!("Session ID required")),
        ]));
        return;
    }
    let cfg = match resolve_config(sid.endpoint_id.as_deref(), sid.profile_name.as_deref()) {
        Ok(c) => c,
        Err(err) => {
            json_line(&obj(vec![("success", json!(false)), ("error", json!(err))]));
            return;
        }
    };
    let client = client();
    let headers = auth_headers(&cfg.api_key);
    let enc_id = enc(&sid.raw_session_id);

    let result: Result<(), String> = async {
        let mut session_obj = json!({});
        let url1 = format!("{}{}/sessions/{enc_id}", cfg.root_url, cfg.api_prefix);
        let url2 = format!("{}/sessions/{enc_id}", cfg.base_url);
        let mut session_res = bounded_fetch(
            &client,
            &url1,
            Method::GET,
            headers.clone(),
            None,
            MAX_FETCH_BYTES,
            10000,
        )
        .await?;
        if is_ok(session_res.0.status) {
            let data =
                read_bounded_json(&mut session_res.0, MAX_FETCH_BYTES, Some(session_res.1)).await?;
            session_obj = data.get("session").cloned().unwrap_or(data);
        } else {
            let mut r2 = bounded_fetch(
                &client,
                &url2,
                Method::GET,
                headers.clone(),
                None,
                MAX_FETCH_BYTES,
                10000,
            )
            .await?;
            if is_ok(r2.0.status) {
                let data = read_bounded_json(&mut r2.0, MAX_FETCH_BYTES, Some(r2.1)).await?;
                session_obj = data.get("session").cloned().unwrap_or(data);
            }
        }

        // 2. Fetch session messages
        let murl1 = format!(
            "{}{}/sessions/{enc_id}/messages",
            cfg.root_url, cfg.api_prefix
        );
        let murl2 = format!("{}/sessions/{enc_id}/messages", cfg.base_url);
        let mut msg_res = bounded_fetch(
            &client,
            &murl1,
            Method::GET,
            headers.clone(),
            None,
            MAX_FETCH_BYTES,
            10000,
        )
        .await?;
        if !is_ok(msg_res.0.status) {
            msg_res = bounded_fetch(
                &client,
                &murl2,
                Method::GET,
                headers.clone(),
                None,
                MAX_FETCH_BYTES,
                10000,
            )
            .await?;
        }

        let raw_messages: Vec<Value> = if is_ok(msg_res.0.status) {
            let msg_data =
                read_bounded_json(&mut msg_res.0, MAX_FETCH_BYTES, Some(msg_res.1)).await?;
            if msg_data.get("data").map(|d| d.is_array()).unwrap_or(false) {
                msg_data["data"].as_array().unwrap().clone()
            } else if msg_data
                .get("messages")
                .map(|m| m.is_array())
                .unwrap_or(false)
            {
                msg_data["messages"].as_array().unwrap().clone()
            } else if msg_data.is_array() {
                msg_data.as_array().unwrap().clone()
            } else {
                Vec::new()
            }
        } else {
            session_obj
                .get("messages")
                .and_then(|m| m.as_array())
                .cloned()
                .unwrap_or_default()
        };

        let messages: Vec<Value> = raw_messages
            .into_iter()
            .filter(|m| {
                m.is_object() && m.get("role").and_then(|r| r.as_str()) != Some("session_meta")
            })
            .take(1000)
            .map(|m| {
                let mut parsed_tool_calls: Vec<Value> = Vec::new();
                if let Some(tcs) = m.get("tool_calls").and_then(|t| t.as_array()) {
                    for tc in tcs.iter().take(50) {
                        let fn_name = first_truthy(
                            [
                                tc.pointer("/function/name").cloned().unwrap_or(Value::Null),
                                tc.get("name").cloned().unwrap_or(Value::Null),
                            ],
                            json!("tool"),
                        );
                        let fn_args = first_truthy(
                            [
                                tc.pointer("/function/arguments")
                                    .cloned()
                                    .unwrap_or(Value::Null),
                                tc.get("arguments").cloned().unwrap_or(Value::Null),
                            ],
                            json!(""),
                        );
                        let parsed_args: Result<Value, ()> = if fn_args.is_string() {
                            js_parse(&js_string(&fn_args))
                        } else {
                            Ok(fn_args.clone())
                        };
                        let (summary, formatted_args) = match parsed_args {
                            Ok(pa) => {
                                let pick = |keys: [&str; 4]| -> Option<String> {
                                    for k in keys {
                                        if let Some(v) = pa.get(k).filter(|v| truthy(v)) {
                                            return Some(js_string(v));
                                        }
                                    }
                                    None
                                };
                                let summary = pick(["command", "code", "query", "path"])
                                    .or_else(|| {
                                        if pa.is_object() {
                                            Some(serde_json::to_string(&pa).unwrap_or_default())
                                        } else {
                                            None
                                        }
                                    })
                                    .unwrap_or_default();
                                let formatted_args = if pa.is_object() || pa.is_array() {
                                    serde_json::to_string_pretty(&pa).unwrap_or_default()
                                } else {
                                    js_string(&fn_args)
                                };
                                (summary, formatted_args)
                            }
                            Err(_) => (js_string(&fn_args), js_string(&fn_args)),
                        };
                        let args_out = if !formatted_args.is_empty() {
                            formatted_args.clone()
                        } else if fn_args.is_string() {
                            js_string(&fn_args)
                        } else {
                            serde_json::to_string_pretty(&fn_args).unwrap_or_default()
                        };
                        let summary_out = if !summary.is_empty() {
                            summary.clone()
                        } else {
                            js_string(&fn_name)
                        };
                        parsed_tool_calls.push(obj(vec![
                            (
                                "id",
                                first_truthy(
                                    [
                                        tc.get("id").cloned().unwrap_or(Value::Null),
                                        tc.get("call_id").cloned().unwrap_or(Value::Null),
                                    ],
                                    Value::Null,
                                ),
                            ),
                            ("name", fn_name),
                            ("arguments", json!(args_out)),
                            ("summary", json!(summary_out)),
                        ]));
                    }
                }

                let role = m.get("role").and_then(|r| r.as_str()).unwrap_or("user");
                let tool_formatting = if role == "tool" {
                    Some(format_tool_content(
                        m.get("content").cloned().unwrap_or(Value::Null),
                    ))
                } else {
                    None
                };

                let content = match m.get("content") {
                    Some(Value::String(s)) => json!(s),
                    Some(v) if !v.is_null() => json!(serde_json::to_string(v).unwrap_or_default()),
                    _ => Value::Null,
                };

                let timestamp = match m.get("timestamp") {
                    Some(v) if truthy(v) => {
                        if v.is_number() {
                            match iso_from_epoch_secs(v) {
                                Some(iso) => json!(iso),
                                None => Value::Null,
                            }
                        } else {
                            v.clone()
                        }
                    }
                    _ => Value::Null,
                };

                obj(vec![
                    ("role", json!(role)),
                    ("content", content),
                    (
                        "tool_preview",
                        match &tool_formatting {
                            Some((p, _)) => json!(p),
                            None => Value::Null,
                        },
                    ),
                    (
                        "tool_formatted",
                        match &tool_formatting {
                            Some((_, f)) => json!(f),
                            None => Value::Null,
                        },
                    ),
                    ("timestamp", timestamp),
                    ("tool_calls", Value::Array(parsed_tool_calls)),
                    (
                        "tool_name",
                        first_truthy(
                            [m.get("tool_name").cloned().unwrap_or(Value::Null)],
                            Value::Null,
                        ),
                    ),
                    (
                        "tool_call_id",
                        first_truthy(
                            [m.get("tool_call_id").cloned().unwrap_or(Value::Null)],
                            Value::Null,
                        ),
                    ),
                    (
                        "reasoning",
                        first_truthy(
                            [
                                m.get("reasoning").cloned().unwrap_or(Value::Null),
                                m.get("reasoning_content").cloned().unwrap_or(Value::Null),
                            ],
                            Value::Null,
                        ),
                    ),
                ])
            })
            .collect();

        let tok = extract_token_metrics(&session_obj);
        let composite_id = format!(
            "{}:{}:{}",
            cfg.endpoint_id, cfg.profile_name, sid.raw_session_id
        );
        json_line(&obj(vec![
            ("success", json!(true)),
            ("id", json!(composite_id.clone())),
            ("raw_id", json!(sid.raw_session_id.clone())),
            ("endpoint_id", json!(cfg.endpoint_id.clone())),
            ("endpoint_name", json!(cfg.endpoint_name.clone())),
            ("profile_name", json!(cfg.profile_name.clone())),
            (
                "session",
                obj(vec![
                    ("id", json!(composite_id)),
                    ("raw_id", json!(sid.raw_session_id.clone())),
                    ("endpoint_id", json!(cfg.endpoint_id.clone())),
                    ("endpoint_name", json!(cfg.endpoint_name.clone())),
                    ("profile_name", json!(cfg.profile_name.clone())),
                    (
                        "title",
                        first_truthy(
                            [
                                session_obj.get("title").cloned().unwrap_or(Value::Null),
                                session_obj.get("name").cloned().unwrap_or(Value::Null),
                            ],
                            json!(format!("Session {}", sid.raw_session_id)),
                        ),
                    ),
                    ("messages", Value::Array(messages)),
                    (
                        "created_at",
                        first_truthy(
                            [
                                session_obj
                                    .get("created_at")
                                    .cloned()
                                    .unwrap_or(Value::Null),
                                session_obj
                                    .get("started_at")
                                    .cloned()
                                    .unwrap_or(Value::Null),
                            ],
                            Value::Null,
                        ),
                    ),
                    (
                        "updated_at",
                        first_truthy(
                            [
                                session_obj
                                    .get("updated_at")
                                    .cloned()
                                    .unwrap_or(Value::Null),
                                session_obj
                                    .get("last_active")
                                    .cloned()
                                    .unwrap_or(Value::Null),
                            ],
                            Value::Null,
                        ),
                    ),
                    ("input_tokens", tok["input_tokens"].clone()),
                    ("output_tokens", tok["output_tokens"].clone()),
                    ("total_tokens", tok["total_tokens"].clone()),
                ]),
            ),
        ]));
        Ok(())
    }
    .await;
    if let Err(err) = result {
        json_line(&obj(vec![("success", json!(false)), ("error", json!(err))]));
    }
}

pub async fn handle_delete_session(
    session_id: Option<&str>,
    opt_endpoint: Option<&str>,
    opt_profile: Option<&str>,
) {
    let sid = parse_session_identifier(session_id, opt_endpoint, opt_profile);
    if sid.raw_session_id.is_empty() {
        json_line(&obj(vec![
            ("success", json!(false)),
            ("error", json!("Session ID required")),
        ]));
        return;
    }
    let cfg = match resolve_config(sid.endpoint_id.as_deref(), sid.profile_name.as_deref()) {
        Ok(c) => c,
        Err(err) => {
            json_line(&obj(vec![("success", json!(false)), ("error", json!(err))]));
            return;
        }
    };
    let client = client();
    let headers = auth_headers(&cfg.api_key);
    let enc_id = enc(&sid.raw_session_id);

    let result: Result<(), String> = async {
        let url1 = format!("{}{}/sessions/{enc_id}", cfg.root_url, cfg.api_prefix);
        let url2 = format!("{}/sessions/{enc_id}", cfg.base_url);
        let (mut res, _timeout) = bounded_fetch(
            &client,
            &url1,
            Method::DELETE,
            headers.clone(),
            None,
            65536,
            10000,
        )
        .await?;
        if !is_ok(res.status) && res.status != 404 {
            // Body intentionally not read; drop the stream (JS boundedRelease + cancel).
            res.release();
            let (res2, _) = bounded_fetch(
                &client,
                &url2,
                Method::DELETE,
                headers.clone(),
                None,
                65536,
                10000,
            )
            .await?;
            res = res2;
        }
        res.release();

        let composite_id = format!(
            "{}:{}:{}",
            cfg.endpoint_id, cfg.profile_name, sid.raw_session_id
        );
        json_line(&obj(vec![
            ("success", json!(true)),
            ("id", json!(composite_id)),
            ("raw_id", json!(sid.raw_session_id.clone())),
            ("endpoint_id", json!(cfg.endpoint_id.clone())),
            ("profile_name", json!(cfg.profile_name.clone())),
            ("deleted", json!(true)),
        ]));
        Ok(())
    }
    .await;
    if let Err(err) = result {
        json_line(&obj(vec![("success", json!(false)), ("error", json!(err))]));
    }
}

pub async fn handle_rename_session(
    session_id: Option<&str>,
    new_title: &str,
    opt_endpoint: Option<&str>,
    opt_profile: Option<&str>,
) {
    let sid = parse_session_identifier(session_id, opt_endpoint, opt_profile);
    if sid.raw_session_id.is_empty() || new_title.is_empty() {
        json_line(&obj(vec![
            ("success", json!(false)),
            ("error", json!("Session ID and new title required")),
        ]));
        return;
    }
    let cfg = match resolve_config(sid.endpoint_id.as_deref(), sid.profile_name.as_deref()) {
        Ok(c) => c,
        Err(err) => {
            json_line(&obj(vec![("success", json!(false)), ("error", json!(err))]));
            return;
        }
    };
    let client = client();
    let enc_id = enc(&sid.raw_session_id);
    let mut headers = vec![
        ("Content-Type".to_string(), "application/json".to_string()),
        ("Accept".to_string(), "application/json".to_string()),
    ];
    if !cfg.api_key.is_empty() {
        headers.push((
            "Authorization".to_string(),
            format!("Bearer {}", cfg.api_key),
        ));
    }
    let title = slice_chars(new_title, 200);
    let body = serde_json::to_string(&obj(vec![("title", json!(title))])).unwrap();

    let result: Result<(), String> = async {
        let url = format!("{}{}/sessions/{enc_id}", cfg.root_url, cfg.api_prefix);
        let (mut res, timeout) = bounded_fetch(
            &client,
            &url,
            Method::PATCH,
            headers,
            Some(body),
            65536,
            10000,
        )
        .await?;
        if !is_ok(res.status) {
            res.release();
            json_line(&obj(vec![
                ("success", json!(false)),
                (
                    "error",
                    json!(format!("Failed to rename session: {}", res.status)),
                ),
            ]));
            return Ok(());
        }
        let data = read_bounded_json(&mut res, 65536, Some(timeout)).await?;
        let session_obj = data.get("session").cloned().unwrap_or(data);
        let composite_id = format!(
            "{}:{}:{}",
            cfg.endpoint_id, cfg.profile_name, sid.raw_session_id
        );
        json_line(&obj(vec![
            ("success", json!(true)),
            ("id", json!(composite_id)),
            ("raw_id", json!(sid.raw_session_id.clone())),
            ("endpoint_id", json!(cfg.endpoint_id.clone())),
            ("profile_name", json!(cfg.profile_name.clone())),
            (
                "title",
                first_truthy(
                    [session_obj.get("title").cloned().unwrap_or(Value::Null)],
                    json!(new_title),
                ),
            ),
        ]));
        Ok(())
    }
    .await;
    if let Err(err) = result {
        json_line(&obj(vec![("success", json!(false)), ("error", json!(err))]));
    }
}

pub async fn handle_list_targets() {
    let settings = load_settings_file().unwrap_or_else(|| json!({ "endpoints": [] }));
    let mut endpoints: Vec<Value> = settings
        .get("endpoints")
        .and_then(|e| e.as_array())
        .cloned()
        .unwrap_or_default();
    if endpoints.is_empty() {
        endpoints = vec![get_default_endpoint()];
    }
    let local_profiles = discover_local_hermes_profiles();
    let client = client();

    let futs = endpoints.into_iter().map(|ep| {
        let client = client.clone();
        let local_profiles = local_profiles.clone();
        async move {
            let ep_url = ep.get("url").and_then(|u| u.as_str()).unwrap_or("");
            let ep_port = ep
                .get("port")
                .and_then(|p| p.as_f64())
                .map(|p| p as u16)
                .unwrap_or(8642);
            let parsed = parse_endpoint_url(ep_url, ep_port, false).unwrap_or(ParsedUrl {
                protocol: "http:".into(),
                hostname: "127.0.0.1".into(),
                port: Some(8642),
                origin: "http://127.0.0.1:8642".into(),
            });
            let root_url = parsed.origin.clone();
            let is_local = is_loopback_host(&parsed.hostname);

            let mut connected = false;
            let mut models = vec![json!("hermes-agent")];
            let ep_key = ep.get("apiKey").and_then(|k| k.as_str()).unwrap_or("");
            let mut headers = vec![("Accept".to_string(), "application/json".to_string())];
            if !ep_key.is_empty()
                && (parsed.protocol == "https:" || is_private_or_loopback_host(&parsed.hostname))
            {
                headers.push((
                    "Authorization".to_string(),
                    format!("Bearer {}", sanitize_header_value(ep_key)),
                ));
            }
            if let Ok((mut res, timeout)) = bounded_fetch(
                &client,
                &format!("{root_url}/v1/models"),
                Method::GET,
                headers,
                None,
                65536,
                2500,
            )
            .await
            {
                if is_ok(res.status) {
                    connected = true;
                    if let Ok(data) = read_bounded_json(&mut res, 65536, Some(timeout)).await {
                        if let Some(arr) = data.get("data").and_then(|d| d.as_array()) {
                            if !arr.is_empty() {
                                models = arr
                                    .iter()
                                    .map(|m| m.get("id").cloned().unwrap_or(Value::Null))
                                    .collect();
                            }
                        }
                    }
                } else {
                    res.release();
                }
            }

            let ep_context_window = ep
                .get("contextWindow")
                .and_then(|c| c.as_f64())
                .filter(|c| *c > 0.0)
                .map(|c| json!(c));
            let ep_name = ep
                .get("name")
                .and_then(|n| n.as_str())
                .unwrap_or("")
                .to_string();
            let ep_id = ep
                .get("id")
                .and_then(|i| i.as_str())
                .unwrap_or("endpoint-default")
                .to_string();

            let mut profiles_list: Vec<Value> = vec![obj(vec![
                ("name", json!("default")),
                ("isDefault", json!(true)),
                ("targetId", json!(format!("{ep_id}:default"))),
                ("displayName", json!(ep_name.clone())),
                ("endpointName", json!(ep_name.clone())),
                (
                    "contextWindow",
                    ep_context_window.clone().unwrap_or(Value::Null),
                ),
                ("monogram", json!(get_agent_monogram(&ep_name))),
                ("color", json!(get_agent_color(&ep_name))),
            ])];

            let mut existing: Vec<String> = vec!["default".into()];
            if let Some(profs) = ep.get("profiles").and_then(|p| p.as_array()) {
                for p in profs {
                    let p_name = match p {
                        Value::String(s) => Some(s.clone()),
                        Value::Object(_) => p.get("name").filter(|n| n.is_string()).map(js_string),
                        _ => None,
                    };
                    if let Some(p_name) = p_name {
                        if !p_name.is_empty() && !existing.contains(&p_name.to_lowercase()) {
                            existing.push(p_name.to_lowercase());
                            let p_cw = p
                                .get("contextWindow")
                                .and_then(|c| c.as_f64())
                                .filter(|c| c.is_finite() && *c > 0.0)
                                .map(|c| json!(c));
                            profiles_list.push(obj(vec![
                                ("name", json!(p_name.clone())),
                                ("isDefault", json!(false)),
                                ("targetId", json!(format!("{ep_id}:{p_name}"))),
                                ("displayName", json!(p_name.clone())),
                                ("endpointName", json!(ep_name.clone())),
                                ("contextWindow", p_cw.unwrap_or(Value::Null)),
                                ("monogram", json!(get_agent_monogram(&p_name))),
                                ("color", json!(get_agent_color(&p_name))),
                            ]));
                        }
                    }
                }
            }

            if is_local {
                for (lp_name, _) in &local_profiles {
                    if !existing.contains(&lp_name.to_lowercase()) {
                        existing.push(lp_name.to_lowercase());
                        profiles_list.push(obj(vec![
                            ("name", json!(lp_name.clone())),
                            ("isDefault", json!(false)),
                            ("targetId", json!(format!("{ep_id}:{lp_name}"))),
                            ("displayName", json!(lp_name.clone())),
                            ("endpointName", json!(ep_name.clone())),
                            ("monogram", json!(get_agent_monogram(lp_name))),
                            ("color", json!(get_agent_color(lp_name))),
                        ]));
                    }
                }
            }

            obj(vec![
                ("id", json!(ep_id.clone())),
                ("endpointId", json!(ep_id.clone())),
                ("name", json!(ep_name.clone())),
                ("endpointName", json!(ep_name.clone())),
                ("url", ep.get("url").cloned().unwrap_or(Value::Null)),
                ("port", ep.get("port").cloned().unwrap_or(Value::Null)),
                ("contextWindow", ep_context_window.unwrap_or(Value::Null)),
                ("connected", json!(connected)),
                ("models", Value::Array(models)),
                ("monogram", json!(get_agent_monogram(&ep_name))),
                ("color", json!(get_agent_color(&ep_name))),
                ("profiles", Value::Array(profiles_list)),
            ])
        }
    });

    let targets = futures_util::future::join_all(futs).await;
    let active_target = settings.get("activeTarget").cloned().unwrap_or_else(|| {
        obj(vec![
            ("endpointId", json!("all")),
            ("profileName", json!("all")),
        ])
    });
    json_line(&obj(vec![
        ("success", json!(true)),
        ("targets", Value::Array(targets)),
        ("activeTarget", active_target),
    ]));
}

#[allow(dead_code)]
fn unused(_: Arc<reqwest::Client>) {}
