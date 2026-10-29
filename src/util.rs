//! Shared utility helpers (JS-parity semantics, bounded truncation, time, ids).

use serde_json::{Map, Value};
use std::time::{SystemTime, UNIX_EPOCH};

pub const MAX_SETTINGS_BYTES: usize = 65536;
pub const MAX_ENV_BYTES: usize = 32768;
pub const MAX_STREAM_CHARS: usize = 262144;
pub const MAX_FETCH_BYTES: usize = 1048576;
pub const MAX_SSE_LINE_CHARS: usize = 1048576;
pub const MAX_TOOL_EVENTS: usize = 500;
pub const MAX_TOOL_EVENT_BYTES: usize = 4096;

/// JS truthiness for JSON values.
pub fn truthy(v: &Value) -> bool {
    match v {
        Value::Null => false,
        Value::Bool(b) => *b,
        Value::Number(n) => n.as_f64().map(|f| f != 0.0 && !f.is_nan()).unwrap_or(true),
        Value::String(s) => !s.is_empty(),
        Value::Array(_) | Value::Object(_) => true,
    }
}

/// First truthy member of a `||` chain, else the default value.
pub fn first_truthy<V: std::borrow::Borrow<Value>>(
    vals: impl IntoIterator<Item = V>,
    default: Value,
) -> Value {
    for v in vals {
        let r = v.borrow();
        if truthy(r) {
            return r.clone();
        }
    }
    default
}

/// JS `String(value)` for JSON values.
pub fn js_string(v: &Value) -> String {
    match v {
        Value::Null => "null".into(),
        Value::Bool(b) => b.to_string(),
        Value::Number(n) => number_to_string(n.as_f64().unwrap_or(0.0)),
        Value::String(s) => s.clone(),
        Value::Array(_) | Value::Object(_) => serde_json::to_string(v).unwrap_or_default(),
    }
}

/// JS number-to-string for finite numbers.
pub fn number_to_string(f: f64) -> String {
    if f.is_nan() {
        "NaN".into()
    } else if f.is_infinite() {
        if f > 0.0 {
            "Infinity".into()
        } else {
            "-Infinity".into()
        }
    } else if f == 0.0 {
        "0".into()
    } else {
        format!("{f}")
    }
}

/// JS `Number(value)` (NaN on failure).
/// JS Number() coercion (parity helper; exercised by tests).
#[allow(dead_code)]
pub fn js_number(v: &Value) -> f64 {
    match v {
        Value::Number(n) => n.as_f64().unwrap_or(f64::NAN),
        Value::Bool(b) => {
            if *b {
                1.0
            } else {
                0.0
            }
        }
        Value::Null => 0.0,
        Value::String(s) => {
            let t = s.trim();
            if t.is_empty() {
                0.0
            } else if t.eq_ignore_ascii_case("infinity") || t.eq_ignore_ascii_case("+infinity") {
                f64::INFINITY
            } else if t.eq_ignore_ascii_case("-infinity") {
                f64::NEG_INFINITY
            } else {
                t.parse::<f64>().unwrap_or(f64::NAN)
            }
        }
        _ => f64::NAN,
    }
}

/// JS `parseInt(v, 10)` (None == NaN).
pub fn js_parse_int(v: &Value) -> Option<f64> {
    let s = match v {
        Value::String(s) => s.clone(),
        Value::Number(n) => number_to_string(n.as_f64().unwrap_or(0.0)),
        Value::Bool(true) => "true".into(),
        Value::Bool(false) => "false".into(),
        Value::Null => "null".into(),
        _ => "[object Object]".into(),
    };
    let s = s.trim_start();
    let (sign, s) = if let Some(rest) = s.strip_prefix('-') {
        (-1.0, rest)
    } else {
        (1.0, s.strip_prefix('+').unwrap_or(s))
    };
    let s = if s.starts_with("0x") || s.starts_with("0X") {
        &s[2..]
    } else {
        s
    };
    let digits: String = s.chars().take_while(|c| c.is_ascii_digit()).collect();
    if digits.is_empty() {
        return None;
    }
    digits.parse::<f64>().ok().map(|d| sign * d)
}

/// JS `JSON.parse`: single value, no trailing garbage.
pub fn js_parse(s: &str) -> Result<Value, ()> {
    let de = serde_json::Deserializer::from_str(s);
    let mut iter = de.into_iter::<Value>();
    let parsed = iter.next().ok_or(())?.map_err(|_| ())?;
    if iter.next().is_some() {
        return Err(());
    }
    Ok(parsed)
}

/// Truncate a string to at most `max_bytes` UTF-8 bytes on char boundaries.
pub fn truncate_to_bytes(s: &str, max_bytes: usize) -> String {
    if s.len() <= max_bytes {
        return s.to_string();
    }
    let mut out = String::new();
    let mut bytes = 0usize;
    for ch in s.chars() {
        let b = ch.len_utf8();
        if bytes + b > max_bytes {
            break;
        }
        out.push(ch);
        bytes += b;
    }
    out
}

/// JS `String.prototype.slice(0, n)` on chars.
pub fn slice_chars(s: &str, n: usize) -> String {
    s.chars().take(n).collect()
}

fn civil_from_days(z: i64) -> (i64, i64, i64) {
    let z = z + 719468;
    let era = if z >= 0 { z } else { z - 146096 } / 146097;
    let doe = z - era * 146097;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    (if m <= 2 { y + 1 } else { y }, m, d)
}

/// JS `new Date(ms).toISOString()` (None for out-of-range, matching Invalid Date).
pub fn iso_from_ms(ms: f64) -> Option<String> {
    if !ms.is_finite() || ms.abs() > 8.64e15 {
        return None;
    }
    let ms = ms.floor();
    let days = (ms / 1000.0 / 86400.0).floor();
    let secs_of_day = ms.rem_euclid(86_400_000.0) / 1000.0;
    let (y, mo, d) = civil_from_days(days as i64);
    let h = (secs_of_day / 3600.0) as i64;
    let mi = ((secs_of_day % 3600.0) / 60.0) as i64;
    let s = (secs_of_day % 60.0) as i64;
    let msr = (secs_of_day.fract() * 1000.0).round() as i64;
    Some(format!(
        "{y:04}-{mo:02}-{d:02}T{h:02}:{mi:02}:{s:02}.{msr:03}Z"
    ))
}

/// JS `new Date(secs * 1000).toISOString()`.
pub fn iso_from_epoch_secs(v: &Value) -> Option<String> {
    iso_from_ms(v.as_f64()? * 1000.0)
}

pub fn now_iso() -> String {
    iso_from_ms(now_ms() as f64).unwrap_or_default()
}

pub fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

pub fn to_base36(mut n: u64) -> String {
    if n == 0 {
        return "0".into();
    }
    let digits = b"0123456789abcdefghijklmnopqrstuvwxyz";
    let mut out = Vec::new();
    while n > 0 {
        out.push(digits[(n % 36) as usize]);
        n /= 36;
    }
    out.reverse();
    String::from_utf8(out).unwrap()
}

pub fn rand_base36(n: usize) -> String {
    use rand::RngExt;
    let mut rng = rand::rng();
    (0..n)
        .map(|_| {
            let d = rng.random_range(0..36u8);
            if d < 10 {
                (b'0' + d) as char
            } else {
                (b'a' + (d - 10)) as char
            }
        })
        .collect()
}

pub fn rand_hex(n_bytes: usize) -> String {
    use rand::RngExt;
    let mut rng = rand::rng();
    let bytes: Vec<u8> = (0..n_bytes).map(|_| rng.random()).collect();
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

/// Build a JSON object from ordered pairs.
pub fn obj(pairs: Vec<(&str, Value)>) -> Value {
    let mut m = Map::new();
    for (k, v) in pairs {
        m.insert(k.to_string(), v);
    }
    Value::Object(m)
}

pub fn json_line(v: &Value) {
    use std::io::Write;
    let mut out = std::io::stdout().lock();
    let _ = writeln!(out, "{}", serde_json::to_string(v).unwrap_or_default());
    let _ = out.flush();
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn number_to_string_matches_js() {
        assert_eq!(number_to_string(0.0), "0");
        assert_eq!(number_to_string(-0.0), "0");
        assert_eq!(number_to_string(37.0), "37");
        assert_eq!(number_to_string(1.5), "1.5");
        assert_eq!(number_to_string(f64::NAN), "NaN");
    }

    #[test]
    fn parse_int_matches_js() {
        assert_eq!(js_parse_int(&Value::String("1024".into())), Some(1024.0));
        assert_eq!(js_parse_int(&Value::String("abc".into())), None);
        assert_eq!(js_parse_int(&Value::String("12abc".into())), Some(12.0));
        assert_eq!(js_parse_int(&Value::String(" 42 ".into())), Some(42.0));
        assert_eq!(js_parse_int(&Value::String("-5".into())), Some(-5.0));
        assert_eq!(js_parse_int(&Value::Null), None);
        assert_eq!(js_parse_int(&Value::from(8642)), Some(8642.0));
    }

    #[test]
    fn js_number_matches() {
        assert_eq!(js_number(&Value::String("".into())), 0.0);
        assert!(js_number(&Value::String("abc".into())).is_nan());
        assert_eq!(js_number(&Value::Bool(true)), 1.0);
        assert_eq!(js_number(&Value::Null), 0.0);
    }

    #[test]
    fn iso_conversion() {
        assert_eq!(
            iso_from_ms(0.0).as_deref(),
            Some("1970-01-01T00:00:00.000Z")
        );
        assert_eq!(
            iso_from_ms(1700000000000.0).as_deref(),
            Some("2023-11-14T22:13:20.000Z")
        );
        assert_eq!(iso_from_ms(f64::NAN), None);
    }

    #[test]
    fn truncate_on_char_boundary() {
        assert_eq!(truncate_to_bytes("héllo", 3), "hé");
        assert_eq!(truncate_to_bytes("abc", 10), "abc");
        assert_eq!(truncate_to_bytes("éé", 3), "é");
    }

    #[test]
    fn base36() {
        assert_eq!(to_base36(0), "0");
        assert_eq!(to_base36(35), "z");
        assert_eq!(to_base36(36), "10");
        assert_eq!(to_base36(1234567890), "kf12oi");
    }

    #[test]
    fn js_parse_rejects_trailing_garbage() {
        assert!(js_parse("{\"a\":1}").is_ok());
        assert!(js_parse("{\"a\":1} trailing").is_err());
        assert!(js_parse("not json").is_err());
    }
}
