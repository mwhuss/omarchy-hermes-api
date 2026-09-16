/**
 * URL scheme guard for external link activation.
 *
 * Single source of truth for the strict web-scheme allowlist used by the
 * QML `onLinkActivated` handlers. Untrusted assistant/remote Markdown text can
 * carry links to local files (`file:`), data URIs, or custom desktop protocols;
 * only `http://` and `https://` links are permitted to reach
 * `Qt.openUrlExternally()`.
 *
 * A URL is allowed only when ALL of the following hold:
 *   - scheme is exactly `http` or `https` (case-insensitive);
 *   - no control characters (C0, DEL, C1) anywhere in the string;
 *   - total length (after trim) is at most MAX_URL_LENGTH;
 *   - the host is non-empty, contains no userinfo (`@`), and is a dotted
 *     domain name, an IPv4 literal, or a bracketed IPv6 literal, with an
 *     optional `:port` in range 1-65535.
 *
 * Dual-environment module:
 *   - QML (QJSEngine): top-level functions are exposed to the importing QML
 *     file's scope. `module` is undefined here, so the Node export block is
 *     skipped.
 *   - Node: `module.exports` exposes the same functions so the test suite
 *     exercises the exact code QML runs (no drift between a QML copy and a
 *     test mirror).
 */

// Browsers reject URLs far before this, but untrusted Markdown links are
// unbounded input: cap them at a small explicit bound.
var MAX_URL_LENGTH = 2048;

/**
 * Return true only when `url` is an allowed `http://` or `https://` URL.
 * Everything else — `file:`, `data:`, `qrc:`, `javascript:`, custom desktop
 * protocols, relative links, userinfo, control characters, over-length
 * strings, malformed hosts, empty strings, non-strings — is rejected.
 *
 * @param {*} url
 * @returns {boolean}
 */
function isAllowedWebUrl(url) {
  if (typeof url !== "string") return false;
  var u = url.trim();
  if (u.length === 0 || u.length > MAX_URL_LENGTH) return false;
  // Reject control characters (C0, DEL, C1) anywhere in the URL.
  if (/[\u0000-\u001f\u007f-\u009f]/.test(u)) return false;
  // Exactly http:// or https:// (case-insensitive), then a non-empty host
  // with no userinfo (@), no whitespace, no path separator, and the rest of
  // the string must be path/query/fragment only (anchored: a trailing
  // `@evil.com` after a plausible host must not pass).
  var m = u.match(/^(https?):\/\/([^\/\s@?#]+)([\/?#].*)?$/i);
  if (!m) return false;
  var host = m[2];
  if (host.charAt(0) === "[") {
    // Bracketed IPv6 literal, optionally followed by :port.
    var close = host.indexOf("]");
    if (close === -1) return false;
    if (!/^[0-9A-Fa-f:.]+$/.test(host.slice(1, close))) return false;
    var rest = host.slice(close + 1);
    if (rest !== "" &&
        (!/^:\d{1,5}$/.test(rest) || parseInt(rest.slice(1), 10) > 65535)) {
      return false;
    }
    return true;
  }
  // Split off an optional :port (single colon, digits only, valid range).
  var ci = host.lastIndexOf(":");
  if (ci !== -1) {
    if (host.indexOf(":") !== ci) return false; // second colon: not a port
    var port = host.slice(ci + 1);
    host = host.slice(0, ci);
    if (!/^\d{1,5}$/.test(port) || parseInt(port, 10) > 65535) return false;
  }
  // Dotted domain name or IPv4 literal: each label alphanumeric, no
  // leading/trailing hyphen, 1-63 chars.
  var label = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/;
  var labels = host.split(".");
  for (var i = 0; i < labels.length; i++) {
    if (!label.test(labels[i])) return false;
  }
  return true;
}

/**
 * Open `url` in the system handler only when it passes the allowlist.
 * Rejected links are silently ignored (no log noise). The exact string that
 * is validated (trimmed) is the string handed to the system handler.
 *
 * @param {*} url
 */
function openSafeUrl(url) {
  if (typeof url !== "string") return;
  var u = url.trim();
  if (isAllowedWebUrl(u) && typeof Qt !== "undefined" && Qt.openUrlExternally) {
    Qt.openUrlExternally(u);
  }
  // else: silently ignore (file:, data:, qrc:, javascript:, custom, relative)
}

// Dual export: QML sees the top-level functions; Node gets module.exports.
if (typeof module !== "undefined" && module.exports) {
  module.exports = { isAllowedWebUrl: isAllowedWebUrl, openSafeUrl: openSafeUrl };
}
