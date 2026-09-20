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
 *   - QML (QJSEngine): imported with a qualifier (e.g. `import "bin/url-guard.js" as UrlGuard`).
 *     `module` is undefined here, so the Node export block is skipped.
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

// Cap Markdown input to prevent memory exhaustion on oversized payloads
var MAX_MARKDOWN_LENGTH = 1048576;

/**
 * Sanitize Markdown text before rendering with Qt Quick Text.MarkdownText.
 *
 * Removes image/resource nodes and raw rich-text constructs from untrusted
 * API/assistant responses to prevent the long-lived desktop shell from
 * resolving attacker-selected external or local resource URLs (SSRF, local
 * file leakage, unsolicited requests, unbounded image/resource decoding).
 *
 * Intended formatting (headers, lists, bold, italics, code blocks, blockquotes)
 * and safe web hyperlinks are preserved. Clicked links continue to route
 * through `openSafeUrl(link)` and the strict URL allowlist.
 *
 * @param {*} markdown
 * @returns {string}
 */
function sanitizeMarkdown(markdown) {
  if (typeof markdown !== "string") return "";
  var text = markdown;
  if (text.length > MAX_MARKDOWN_LENGTH) {
    text = text.slice(0, MAX_MARKDOWN_LENGTH);
  }

  // Protect code blocks and inline code spans from modification.
  // CommonMark parsers (including Qt's md4c) treat text inside code blocks as
  // literal glyphs and never interpret them as images or HTML tags.
  var codeBlocks = [];
  var tokenPrefix = "\uE000CODE_" + Math.random().toString(36).slice(2) + "_";

  // 1. Fenced code blocks (3+ backticks or tildes)
  text = text.replace(/(?:^|\n)([ \t]*)(`{3,}|~{3,})[^\n]*\n[\s\S]*?\n\1\2[ \t]*(?=\n|$)/g, function(match) {
    var lead = "";
    var block = match;
    if (match.charAt(0) === "\n") {
      lead = "\n";
      block = match.slice(1);
    }
    var idx = codeBlocks.length;
    codeBlocks.push(block);
    return lead + tokenPrefix + idx + "\uE001";
  });

  // 2. Inline code spans (1+ backticks)
  text = text.replace(/(`+)(?:[^\n`]|[\s\S]*?[^\n`])\1/g, function(match) {
    var idx = codeBlocks.length;
    codeBlocks.push(match);
    return tokenPrefix + idx + "\uE001";
  });

  // 3. Neutralize inline markdown images: ![alt](url optional_title)
  // Images with allowed web URLs become clickable text links: [Image: alt](url).
  // Images with dangerous/local schemes (file:, data:, etc.) become plain labels: [Image: alt].
  text = text.replace(/(?:\\+)?!+\s*\[([\s\S]*?)\]\((?:<([^>]+)>|([^\s\)]+))(?:\s+(?:"[^"]*"|'[^']*'|\([^)]*\)))?\)/g, function(match, alt, u1, u2) {
    var rawUrl = (u1 || u2 || "").trim();
    var cleanAlt = (alt || "").replace(/[\r\n]+/g, " ").trim();
    var label = cleanAlt ? ("Image: " + cleanAlt) : "Image";
    if (isAllowedWebUrl(rawUrl)) {
      return "[" + label + "](" + rawUrl + ")";
    }
    return "[" + label + "]";
  });

  // 4. Neutralize reference-style images: ![alt][ref] or ![ref][]
  text = text.replace(/(?:\\+)?!+\s*\[([\s\S]*?)\](?:\[([\s\S]*?)\])/g, function(match, alt, ref) {
    var cleanAlt = (alt || "").replace(/[\r\n]+/g, " ").trim();
    var label = cleanAlt ? ("Image: " + cleanAlt) : "Image";
    return "[" + label + "][" + ref + "]";
  });

  // 5. Neutralize shortcut reference images or standalone ![ref]
  text = text.replace(/(?:\\+)?!+\s*\[([\s\S]*?)\]/g, function(match, alt) {
    var cleanAlt = (alt || "").replace(/[\r\n]+/g, " ").trim();
    var label = cleanAlt ? ("Image: " + cleanAlt) : "Image";
    return "[" + label + "]";
  });

  // 6. Clean up any orphaned exclamation marks directly before brackets
  text = text.replace(/(?:\\+)?!+\s*\[/g, "[");

  // 7. Strip dangerous HTML blocks: scripts, styles, svg, objects, iframes, comments, cdata, doctype
  text = text.replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, "");
  text = text.replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, "");
  text = text.replace(/<svg\b[^<]*(?:(?!<\/svg>)<[^<]*)*<\/svg>/gi, "");
  text = text.replace(/<object\b[^<]*(?:(?!<\/object>)<[^<]*)*<\/object>/gi, "");
  text = text.replace(/<iframe\b[^<]*(?:(?!<\/iframe>)<[^<]*)*<\/iframe>/gi, "");
  text = text.replace(/<!--[\s\S]*?-->/g, "");
  text = text.replace(/<!\[CDATA\[[\s\S]*?\]\]>/gi, "");
  text = text.replace(/<\?[\s\S]*?\?>/g, "");
  text = text.replace(/<!DOCTYPE[^>]*>/gi, "");

  // 8. Convert safe HTML <a> links to markdown links, drop dangerous hrefs
  text = text.replace(/<a\b[^>]*href=["']?([^"'\s>]+)["']?[^>]*>([\s\S]*?)<\/a>/gi, function(match, href, body) {
    var cleanHref = href.replace(/^["']|["']$/g, "").trim();
    var textBody = body.replace(/<[^>]+>/g, "").trim();
    if (isAllowedWebUrl(cleanHref)) {
      return "[" + (textBody || cleanHref) + "](" + cleanHref + ")";
    }
    return textBody;
  });

  // 9. Convert safe web autolinks <https://...> to markdown links, strip other <...>
  text = text.replace(/<((?:https?):\/\/[^\s>]+)>/gi, function(match, url) {
    if (isAllowedWebUrl(url)) {
      return "[" + url + "](" + url + ")";
    }
    return "";
  });

  // 10. Strip all remaining HTML/XML tags
  text = text.replace(/<[a-zA-Z\/!?][^>]*>/g, "");
  text = text.replace(/<[a-zA-Z\/!?][^>]*$/g, "");

  // 11. Restore protected code blocks literally
  for (var i = 0; i < codeBlocks.length; i++) {
    text = text.replace(tokenPrefix + i + "\uE001", function() {
      return codeBlocks[i];
    });
  }

  return text;
}

// Dual export: QML sees the top-level functions; Node gets module.exports.
if (typeof module !== "undefined" && module.exports) {
  module.exports = {
    isAllowedWebUrl: isAllowedWebUrl,
    openSafeUrl: openSafeUrl,
    sanitizeMarkdown: sanitizeMarkdown
  };
}
