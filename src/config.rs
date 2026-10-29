//! Configuration resolution: ~/.hermes/.env, settings.json, profiles, endpoints.

use crate::util::*;
use serde_json::{json, Value};
use std::path::PathBuf;
use url::Url;

pub fn home_dir() -> PathBuf {
    std::env::var_os("HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("/"))
}

pub fn get_settings_path() -> PathBuf {
    home_dir()
        .join(".config")
        .join("omarchy-hermes-api")
        .join("settings.json")
}

pub fn is_loopback_host(hostname: &str) -> bool {
    hostname == "127.0.0.1" || hostname == "localhost" || hostname == "::1" || hostname == "[::1]"
}

pub fn is_private_or_loopback_host(hostname: &str) -> bool {
    if hostname.is_empty() {
        return false;
    }
    let h = hostname.to_lowercase();
    if is_loopback_host(&h) {
        return true;
    }
    if h.ends_with(".ts.net") || h.ends_with(".local") {
        return true;
    }
    if let Some(octets) = parse_ipv4(&h) {
        if octets.iter().any(|o| *o > 255) {
            return false;
        }
        if octets[0] == 10 {
            return true;
        }
        if octets[0] == 172 && (16..=31).contains(&octets[1]) {
            return true;
        }
        if octets[0] == 192 && octets[1] == 168 {
            return true;
        }
        if octets[0] == 169 && octets[1] == 254 {
            return true;
        }
    }
    false
}

/// Matches JS /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/
fn parse_ipv4(h: &str) -> Option<[u32; 4]> {
    let parts: Vec<&str> = h.split('.').collect();
    if parts.len() != 4 {
        return None;
    }
    let mut out = [0u32; 4];
    for (i, p) in parts.iter().enumerate() {
        if p.is_empty() || p.len() > 3 || !p.bytes().all(|b| b.is_ascii_digit()) {
            return None;
        }
        out[i] = p.parse().ok()?;
    }
    Some(out)
}

pub fn sanitize_header_value(val: &str) -> String {
    val.chars()
        .filter(|c| *c != '\r' && *c != '\n' && *c != '\0')
        .collect::<String>()
        .trim()
        .to_string()
}

/// Parsed endpoint URL with JS-URL-parity origin computation.
pub struct ParsedUrl {
    pub protocol: String,
    pub hostname: String,
    pub port: Option<u16>,
    pub origin: String,
}

fn default_url() -> ParsedUrl {
    ParsedUrl {
        protocol: "http:".into(),
        hostname: "127.0.0.1".into(),
        port: Some(8642),
        origin: "http://127.0.0.1:8642".into(),
    }
}

/// JS `parseEndpointUrl(rawUrl, defaultPort, strict)`.
pub fn parse_endpoint_url(raw_url: &str, default_port: u16, strict: bool) -> Result<ParsedUrl, ()> {
    let mut url = raw_url.trim().to_string();
    if url.is_empty() {
        url = format!("http://127.0.0.1:{default_port}");
    }
    if !url.starts_with("http://") && !url.starts_with("https://") {
        url = format!("http://{url}");
    }
    match Url::parse(&url) {
        Ok(mut p) => {
            let scheme = p.scheme().to_string() + ":";
            let hostname = p.host_str().unwrap_or("").to_string();
            if p.port().is_none() && default_port != 0 {
                let _ = p.set_port(Some(default_port));
            }
            let port = p.port();
            let origin = js_origin(&scheme, &hostname, port);
            Ok(ParsedUrl {
                protocol: scheme,
                hostname,
                port,
                origin,
            })
        }
        Err(_) => {
            if strict {
                Err(())
            } else {
                Ok(default_url())
            }
        }
    }
}

/// WHATWG URL.origin for http/https (default ports dropped).
fn js_origin(scheme: &str, hostname: &str, port: Option<u16>) -> String {
    let host = if hostname.contains(':') && !hostname.starts_with('[') {
        format!("[{hostname}]")
    } else {
        hostname.to_string()
    };
    let effective = match port {
        Some(p)
            if !(scheme == "http:" && p == 80) && !(scheme == "https:" && p == 443) && p != 0 =>
        {
            Some(p)
        }
        _ => None,
    };
    match effective {
        Some(p) => format!("{scheme}//{host}:{p}"),
        None => format!("{scheme}//{host}"),
    }
}

/// Parse ~/.hermes/.env style files (quotes stripped, # comments).
pub fn parse_env_content(content: &str) -> Vec<(String, String)> {
    let mut vars = Vec::new();
    for line in content.split('\n') {
        let trimmed = line.trim();
        if trimmed.is_empty() || trimmed.starts_with('#') {
            continue;
        }
        if let Some(eq_idx) = trimmed.find('=') {
            let key = trimmed[..eq_idx].trim().to_string();
            let mut val = trimmed[eq_idx + 1..].trim().to_string();
            if ((val.starts_with('"') && val.ends_with('"'))
                || (val.starts_with('\'') && val.ends_with('\'')))
                && val.len() >= 2
            {
                val = val[1..val.len() - 1].to_string();
            }
            vars.push((key, val));
        }
    }
    vars
}

pub fn load_hermes_env_file() -> Vec<(String, String)> {
    let env_path = home_dir().join(".hermes").join(".env");
    match crate::fs_secure::read_bounded_file(&env_path, MAX_ENV_BYTES) {
        Some(content) => parse_env_content(&content),
        None => Vec::new(),
    }
}

pub fn env_get<'a>(vars: &'a [(String, String)], key: &str) -> Option<&'a str> {
    vars.iter()
        .rev()
        .find(|(k, _)| k == key)
        .map(|(_, v)| v.as_str())
}

pub fn env_or_process(key: &str, hermes_env: &[(String, String)], env_key: &str) -> Option<String> {
    if let Ok(v) = std::env::var(env_key) {
        if !v.is_empty() {
            return Some(v);
        }
    }
    env_get(hermes_env, key).map(|s| s.to_string())
}

pub fn load_settings_file() -> Option<Value> {
    let path = get_settings_path();
    let content = crate::fs_secure::read_bounded_file(&path, MAX_SETTINGS_BYTES)?;
    let parsed = js_parse(&content).ok()?;
    if parsed
        .get("endpoints")
        .map(|e| e.is_array())
        .unwrap_or(false)
    {
        Some(parsed)
    } else {
        None
    }
}

pub fn discover_local_hermes_profiles() -> Vec<(String, String)> {
    let profiles_dir = home_dir().join(".hermes").join("profiles");
    let mut discovered = Vec::new();
    let entries = match std::fs::read_dir(&profiles_dir) {
        Ok(e) => e,
        Err(_) => return discovered,
    };
    for entry in entries.flatten() {
        if !entry.path().is_dir() {
            continue;
        }
        let prof_name = entry.file_name().to_string_lossy().to_string();
        let valid = !prof_name.is_empty()
            && prof_name != "."
            && prof_name != ".."
            && prof_name
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-'));
        if !valid || prof_name.to_lowercase() == "default" {
            continue;
        }
        let mut api_key = String::new();
        let env_path = profiles_dir.join(&prof_name).join(".env");
        if let Some(content) = crate::fs_secure::read_bounded_file(&env_path, MAX_ENV_BYTES) {
            for (k, v) in parse_env_content(&content) {
                if k == "API_SERVER_KEY" {
                    api_key = v;
                }
            }
        }
        discovered.push((prof_name, api_key));
    }
    discovered
}

pub struct SessionIdentifier {
    pub endpoint_id: Option<String>,
    pub profile_name: Option<String>,
    pub raw_session_id: String,
}

pub fn parse_session_identifier(
    session_id: Option<&str>,
    opt_endpoint: Option<&str>,
    opt_profile: Option<&str>,
) -> SessionIdentifier {
    let sid = session_id.unwrap_or("");
    if sid.is_empty() {
        return SessionIdentifier {
            endpoint_id: opt_endpoint.map(|s| s.to_string()),
            profile_name: opt_profile.map(|s| s.to_string()),
            raw_session_id: String::new(),
        };
    }
    let mut endpoint_id = opt_endpoint.map(|s| s.to_string());
    let mut profile_name = opt_profile.map(|s| s.to_string());
    let parts: Vec<&str> = sid.split(':').collect();
    let raw = if parts.len() >= 3 {
        if endpoint_id.is_none() {
            endpoint_id = Some(parts[0].to_string());
        }
        if profile_name.is_none() {
            profile_name = Some(parts[1].to_string());
        }
        parts[2..].join(":")
    } else {
        sid.to_string()
    };
    SessionIdentifier {
        endpoint_id,
        profile_name,
        raw_session_id: raw,
    }
}

pub fn get_agent_monogram(name: &str) -> String {
    let trimmed = name.trim();
    if trimmed.is_empty() {
        return "H".into();
    }
    let words: Vec<&str> = trimmed
        .split(|c: char| c.is_whitespace() || c == '-' || c == '_')
        .filter(|w| !w.is_empty())
        .collect();
    if words.len() >= 2 {
        let a = words[0].chars().next().unwrap();
        let b = words[1].chars().next().unwrap();
        return format!("{a}{b}").to_uppercase();
    }
    let single = words.first().copied().unwrap_or("");
    if single.is_empty() {
        return "H".into();
    }
    let uppers: Vec<char> = single.chars().filter(|c| c.is_ascii_uppercase()).collect();
    if uppers.len() >= 2 {
        return format!("{}{}", uppers[0], uppers[1]).to_uppercase();
    }
    single.chars().next().unwrap().to_uppercase().to_string()
}

pub fn get_agent_color(name: &str) -> String {
    let palette = [
        "#6366F1", "#8B5CF6", "#EC4899", "#F43F5E", "#0EA5E9", "#06B6D4", "#10B981", "#14B8A6",
        "#F59E0B", "#3B82F6",
    ];
    if name.is_empty() {
        return palette[0].to_string();
    }
    // JS: hash = (hash << 5) - hash + charCodeAt; hash |= 0  (32-bit signed)
    let mut hash: i32 = 0;
    for u in name.encode_utf16() {
        hash = hash
            .wrapping_shl(5)
            .wrapping_sub(hash)
            .wrapping_add(u as i32);
    }
    let idx = (hash.unsigned_abs() as usize) % palette.len();
    palette[idx].to_string()
}

pub fn get_default_endpoint() -> Value {
    let hermes_env = load_hermes_env_file();
    let default_port = env_or_process("API_SERVER_PORT", &hermes_env, "HERMES_API_SERVER_PORT")
        .or_else(|| env_get(&hermes_env, "PORT").map(|s| s.to_string()))
        .and_then(|s| js_parse_int(&json!(s)))
        .filter(|p| !p.is_nan() && *p != 0.0)
        .map(|p| p as u16)
        .unwrap_or(8642);
    let raw_url = env_or_process("API_SERVER_URL", &hermes_env, "HERMES_API_SERVER_URL");
    let default_url_str = raw_url.as_deref().unwrap_or("");
    let parsed = parse_endpoint_url(default_url_str, default_port, false).unwrap_or(default_url());
    let default_key =
        env_or_process("API_SERVER_KEY", &hermes_env, "HERMES_API_SERVER_KEY").unwrap_or_default();
    let default_name = env_or_process(
        "HERMES_API_SERVER_NAME",
        &hermes_env,
        "HERMES_API_SERVER_NAME",
    )
    .unwrap_or_else(|| "Local Hermes".to_string());

    obj(vec![
        ("id", json!("endpoint-default")),
        ("name", json!(default_name)),
        ("url", json!(parsed.origin)),
        ("port", json!(default_port)),
        ("apiKey", json!(default_key)),
        ("profiles", json!([])),
    ])
}

#[allow(dead_code)] // parity with the Node bridge config shape
pub struct ResolvedConfig {
    pub endpoint_id: String,
    pub endpoint_name: String,
    pub profile_name: String,
    pub is_default: bool,
    pub root_url: String,
    pub base_url: String,
    pub api_prefix: String,
    pub api_key: String,
    pub server_name: String,
}

pub fn resolve_config(
    target_endpoint_id: Option<&str>,
    target_profile_name: Option<&str>,
) -> Result<ResolvedConfig, String> {
    let hermes_env = load_hermes_env_file();
    let settings = load_settings_file();

    let mut target_endpoint: Option<Value> = None;
    if let Some(ref s) = settings {
        if let Some(eps) = s.get("endpoints").and_then(|e| e.as_array()) {
            if !eps.is_empty() {
                if let Some(tei) = target_endpoint_id {
                    if tei != "all" {
                        target_endpoint = eps
                            .iter()
                            .find(|e| {
                                e.get("id").and_then(|v| v.as_str()) == Some(tei)
                                    || e.get("name").and_then(|v| v.as_str()) == Some(tei)
                            })
                            .cloned();
                    }
                }
                if target_endpoint.is_none() {
                    let at_id = s
                        .get("activeTarget")
                        .and_then(|a| a.get("endpointId"))
                        .and_then(|v| v.as_str());
                    if let Some(at) = at_id {
                        if at != "all" {
                            target_endpoint = eps
                                .iter()
                                .find(|e| {
                                    e.get("id").and_then(|v| v.as_str()) == Some(at)
                                        || e.get("name").and_then(|v| v.as_str()) == Some(at)
                                })
                                .cloned();
                        }
                    }
                }
                if target_endpoint.is_none() {
                    target_endpoint = Some(eps[0].clone());
                }
            }
        }
    }

    // Precedence: explicit env vars > settings.json > ~/.hermes/.env > default 8642
    let port_str = env_or_process("API_SERVER_PORT", &hermes_env, "HERMES_API_SERVER_PORT")
        .or_else(|| {
            target_endpoint
                .as_ref()
                .and_then(|e| e.get("port"))
                .filter(|p| truthy(p))
                .map(js_string)
        })
        .or_else(|| env_get(&hermes_env, "API_SERVER_PORT").map(|s| s.to_string()))
        .or_else(|| env_get(&hermes_env, "PORT").map(|s| s.to_string()))
        .unwrap_or_else(|| "8642".to_string());
    let default_port = js_parse_int(&json!(port_str))
        .filter(|p| !p.is_nan() && *p != 0.0)
        .map(|p| p as u16)
        .unwrap_or(8642);

    let raw_url = env_or_process("API_SERVER_URL", &hermes_env, "HERMES_API_SERVER_URL")
        .or_else(|| {
            target_endpoint
                .as_ref()
                .and_then(|e| e.get("url"))
                .filter(|u| truthy(u))
                .map(js_string)
        })
        .or_else(|| env_get(&hermes_env, "API_SERVER_URL").map(|s| s.to_string()))
        .unwrap_or_else(|| format!("http://127.0.0.1:{default_port}"));
    let parsed_url = parse_endpoint_url(&raw_url, default_port, false).unwrap_or(default_url());

    let endpoint_id = target_endpoint
        .as_ref()
        .and_then(|e| e.get("id"))
        .and_then(|v| v.as_str())
        .unwrap_or("endpoint-default")
        .to_string();
    let endpoint_name = first_truthy(
        [
            target_endpoint
                .as_ref()
                .and_then(|e| e.get("name"))
                .cloned()
                .unwrap_or(Value::Null),
            env_or_process(
                "HERMES_API_SERVER_NAME",
                &hermes_env,
                "HERMES_API_SERVER_NAME",
            )
            .map(|s| json!(s))
            .unwrap_or(Value::Null),
        ],
        json!("Hermes"),
    );
    let endpoint_name = js_string(&endpoint_name);

    let root_url = parsed_url.origin.clone();
    let raw_key = first_truthy(
        [
            target_endpoint
                .as_ref()
                .and_then(|e| e.get("apiKey"))
                .cloned()
                .unwrap_or(Value::Null),
            env_or_process("API_SERVER_KEY", &hermes_env, "HERMES_API_SERVER_KEY")
                .map(|s| json!(s))
                .unwrap_or(Value::Null),
        ],
        json!(""),
    );
    let endpoint_api_key = sanitize_header_value(&js_string(&raw_key));

    let mut resolved_profile = target_profile_name.map(|s| s.to_string());
    if resolved_profile.is_none() {
        if let Some(ref s) = settings {
            let at = s.get("activeTarget");
            let same_ep = at
                .and_then(|a| a.get("endpointId"))
                .and_then(|v| v.as_str())
                == Some(endpoint_id.as_str());
            if same_ep {
                resolved_profile = at
                    .and_then(|a| a.get("profileName"))
                    .and_then(|v| v.as_str())
                    .map(|s| s.to_string());
            }
        }
    }
    if resolved_profile.is_none()
        || resolved_profile.as_deref() == Some("all")
        || resolved_profile.as_deref() == Some("")
    {
        resolved_profile = Some("default".to_string());
    }
    let resolved_profile = resolved_profile.unwrap();
    let is_default_profile = resolved_profile.to_lowercase() == "default";

    let insecure = |final_key: &str| -> Option<String> {
        if parsed_url.protocol == "http:"
            && !is_private_or_loopback_host(&parsed_url.hostname)
            && !final_key.is_empty()
        {
            Some(format!(
                "Insecure transport: refusing to send API credentials over unencrypted HTTP to remote host '{}'. Use HTTPS.",
                parsed_url.hostname
            ))
        } else {
            None
        }
    };

    if is_default_profile {
        if let Some(msg) = insecure(&endpoint_api_key) {
            return Err(msg);
        }
        Ok(ResolvedConfig {
            endpoint_id,
            endpoint_name: endpoint_name.clone(),
            profile_name: "default".into(),
            is_default: true,
            root_url: root_url.clone(),
            base_url: format!("{root_url}/v1"),
            api_prefix: "/api".into(),
            api_key: endpoint_api_key,
            server_name: endpoint_name,
        })
    } else {
        let mut prof_api_key = String::new();
        if let Some(ep) = target_endpoint.as_ref() {
            if let Some(profs) = ep.get("profiles").and_then(|p| p.as_array()) {
                let found = profs.iter().find(|p| {
                    let n = match p {
                        Value::String(s) => Some(s.clone()),
                        Value::Object(_) => p.get("name").filter(|n| n.is_string()).map(js_string),
                        _ => None,
                    };
                    n.map(|n| n.to_lowercase()).filter(|n| !n.is_empty())
                        == Some(resolved_profile.to_lowercase())
                });
                if let Some(f) = found {
                    if f.is_object() {
                        if let Some(k) = f.get("apiKey").filter(|k| truthy(k)) {
                            prof_api_key = sanitize_header_value(&js_string(k));
                        }
                    }
                }
            }
        }
        let is_local = is_loopback_host(&parsed_url.hostname);
        if prof_api_key.is_empty() && is_local {
            let discovered = discover_local_hermes_profiles();
            if let Some((_, k)) = discovered
                .iter()
                .find(|(n, _)| n.to_lowercase() == resolved_profile.to_lowercase())
            {
                if !k.is_empty() {
                    prof_api_key = sanitize_header_value(k);
                }
            }
        }
        let final_api_key = if !prof_api_key.is_empty() {
            prof_api_key
        } else {
            endpoint_api_key
        };
        if let Some(msg) = insecure(&final_api_key) {
            return Err(msg);
        }
        let enc_prof = percent_encode_profile(&resolved_profile);
        Ok(ResolvedConfig {
            endpoint_id,
            endpoint_name: endpoint_name.clone(),
            profile_name: resolved_profile.clone(),
            is_default: false,
            root_url: root_url.clone(),
            base_url: format!("{root_url}/p/{enc_prof}/v1"),
            api_prefix: format!("/p/{enc_prof}/api"),
            api_key: final_api_key,
            server_name: format!("{endpoint_name} ({resolved_profile})"),
        })
    }
}

/// JS encodeURIComponent (encodes everything except A-Za-z0-9 - _ . ! ~ * ' ( )).
pub fn percent_encode_profile(s: &str) -> String {
    let mut out = String::new();
    for b in s.as_bytes() {
        let c = *b as char;
        if c.is_ascii_alphanumeric()
            || matches!(c, '-' | '_' | '.' | '!' | '~' | '*' | '\'' | '(' | ')')
        {
            out.push(c);
        } else {
            out.push_str(&format!("%{b:02X}"));
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn monograms() {
        assert_eq!(get_agent_monogram("Luna Bot"), "LB");
        assert_eq!(get_agent_monogram("LunaBot"), "LB");
        assert_eq!(get_agent_monogram("Lunabot"), "L");
        assert_eq!(get_agent_monogram("aryabot"), "A");
        assert_eq!(get_agent_monogram("Deep Research Agent"), "DR");
        assert_eq!(get_agent_monogram(""), "H");
    }

    #[test]
    fn colors_match_js_hash() {
        // Expected values computed from the JS algorithm:
        // hash = (hash << 5) - hash + charCodeAt; |0; abs % 10
        fn js_color(name: &str) -> String {
            let palette = [
                "#6366F1", "#8B5CF6", "#EC4899", "#F43F5E", "#0EA5E9", "#06B6D4", "#10B981",
                "#14B8A6", "#F59E0B", "#3B82F6",
            ];
            let mut hash: i32 = 0;
            for u in name.encode_utf16() {
                hash = (hash.wrapping_shl(5))
                    .wrapping_sub(hash)
                    .wrapping_add(u as i32);
            }
            palette[hash.unsigned_abs() as usize % 10].to_string()
        }
        for name in [
            "Luna Bot",
            "LunaBot",
            "Lunabot",
            "aryabot",
            "Deep Research Agent",
            "Local Hermes",
            "Hermes",
            "coder",
            "🖥️ terminal",
        ] {
            assert_eq!(get_agent_color(name), js_color(name), "color for {name}");
        }
        assert_eq!(get_agent_color(""), "#6366F1");
    }

    #[test]
    fn private_hosts() {
        assert!(is_private_or_loopback_host("127.0.0.1"));
        assert!(is_private_or_loopback_host("localhost"));
        assert!(is_private_or_loopback_host("10.1.2.3"));
        assert!(is_private_or_loopback_host("172.16.0.1"));
        assert!(is_private_or_loopback_host("172.31.255.255"));
        assert!(!is_private_or_loopback_host("172.32.0.1"));
        assert!(is_private_or_loopback_host("192.168.1.1"));
        assert!(is_private_or_loopback_host("169.254.1.1"));
        assert!(is_private_or_loopback_host("foo.ts.net"));
        assert!(is_private_or_loopback_host("bar.local"));
        assert!(!is_private_or_loopback_host("example.com"));
        assert!(!is_private_or_loopback_host("8.8.8.8"));
        assert!(!is_private_or_loopback_host("999.1.1.1"));
        assert!(!is_private_or_loopback_host(""));
    }

    #[test]
    fn endpoint_url_parity() {
        let p = parse_endpoint_url("", 8642, false).unwrap();
        assert_eq!(p.origin, "http://127.0.0.1:8642");
        let p = parse_endpoint_url("example.com", 9000, false).unwrap();
        assert_eq!(p.origin, "http://example.com:9000");
        let p = parse_endpoint_url("https://example.com", 9000, false).unwrap();
        assert_eq!(p.origin, "https://example.com:9000");
        let p = parse_endpoint_url("http://example.com:80", 9000, false).unwrap();
        assert_eq!(p.origin, "http://example.com:9000");
        let p = parse_endpoint_url("http://[::1]:8642", 0, false).unwrap();
        assert_eq!(p.origin, "http://[::1]:8642");
        assert!(parse_endpoint_url("http://", 8642, true).is_err());
        let p = parse_endpoint_url("http://", 8642, false).unwrap();
        assert_eq!(p.origin, "http://127.0.0.1:8642");
    }

    #[test]
    fn session_identifier_parsing() {
        let s = parse_session_identifier(Some("ep1:prof1:abc:def"), None, None);
        assert_eq!(s.endpoint_id.as_deref(), Some("ep1"));
        assert_eq!(s.profile_name.as_deref(), Some("prof1"));
        assert_eq!(s.raw_session_id, "abc:def");
        let s = parse_session_identifier(Some("plain"), None, None);
        assert_eq!(s.endpoint_id, None);
        assert_eq!(s.raw_session_id, "plain");
        let s = parse_session_identifier(Some("a:b:c"), Some("x"), Some("y"));
        assert_eq!(s.endpoint_id.as_deref(), Some("x"));
        assert_eq!(s.profile_name.as_deref(), Some("y"));
        assert_eq!(s.raw_session_id, "c");
        let s = parse_session_identifier(None, Some("x"), None);
        assert_eq!(s.raw_session_id, "");
        assert_eq!(s.endpoint_id.as_deref(), Some("x"));
    }

    #[test]
    fn env_parsing() {
        let vars = parse_env_content("# c\nA=1\n B = \"two\" \nC='three'\nD=4 # not stripped\n");
        assert_eq!(vars[0], ("A".into(), "1".into()));
        assert_eq!(vars[1], ("B".into(), "two".into()));
        assert_eq!(vars[2], ("C".into(), "three".into()));
        assert_eq!(vars[3], ("D".into(), "4 # not stripped".into()));
    }

    #[test]
    fn percent_encoding() {
        assert_eq!(percent_encode_profile("coder"), "coder");
        assert_eq!(percent_encode_profile("a b/c"), "a%20b%2Fc");
    }
}
