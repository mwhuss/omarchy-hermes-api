//! Omarchy Hermes API Bridge (Rust).
//!
//! Subprocess bridge connecting Quickshell QML to the Hermes Agent API
//! server. Protocol-identical to the original Node.js bridge: same CLI,
//! same NDJSON stdout events, same security bounds.

mod config;
mod fs_secure;
mod http;
mod sessions;
mod settings;
mod stream;
mod util;

use serde_json::{json, Value};
use std::process::exit;
use stream::StreamOptions;

struct CliOptions {
    endpoint: Option<String>,
    profile: Option<String>,
    rest: Vec<String>,
}

/// JS parseCliOptions.
fn parse_cli_options(args: &[String]) -> CliOptions {
    let mut endpoint = None;
    let mut profile = None;
    let mut rest: Vec<String> = Vec::new();
    let mut i = 0;
    while i < args.len() {
        let a = args[i].as_str();
        if a == "--" {
            rest.extend(args[i + 1..].iter().cloned());
            break;
        }
        if (a == "-e" || a == "--endpoint") && i + 1 < args.len() {
            endpoint = Some(args[i + 1].clone());
            i += 2;
            continue;
        }
        if (a == "-p" || a == "--profile") && i + 1 < args.len() {
            profile = Some(args[i + 1].clone());
            i += 2;
            continue;
        }
        if let Some(v) = a.strip_prefix("--endpoint=") {
            endpoint = Some(v.to_string());
        } else if let Some(v) = a.strip_prefix("--profile=") {
            profile = Some(v.to_string());
        } else {
            rest.push(a.to_string());
        }
        i += 1;
    }
    CliOptions {
        endpoint,
        profile,
        rest,
    }
}

fn arg(rest: &[String], idx: usize) -> Option<&str> {
    rest.get(idx).map(|s| s.as_str())
}

#[tokio::main]
async fn main() {
    let raw_args: Vec<String> = std::env::args().skip(1).collect();
    let CliOptions {
        endpoint,
        profile,
        rest,
    } = parse_cli_options(&raw_args);
    let command = rest.first().map(|s| s.as_str()).unwrap_or("status");

    match command {
        "status" => sessions::handle_status(endpoint.as_deref(), profile.as_deref()).await,
        "list-targets" => sessions::handle_list_targets().await,
        "set-active-target" => {
            let ep = arg(&rest, 1).or(endpoint.as_deref());
            let prof = arg(&rest, 2).or(profile.as_deref());
            settings::handle_set_active_target(ep, prof).await;
        }
        "list-sessions" => {
            sessions::handle_list_sessions(endpoint.as_deref(), profile.as_deref()).await
        }
        "get-session" => {
            sessions::handle_get_session(arg(&rest, 1), endpoint.as_deref(), profile.as_deref())
                .await
        }
        "rename-session" => {
            let title = if rest.len() > 2 {
                rest[2..].join(" ")
            } else {
                String::new()
            };
            sessions::handle_rename_session(
                arg(&rest, 1),
                &title,
                endpoint.as_deref(),
                profile.as_deref(),
            )
            .await
        }
        "delete-session" => {
            sessions::handle_delete_session(arg(&rest, 1), endpoint.as_deref(), profile.as_deref())
                .await
        }
        "get-settings" => settings::handle_get_settings().await,
        "save-settings" => settings::handle_save_settings(arg(&rest, 1)).await,
        "set-hide-cron" => settings::handle_set_hide_cron(arg(&rest, 1)).await,
        "set-app-window-geometry" => {
            settings::handle_set_app_window_geometry(arg(&rest, 1), arg(&rest, 2)).await
        }
        "stream-chat" => {
            let mut session_id: Option<String> = None;
            let mut prompt = String::new();
            let mut model = "hermes-agent".to_string();
            let mut system_prompt = String::new();
            let mut history: Vec<Value> = Vec::new();
            let mut stream_endpoint = endpoint.clone();
            let mut stream_profile = profile.clone();

            let mut i = 1;
            while i < rest.len() {
                let a = rest[i].as_str();
                if (a == "--session" || a == "--session-id") && i + 1 < rest.len() {
                    session_id = Some(rest[i + 1].clone());
                    i += 2;
                } else if a == "--prompt" && i + 1 < rest.len() {
                    prompt = rest[i + 1].clone();
                    i += 2;
                } else if (a == "--system" || a == "--system-prompt") && i + 1 < rest.len() {
                    system_prompt = rest[i + 1].clone();
                    i += 2;
                } else if a == "--model" && i + 1 < rest.len() {
                    model = rest[i + 1].clone();
                    i += 2;
                } else if a == "--notify" {
                    i += 1;
                } else if a == "--history" && i + 1 < rest.len() {
                    history = util::js_parse(&rest[i + 1])
                        .ok()
                        .and_then(|v| v.as_array().cloned())
                        .unwrap_or_default();
                    i += 2;
                } else if a == "--json-input" {
                    if let Some(line) = settings::read_stdin_line_or_eof(262144).await {
                        if let Ok(parsed) = util::js_parse(&line) {
                            session_id = first_str(&parsed, "sessionId").or(session_id);
                            if let Some(p) = first_str(&parsed, "prompt") {
                                prompt = p;
                            }
                            if let Some(sp) = first_str(&parsed, "systemPrompt")
                                .or_else(|| first_str(&parsed, "system"))
                            {
                                system_prompt = sp;
                            }
                            if let Some(m) = first_str(&parsed, "model") {
                                model = m;
                            }
                            if let Some(h) = parsed.get("history").and_then(|h| h.as_array()) {
                                history = h.clone();
                            }
                            if let Some(e) = first_str(&parsed, "endpoint") {
                                stream_endpoint = Some(e);
                            }
                            if let Some(pn) = first_str(&parsed, "profile") {
                                stream_profile = Some(pn);
                            }
                        }
                    }
                    i += 1;
                } else {
                    i += 1;
                }
            }

            let opts = StreamOptions {
                session_id,
                prompt,
                model,
                history,
                system_prompt,
                endpoint: stream_endpoint,
                profile: stream_profile,
            };
            if let Err(err) = stream::handle_stream_chat(opts).await {
                eprintln!("{}", json!({"success": false, "error": err}));
            }
        }
        _ => {
            util::json_line(&obj_unknown(command));
            exit(1);
        }
    }
}

fn first_str(v: &Value, key: &str) -> Option<String> {
    v.get(key).filter(|x| util::truthy(x)).map(util::js_string)
}

fn obj_unknown(command: &str) -> Value {
    util::obj(vec![
        ("success", json!(false)),
        ("error", json!(format!("Unknown command: {command}. Available: status, list-targets, set-active-target, list-sessions, get-session, delete-session, rename-session, stream-chat, get-settings, save-settings, set-hide-cron, set-app-window-geometry"))),
    ])
}

#[cfg(test)]
mod tests {
    use super::*;

    fn s(v: &[&str]) -> Vec<String> {
        v.iter().map(|x| x.to_string()).collect()
    }

    #[test]
    fn cli_basic() {
        let r = parse_cli_options(&s(&["status"]));
        assert_eq!(r.endpoint, None);
        assert_eq!(r.profile, None);
        assert_eq!(r.rest, s(&["status"]));
    }

    #[test]
    fn cli_delimiter() {
        let r = parse_cli_options(&s(&["get-session", "--", "my-session-id"]));
        assert_eq!(r.rest, s(&["get-session", "my-session-id"]));
        assert_eq!(r.endpoint, None);
    }

    #[test]
    fn cli_flags_before_delimiter() {
        let r = parse_cli_options(&s(&[
            "rename-session",
            "--endpoint",
            "ep1",
            "--profile",
            "prof1",
            "--",
            "my-session-id",
            "New Title",
        ]));
        assert_eq!(r.endpoint.as_deref(), Some("ep1"));
        assert_eq!(r.profile.as_deref(), Some("prof1"));
        assert_eq!(r.rest, s(&["rename-session", "my-session-id", "New Title"]));
    }

    #[test]
    fn cli_short_flags() {
        let r = parse_cli_options(&s(&[
            "-e",
            "ep2",
            "-p",
            "prof2",
            "delete-session",
            "--",
            "sid",
        ]));
        assert_eq!(r.endpoint.as_deref(), Some("ep2"));
        assert_eq!(r.profile.as_deref(), Some("prof2"));
        assert_eq!(r.rest, s(&["delete-session", "sid"]));
    }

    #[test]
    fn cli_equals_syntax() {
        let r = parse_cli_options(&s(&[
            "--endpoint=ep3",
            "--profile=prof3",
            "get-session",
            "--",
            "sid",
        ]));
        assert_eq!(r.endpoint.as_deref(), Some("ep3"));
        assert_eq!(r.profile.as_deref(), Some("prof3"));
        assert_eq!(r.rest, s(&["get-session", "sid"]));
    }

    #[test]
    fn cli_after_delimiter_is_positional() {
        let r = parse_cli_options(&s(&[
            "rename-session",
            "--",
            "--session-that-looks-like-a-flag",
            "--endpoint",
        ]));
        assert_eq!(r.endpoint, None);
        assert_eq!(
            r.rest,
            s(&[
                "rename-session",
                "--session-that-looks-like-a-flag",
                "--endpoint"
            ])
        );
    }
}
