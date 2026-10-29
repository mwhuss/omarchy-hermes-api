//! Settings commands: get-settings, save-settings, set-active-target,
//! set-hide-cron, set-app-window-geometry.

use crate::config::*;
use crate::fs_secure::*;
use crate::util::*;
use serde_json::{json, Value};

pub async fn handle_get_settings() {
    let settings_path = get_settings_path();
    if let Some(content) = read_bounded_file(&settings_path, MAX_SETTINGS_BYTES) {
        if let Ok(data) = js_parse(&content) {
            if data.get("endpoints").map(|e| e.is_array()).unwrap_or(false) {
                let mut data = data;
                // Strip legacy 'default' profiles (ornamental in UI).
                if let Some(eps) = data.get_mut("endpoints").and_then(|e| e.as_array_mut()) {
                    for ep in eps.iter_mut() {
                        match ep.get_mut("profiles") {
                            Some(Value::Array(profs)) => {
                                profs.retain(|p| {
                                    let name = match p {
                                        Value::String(s) => Some(s.clone()),
                                        Value::Object(_) => p
                                            .get("name")
                                            .and_then(|n| n.as_str())
                                            .map(|s| s.to_string()),
                                        _ => None,
                                    };
                                    name.map(|n| !n.is_empty() && n.to_lowercase() != "default")
                                        .unwrap_or(false)
                                });
                            }
                            _ => {
                                if let Some(o) = ep.as_object_mut() {
                                    o.insert("profiles".into(), json!([]));
                                }
                            }
                        }
                    }
                }
                let app_window = sanitize_app_window(data.get("appWindow"));
                json_line(&obj(vec![
                    ("success", json!(true)),
                    ("seeded", json!(false)),
                    (
                        "settings",
                        obj(vec![
                            (
                                "activeTarget",
                                data.get("activeTarget").cloned().unwrap_or_else(|| {
                                    obj(vec![
                                        ("endpointId", json!("all")),
                                        ("profileName", json!("all")),
                                    ])
                                }),
                            ),
                            (
                                "hideCronSessions",
                                json!(data.get("hideCronSessions") == Some(&json!(true))),
                            ),
                            ("appWindow", app_window),
                            ("endpoints", data["endpoints"].clone()),
                        ]),
                    ),
                ]));
                return;
            }
        }
    }
    json_line(&obj(vec![
        ("success", json!(true)),
        ("seeded", json!(true)),
        ("settings", build_seeded_settings()),
    ]));
}

pub fn sanitize_app_window(raw: Option<&Value>) -> Value {
    if let Some(raw) = raw {
        if raw.is_object() {
            let width = js_parse_int(raw.get("width").unwrap_or(&Value::Null))
                .filter(|w| !w.is_nan() && *w != 0.0)
                .map(|w| w as i64)
                .unwrap_or(800);
            let height = js_parse_int(raw.get("height").unwrap_or(&Value::Null))
                .filter(|h| !h.is_nan() && *h != 0.0)
                .map(|h| h as i64)
                .unwrap_or(650);
            return obj(vec![
                ("width", json!(width.max(560))),
                ("height", json!(height.max(480))),
            ]);
        }
    }
    obj(vec![("width", json!(800)), ("height", json!(650))])
}

pub fn build_seeded_settings() -> Value {
    let hermes_env = load_hermes_env_file();
    let default_port = env_or_process("API_SERVER_PORT", &hermes_env, "HERMES_API_SERVER_PORT")
        .or_else(|| env_get(&hermes_env, "PORT").map(|s| s.to_string()))
        .and_then(|s| js_parse_int(&json!(s)))
        .filter(|p| !p.is_nan() && *p != 0.0)
        .map(|p| p as u16)
        .unwrap_or(8642);
    let raw_url = env_or_process("API_SERVER_URL", &hermes_env, "HERMES_API_SERVER_URL");
    let parsed = parse_endpoint_url(raw_url.as_deref().unwrap_or(""), default_port, false)
        .unwrap_or(ParsedUrl {
            protocol: "http:".into(),
            hostname: "127.0.0.1".into(),
            port: Some(8642),
            origin: "http://127.0.0.1:8642".into(),
        });
    let default_key =
        env_or_process("API_SERVER_KEY", &hermes_env, "HERMES_API_SERVER_KEY").unwrap_or_default();
    let default_name = env_or_process(
        "HERMES_API_SERVER_NAME",
        &hermes_env,
        "HERMES_API_SERVER_NAME",
    )
    .unwrap_or_else(|| "Local Hermes".to_string());

    obj(vec![
        (
            "activeTarget",
            obj(vec![
                ("endpointId", json!("all")),
                ("profileName", json!("all")),
            ]),
        ),
        ("hideCronSessions", json!(false)),
        ("appWindow", sanitize_app_window(None)),
        (
            "endpoints",
            json!([obj(vec![
                ("id", json!("endpoint-default")),
                ("name", json!(default_name)),
                ("url", json!(parsed.origin)),
                ("port", json!(default_port)),
                ("apiKey", json!(default_key)),
                ("profiles", json!([])),
            ])]),
        ),
    ])
}

pub async fn handle_save_settings(raw_input: Option<&str>) {
    let mut json_string = raw_input.map(|s| s.to_string());
    if json_string.is_none() || json_string.as_deref() == Some("--stdin") {
        json_string = read_stdin_line_or_eof(MAX_SETTINGS_BYTES).await;
    }

    let json_string = match json_string {
        Some(s) if !s.trim().is_empty() => s,
        _ => {
            json_line(&obj(vec![
                ("success", json!(false)),
                ("error", json!("No settings data provided to save")),
            ]));
            return;
        }
    };

    let data = match js_parse(&json_string) {
        Ok(d) => d,
        Err(_) => {
            json_line(&obj(vec![
                ("success", json!(false)),
                ("error", json!("Invalid JSON format: JSON Parse error")),
            ]));
            return;
        }
    };

    let endpoints = match data.get("endpoints") {
        Some(Value::Array(e)) => e.clone(),
        _ => {
            json_line(&obj(vec![
                ("success", json!(false)),
                (
                    "error",
                    json!("Settings must contain an \"endpoints\" array"),
                ),
            ]));
            return;
        }
    };
    if endpoints.is_empty() {
        json_line(&obj(vec![
            ("success", json!(false)),
            ("error", json!("At least one endpoint is required")),
        ]));
        return;
    }

    let fail = |msg: String| {
        json_line(&obj(vec![("success", json!(false)), ("error", json!(msg))]));
    };

    let mut validated: Vec<Value> = Vec::new();
    for (i, ep) in endpoints.iter().enumerate() {
        if !ep.is_object() {
            fail(format!("Endpoint #{} must be a valid object", i + 1));
            return;
        }
        let name = ep
            .get("name")
            .and_then(|n| n.as_str())
            .map(|s| s.trim().to_string())
            .unwrap_or_default();
        if name.is_empty() {
            fail(format!("Endpoint #{} display name is required", i + 1));
            return;
        }
        let url = ep
            .get("url")
            .and_then(|u| u.as_str())
            .map(|s| s.trim().to_string())
            .unwrap_or_default();
        if url.is_empty() {
            fail(format!("Endpoint \"{name}\" URL is required"));
            return;
        }
        let parsed_url = match parse_endpoint_url(&url, 8642, true) {
            Ok(p) => p,
            Err(_) => {
                fail(format!(
                    "Endpoint \"{name}\" has an invalid URL format: {}",
                    ep.get("url").map(js_string).unwrap_or_default()
                ));
                return;
            }
        };
        if parsed_url.protocol == "http:" && !is_private_or_loopback_host(&parsed_url.hostname) {
            fail(format!("Endpoint \"{name}\" must use HTTPS for remote hosts (HTTP is only permitted for loopback or private networks)"));
            return;
        }
        let clean_url = format!("{}//{}", parsed_url.protocol, parsed_url.hostname);

        let ep_port_val = ep.get("port");
        let mut port: Option<f64> = match ep_port_val {
            Some(v) if !v.is_null() => js_parse_int(v),
            _ => Some(8642.0),
        };
        if let Some(pp) = parsed_url.port {
            let ep_falsy = match ep_port_val {
                None | Some(Value::Null) => true,
                Some(v) => !truthy(v),
            };
            let ep_eq_8642 = ep_port_val.and_then(js_parse_int) == Some(8642.0);
            if ep_falsy || ep_eq_8642 {
                port = Some(pp as f64);
            }
        }
        let port_num = match port {
            Some(p) if (1.0..=65535.0).contains(&p) => p,
            _ => {
                fail(format!(
                    "Endpoint \"{name}\" port must be an integer between 1 and 65535 (got {})",
                    match ep_port_val {
                        Some(v) if !v.is_null() => js_string(v),
                        _ => "undefined".into(),
                    }
                ));
                return;
            }
        };

        let id = ep
            .get("id")
            .and_then(|i| i.as_str())
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty())
            .unwrap_or_else(|| format!("endpoint-{}-{}", to_base36(now_ms()), rand_base36(5)));

        let api_key = ep
            .get("apiKey")
            .and_then(|k| k.as_str())
            .map(sanitize_header_value)
            .unwrap_or_default();

        let parse_cw = |val: Option<&Value>, err_prefix: &str| -> Result<Option<i64>, String> {
            match val {
                None | Some(Value::Null) => Ok(None),
                Some(Value::String(s)) if s.is_empty() => Ok(None),
                Some(v) => match js_parse_int(v) {
                    Some(cw) if cw >= 1.0 => Ok(Some(cw as i64)),
                    _ => Err(format!(
                        "{err_prefix} context window must be a positive integer (got {})",
                        js_string(v)
                    )),
                },
            }
        };

        let context_window =
            match parse_cw(ep.get("contextWindow"), &format!("Endpoint \"{name}\"")) {
                Ok(v) => v,
                Err(e) => {
                    fail(e);
                    return;
                }
            };

        let mut profiles: Vec<Value> = Vec::new();
        if let Some(profs) = ep.get("profiles").and_then(|p| p.as_array()) {
            for (j, prof) in profs.iter().enumerate() {
                let mut prof_name = String::new();
                let mut prof_key = String::new();
                let mut prof_cw: Option<i64> = None;
                match prof {
                    Value::String(s) => prof_name = s.trim().to_string(),
                    Value::Object(_) => {
                        prof_name = prof
                            .get("name")
                            .and_then(|n| n.as_str())
                            .map(|s| s.trim().to_string())
                            .unwrap_or_default();
                        prof_key = prof
                            .get("apiKey")
                            .and_then(|k| k.as_str())
                            .map(sanitize_header_value)
                            .unwrap_or_default();
                        match parse_cw(
                            prof.get("contextWindow"),
                            &format!("Profile #{} in endpoint \"{name}\"", j + 1),
                        ) {
                            Ok(v) => prof_cw = v,
                            Err(e) => {
                                fail(e);
                                return;
                            }
                        }
                    }
                    _ => {}
                }
                if prof_name.to_lowercase() == "default" {
                    continue;
                }
                if prof_name.is_empty() {
                    fail(format!(
                        "Profile #{} in endpoint \"{name}\" must have a name",
                        j + 1
                    ));
                    return;
                }
                let mut po = obj(vec![
                    ("name", json!(prof_name)),
                    ("apiKey", json!(prof_key)),
                ]);
                if let Some(cw) = prof_cw {
                    po["contextWindow"] = json!(cw);
                }
                profiles.push(po);
            }
        }

        let mut ep_obj = obj(vec![
            ("id", json!(id)),
            ("name", json!(name)),
            ("url", json!(clean_url)),
            ("port", json!(port_num as i64)),
            ("apiKey", json!(api_key)),
            ("profiles", Value::Array(profiles)),
        ]);
        if let Some(cw) = context_window {
            ep_obj["contextWindow"] = json!(cw);
        }
        validated.push(ep_obj);
    }

    let mut active_target = data.get("activeTarget").cloned();
    if active_target.is_none() {
        let existing = load_settings_file();
        if let Some(e) = existing {
            active_target = e.get("activeTarget").cloned();
        }
    }

    let existing = if data.get("hideCronSessions").is_none() || data.get("appWindow").is_none() {
        load_settings_file()
    } else {
        None
    };
    let hide_cron = match data.get("hideCronSessions") {
        Some(v) => *v == json!(true),
        None => existing
            .as_ref()
            .map(|e| e.get("hideCronSessions") == Some(&json!(true)))
            .unwrap_or(false),
    };
    let clean_app_window = match data.get("appWindow") {
        Some(v) => sanitize_app_window(Some(v)),
        None => sanitize_app_window(existing.as_ref().and_then(|e| e.get("appWindow"))),
    };

    let clean_settings = obj(vec![
        (
            "activeTarget",
            active_target.unwrap_or_else(|| {
                obj(vec![
                    ("endpointId", json!("all")),
                    ("profileName", json!("all")),
                ])
            }),
        ),
        ("hideCronSessions", json!(hide_cron)),
        ("appWindow", clean_app_window),
        ("endpoints", Value::Array(validated)),
    ]);

    match write_atomic_settings(&clean_settings) {
        Ok(()) => json_line(&obj(vec![
            ("success", json!(true)),
            ("settings", clean_settings),
        ])),
        Err(err) => json_line(&obj(vec![
            ("success", json!(false)),
            (
                "error",
                json!(format!("Failed to write settings file: {err}")),
            ),
        ])),
    }
}

pub async fn handle_set_active_target(endpoint_id: Option<&str>, profile_name: Option<&str>) {
    let mut settings = load_settings_file().unwrap_or_else(|| json!({ "endpoints": [] }));
    let at = obj(vec![
        ("endpointId", json!(endpoint_id.unwrap_or("all"))),
        ("profileName", json!(profile_name.unwrap_or("all"))),
    ]);
    settings["activeTarget"] = at.clone();
    match write_atomic_settings(&settings) {
        Ok(()) => json_line(&obj(vec![("success", json!(true)), ("activeTarget", at)])),
        Err(err) => json_line(&obj(vec![
            ("success", json!(false)),
            (
                "error",
                json!(format!("Failed to save active target: {err}")),
            ),
        ])),
    }
}

async fn mutate_setting(key: &str, val: Value, err_message: &str) {
    let settings_path = get_settings_path();
    let mut settings = if settings_path.exists() {
        match load_settings_file() {
            Some(s) => s,
            None => {
                json_line(&obj(vec![
                    ("success", json!(false)),
                    ("error", json!(err_message)),
                ]));
                return;
            }
        }
    } else {
        build_seeded_settings()
    };
    settings[key] = val.clone();
    match write_atomic_settings(&settings) {
        Ok(()) => {
            let mut out = serde_json::Map::new();
            out.insert("success".into(), json!(true));
            out.insert(key.to_string(), val);
            json_line(&Value::Object(out));
        }
        Err(err) => json_line(&obj(vec![
            ("success", json!(false)),
            ("error", json!(format!("Failed to save {key}: {err}"))),
        ])),
    }
}

pub async fn handle_set_app_window_geometry(width_str: Option<&str>, height_str: Option<&str>) {
    let width = width_str.and_then(|s| js_parse_int(&json!(s)));
    let height = height_str.and_then(|s| js_parse_int(&json!(s)));
    if width.is_none() || height.is_none() {
        json_line(&obj(vec![
            ("success", json!(false)),
            ("error", json!("Width and height must be valid integers")),
        ]));
        return;
    }
    let aw = obj(vec![
        ("width", json!(width.unwrap().max(560.0) as i64)),
        ("height", json!(height.unwrap().max(480.0) as i64)),
    ]);
    mutate_setting(
        "appWindow",
        aw,
        "Settings file is invalid; fix or remove it before changing window geometry",
    )
    .await;
}

pub async fn handle_set_hide_cron(value: Option<&str>) {
    mutate_setting(
        "hideCronSessions",
        json!(value == Some("true")),
        "Settings file is invalid; fix or remove it before changing this preference",
    )
    .await;
}

/// JS readStdinLineOrEof: first line of stdin (or EOF -> empty).
pub async fn read_stdin_line_or_eof(max_bytes: usize) -> Option<String> {
    use tokio::io::{AsyncBufReadExt, BufReader};
    let stdin = tokio::io::stdin();
    let mut reader = BufReader::new(stdin);
    let mut line = String::new();
    match reader.read_line(&mut line).await {
        Ok(0) => Some(String::new()),
        Ok(_) => {
            while line.ends_with('\n') || line.ends_with('\r') {
                line.pop();
            }
            Some(line.chars().take(max_bytes).collect())
        }
        Err(_) => None,
    }
}
