#!/usr/bin/env node

/**
 * Omarchy Hermes API Bridge
 * 
 * Subprocess bridge connecting Quickshell QML to the Hermes Agent API server.
 * Uses native fetch and SSE streaming for OpenAI-compatible and Hermes endpoints.
 */

// Defensive Node runtime version check (Node 18+ required for native fetch)
const [nodeMajor] = process.versions.node.split('.').map(Number);
if (nodeMajor < 18) {
  process.stderr.write(`Error: Node.js 18.0.0 or higher is required (current: ${process.version})\n`);
  process.exit(1);
}

const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const readline = require('readline');
const { URL } = require('url');

const MAX_SETTINGS_BYTES = 65536;
const MAX_ENV_BYTES = 32768;
const MAX_STREAM_CHARS = 262144;
const MAX_FETCH_BYTES = 1048576;
// SSE lines are small (a single data: chunk); the idle timer resets on every
// chunk, so a single huge line with no newline would grow lineBuffer without
// bound. Cap the pending line before it is processed.
const MAX_SSE_LINE_CHARS = 1048576;
// tool_progress forwarding caps (per stream): a malicious configured endpoint
// must not be able to grow process memory without limit by streaming unlimited
// tool events, nor hold a stream open indefinitely.
const MAX_TOOL_EVENTS = 500;
const MAX_TOOL_EVENT_BYTES = 4096;
// Total-duration ceiling for one stream-chat request. Unlike the idle timer
// this never resets, so dribbling one byte at a time cannot keep the stream
// alive forever. Overridable via env for tests only.
const MAX_STREAM_DURATION_MS = parseInt(process.env.HERMES_STREAM_DURATION_MS, 10) || 600000;

function isLoopbackHost(hostname) {
  return hostname === '127.0.0.1' || hostname === 'localhost' || hostname === '::1' || hostname === '[::1]';
}

function isPrivateOrLoopbackHost(hostname) {
  if (!hostname || typeof hostname !== 'string') return false;
  const h = hostname.toLowerCase();
  if (isLoopbackHost(h)) return true;
  if (h.endsWith('.ts.net') || h.endsWith('.local')) return true;
  const ipv4Match = h.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (ipv4Match) {
    const octets = ipv4Match.slice(1).map(Number);
    if (octets.some(o => o < 0 || o > 255)) return false;
    if (octets[0] === 10) return true;
    if (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31) return true;
    if (octets[0] === 192 && octets[1] === 168) return true;
    if (octets[0] === 169 && octets[1] === 254) return true;
  }
  return false;
}

function parseEndpointUrl(rawUrl, defaultPort = 8642, strict = false) {
  let url = String(rawUrl || `http://127.0.0.1:${defaultPort}`).trim();
  if (!url.startsWith('http://') && !url.startsWith('https://')) {
    url = `http://${url}`;
  }
  try {
    const p = new URL(url);
    if (!p.port && defaultPort) p.port = String(defaultPort);
    return p;
  } catch (e) {
    if (strict) throw e;
    return new URL(`http://127.0.0.1:${defaultPort}`);
  }
}

function sanitizeHeaderValue(val) {
  return String(val || '').replace(/[\r\n\0]/g, '').trim();
}

function readBoundedFile(filePath, maxBytes = MAX_SETTINGS_BYTES) {
  try {
    if (!fs.existsSync(filePath)) return null;
    const st = fs.statSync(filePath);
    if (!st.isFile() || st.size > maxBytes) return null;
    if (typeof process.getuid === 'function' && st.uid !== process.getuid()) return null;
    if ((st.mode & 0o077) !== 0) {
      try { fs.chmodSync(filePath, 0o600); } catch (e) {}
    }
    return fs.readFileSync(filePath, 'utf8');
  } catch (e) {
    return null;
  }
}

async function readStdinLineOrEof(maxBytes = 262144) {
  const rl = readline.createInterface({ input: process.stdin, terminal: false });
  for await (const line of rl) {
    rl.close();
    return line.slice(0, maxBytes);
  }
  return '';
}

function ensurePrivateDir(dirPath) {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true, mode: 0o700 });
  }
  const st = fs.lstatSync(dirPath);
  if (!st.isDirectory() || st.isSymbolicLink()) {
    throw new Error(`Settings directory is not a regular directory: ${dirPath}`);
  }
  if (typeof process.getuid === 'function' && st.uid !== process.getuid()) {
    throw new Error(`Settings directory owned by untrusted UID: ${st.uid}`);
  }
  if ((st.mode & 0o077) !== 0) {
    fs.chmodSync(dirPath, 0o700);
  }
}

function writeAtomicSettings(settingsData) {
  const content = JSON.stringify(settingsData, null, 2) + '\n';
  if (Buffer.byteLength(content, 'utf8') > MAX_SETTINGS_BYTES) {
    throw new Error('Settings payload exceeds size limit');
  }

  const settingsPath = getSettingsPath();
  const dirPath = path.dirname(settingsPath);
  ensurePrivateDir(dirPath);

  const tmpPath = path.join(dirPath, `.settings.${crypto.randomBytes(6).toString('hex')}.tmp`);
  fs.writeFileSync(tmpPath, content, { mode: 0o600 });
  fs.renameSync(tmpPath, settingsPath);
  try { fs.chmodSync(settingsPath, 0o600); } catch (e) {}
}

async function boundedFetch(url, options = {}, maxBytes = MAX_FETCH_BYTES, timeoutMs = 10000) {
  const controller = new AbortController();
  // Total timeout: stays armed from request start through full body
  // consumption. Cleared only via res.boundedRelease() once the body has
  // been read (or intentionally abandoned).
  const timer = setTimeout(() => {
    controller.abort(new Error(`Request timed out after ${timeoutMs} ms`));
  }, timeoutMs);
  let released = false;
  try {
    const res = await fetch(url, {
      ...options,
      signal: controller.signal,
      redirect: 'manual'
    });
    res.boundedRelease = () => {
      if (!released) {
        released = true;
        clearTimeout(timer);
      }
    };
    return res;
  } catch (err) {
    clearTimeout(timer);
    throw err;
  }
}

async function readBoundedBody(res, maxBytes) {
  const reader = res.body.getReader();
  const decoder = new TextDecoder('utf8', { fatal: false });
  let total = 0;
  let text = '';
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        throw new Error(`Response body exceeds ${maxBytes} byte limit`);
      }
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
    return text;
  } finally {
    try { await reader.cancel(); } catch (e) {}
    res.boundedRelease?.();
  }
}

async function readBoundedText(res, maxBytes = 32768) {
  if (!res || !res.body) {
    res?.boundedRelease?.();
    return '';
  }
  const cl = res.headers?.get ? res.headers.get('content-length') : null;
  if (cl !== null && cl !== undefined) {
    if (!/^\d+$/.test(cl)) {
      res.boundedRelease?.();
      throw new Error('Invalid Content-Length header');
    }
    if (Number(cl) > maxBytes) {
      res.boundedRelease?.();
      throw new Error(`Content-Length ${cl} exceeds ${maxBytes} byte limit`);
    }
  }
  return await readBoundedBody(res, maxBytes);
}

async function readBoundedJson(res, maxBytes = MAX_FETCH_BYTES) {
  if (!res || typeof res.json !== 'function') {
    res?.boundedRelease?.();
    return {};
  }
  const cl = res.headers.get('content-length');
  if (cl !== null) {
    if (!/^\d+$/.test(cl)) {
      res.boundedRelease?.();
      throw new Error('Invalid Content-Length header');
    }
    if (Number(cl) > maxBytes) {
      res.boundedRelease?.();
      throw new Error(`Content-Length ${cl} exceeds ${maxBytes} byte limit`);
    }
  }
  if (!res.body) {
    res.boundedRelease?.();
    return {};
  }
  const text = await readBoundedBody(res, maxBytes);
  try {
    return JSON.parse(text);
  } catch (e) {
    throw new Error('Invalid JSON in response body');
  }
}

function loadHermesEnvFile() {
  const envPath = path.join(os.homedir(), '.hermes', '.env');
  const vars = {};
  const content = readBoundedFile(envPath, MAX_ENV_BYTES);
  if (content) {
    try {
      content.split('\n').forEach(line => {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) return;
        const eqIdx = trimmed.indexOf('=');
        if (eqIdx !== -1) {
          const key = trimmed.slice(0, eqIdx).trim();
          let val = trimmed.slice(eqIdx + 1).trim();
          if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
            val = val.slice(1, -1);
          }
          vars[key] = val;
        }
      });
    } catch (e) {
      // Ignore parsing errors
    }
  }
  return vars;
}

function getSettingsPath() {
  return path.join(os.homedir(), '.config', 'omarchy-hermes-api', 'settings.json');
}

function loadSettingsFile() {
  const settingsPath = getSettingsPath();
  const content = readBoundedFile(settingsPath, MAX_SETTINGS_BYTES);
  if (content) {
    try {
      const parsed = JSON.parse(content);
      if (parsed && Array.isArray(parsed.endpoints)) {
        return parsed;
      }
    } catch (e) {
      // Ignore parsing errors
    }
  }
  return null;
}

function discoverLocalHermesProfiles() {
  const profilesDir = path.join(os.homedir(), '.hermes', 'profiles');
  const discovered = [];
  try {
    if (!fs.existsSync(profilesDir)) return discovered;
    const entries = fs.readdirSync(profilesDir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory()) {
        const profName = entry.name;
        if (!/^[A-Za-z0-9._-]+$/.test(profName) || profName === '.' || profName === '..') continue;
        if (profName.toLowerCase() === 'default') continue;
        let apiKey = '';
        const envPath = path.join(profilesDir, profName, '.env');
        const content = readBoundedFile(envPath, MAX_ENV_BYTES);
        if (content) {
          try {
            content.split('\n').forEach(line => {
              const trimmed = line.trim();
              if (!trimmed || trimmed.startsWith('#')) return;
              const eqIdx = trimmed.indexOf('=');
              if (eqIdx !== -1) {
                const k = trimmed.slice(0, eqIdx).trim();
                let v = trimmed.slice(eqIdx + 1).trim();
                if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
                  v = v.slice(1, -1);
                }
                if (k === 'API_SERVER_KEY') {
                  apiKey = v;
                }
              }
            });
          } catch (e) {}
        }
        discovered.push({ name: profName, apiKey });
      }
    }
  } catch (e) {}
  return discovered;
}

function parseSessionIdentifier(sessionId, optEndpoint, optProfile) {
  if (!sessionId) return { endpointId: optEndpoint, profileName: optProfile, rawSessionId: '' };
  
  let endpointId = optEndpoint;
  let profileName = optProfile;
  let rawSessionId = sessionId;

  const parts = String(sessionId).split(':');
  if (parts.length >= 3) {
    if (!endpointId) endpointId = parts[0];
    if (!profileName) profileName = parts[1];
    rawSessionId = parts.slice(2).join(':');
  }

  return { endpointId, profileName, rawSessionId };
}

function getAgentMonogram(name) {
  if (!name || typeof name !== 'string') return 'H';
  const trimmed = name.trim();
  if (!trimmed) return 'H';

  const words = trimmed.split(/[\s\-_]+/).filter(Boolean);
  if (words.length >= 2) {
    return (words[0][0] + words[1][0]).toUpperCase();
  }

  const single = words[0];
  const upperMatches = single.match(/[A-Z]/g);
  if (upperMatches && upperMatches.length >= 2) {
    return (upperMatches[0] + upperMatches[1]).toUpperCase();
  }

  return single[0].toUpperCase();
}

function getAgentColor(name) {
  const palette = [
    '#6366F1', // Indigo
    '#8B5CF6', // Purple
    '#EC4899', // Pink
    '#F43F5E', // Rose
    '#0EA5E9', // Sky
    '#06B6D4', // Cyan
    '#10B981', // Emerald
    '#14B8A6', // Teal
    '#F59E0B', // Amber
    '#3B82F6', // Blue
  ];
  if (!name || typeof name !== 'string') return palette[0];
  let hash = 0;
  for (let i = 0; i < name.length; i++) {
    hash = (hash << 5) - hash + name.charCodeAt(i);
    hash |= 0;
  }
  const idx = Math.abs(hash) % palette.length;
  return palette[idx];
}

function getDefaultEndpoint() {
  const hermesEnv = loadHermesEnvFile();
  const defaultPort = parseInt(process.env.HERMES_API_SERVER_PORT || hermesEnv.API_SERVER_PORT || hermesEnv.PORT || '8642', 10) || 8642;
  const defaultUrl = parseEndpointUrl(process.env.HERMES_API_SERVER_URL || hermesEnv.API_SERVER_URL, defaultPort).origin;
  const defaultKey = process.env.HERMES_API_SERVER_KEY || hermesEnv.API_SERVER_KEY || '';
  const defaultName = process.env.HERMES_API_SERVER_NAME || hermesEnv.HERMES_API_SERVER_NAME || 'Local Hermes';

  return {
    id: 'endpoint-default',
    name: defaultName,
    url: defaultUrl,
    port: isNaN(defaultPort) ? 8642 : defaultPort,
    apiKey: defaultKey,
    profiles: []
  };
}

function resolveConfig(targetEndpointId, targetProfileName) {
  const hermesEnv = loadHermesEnvFile();
  const settings = loadSettingsFile();

  let targetEndpoint = null;
  if (settings && Array.isArray(settings.endpoints) && settings.endpoints.length > 0) {
    if (targetEndpointId && targetEndpointId !== 'all') {
      targetEndpoint = settings.endpoints.find(e => e.id === targetEndpointId || e.name === targetEndpointId);
    }
    if (!targetEndpoint && settings.activeTarget && settings.activeTarget.endpointId && settings.activeTarget.endpointId !== 'all') {
      targetEndpoint = settings.endpoints.find(e => e.id === settings.activeTarget.endpointId || e.name === settings.activeTarget.endpointId);
    }
    if (!targetEndpoint) {
      targetEndpoint = settings.endpoints[0];
    }
  }

  // Precedence: explicit env vars > settings.json > ~/.hermes/.env > default 8642
  const defaultPort = parseInt(process.env.HERMES_API_SERVER_PORT || (targetEndpoint && targetEndpoint.port ? String(targetEndpoint.port) : null) || hermesEnv.API_SERVER_PORT || hermesEnv.PORT || '8642', 10) || 8642;
  const rawUrl = process.env.HERMES_API_SERVER_URL || (targetEndpoint && targetEndpoint.url ? targetEndpoint.url : null) || hermesEnv.API_SERVER_URL || `http://127.0.0.1:${defaultPort}`;
  const parsedUrl = parseEndpointUrl(rawUrl, defaultPort);

  const endpointId = targetEndpoint ? targetEndpoint.id : 'endpoint-default';
  const endpointName = (targetEndpoint && targetEndpoint.name) || process.env.HERMES_API_SERVER_NAME || hermesEnv.HERMES_API_SERVER_NAME || 'Hermes';
  const rootUrl = parsedUrl.origin;
  const rawKey = (targetEndpoint && targetEndpoint.apiKey) || process.env.HERMES_API_SERVER_KEY || hermesEnv.API_SERVER_KEY || '';
  const endpointApiKey = sanitizeHeaderValue(rawKey);

  // Check profile
  let resolvedProfile = targetProfileName;
  if (!resolvedProfile && settings && settings.activeTarget && settings.activeTarget.endpointId === endpointId) {
    resolvedProfile = settings.activeTarget.profileName;
  }
  if (!resolvedProfile || resolvedProfile === 'all') {
    resolvedProfile = 'default';
  }

  const isDefaultProfile = !resolvedProfile || resolvedProfile.toLowerCase() === 'default';

  if (isDefaultProfile) {
    if (parsedUrl.protocol === 'http:' && !isPrivateOrLoopbackHost(parsedUrl.hostname) && endpointApiKey) {
      throw new Error(`Insecure transport: refusing to send API credentials over unencrypted HTTP to remote host '${parsedUrl.hostname}'. Use HTTPS.`);
    }
    return {
      id: endpointId,
      endpointId,
      endpointName,
      profileName: 'default',
      isDefault: true,
      url: rootUrl,
      rootUrl,
      baseUrl: `${rootUrl}/v1`,
      apiPrefix: '/api',
      port: parseInt(parsedUrl.port || defaultPort, 10),
      apiKey: endpointApiKey,
      serverName: endpointName
    };
  } else {
    // Custom profile
    let profApiKey = '';
    if (targetEndpoint && Array.isArray(targetEndpoint.profiles)) {
      const found = targetEndpoint.profiles.find(p => {
        const n = typeof p === 'string' ? p : p.name;
        return n && n.toLowerCase() === resolvedProfile.toLowerCase();
      });
      if (found && typeof found === 'object' && found.apiKey) {
        profApiKey = sanitizeHeaderValue(found.apiKey);
      }
    }
    const isLocal = isLoopbackHost(parsedUrl.hostname);
    if (!profApiKey && isLocal) {
      const discovered = discoverLocalHermesProfiles();
      const d = discovered.find(p => p.name.toLowerCase() === resolvedProfile.toLowerCase());
      if (d && d.apiKey) profApiKey = sanitizeHeaderValue(d.apiKey);
    }

    const finalApiKey = profApiKey || endpointApiKey;
    if (parsedUrl.protocol === 'http:' && !isPrivateOrLoopbackHost(parsedUrl.hostname) && finalApiKey) {
      throw new Error(`Insecure transport: refusing to send API credentials over unencrypted HTTP to remote host '${parsedUrl.hostname}'. Use HTTPS.`);
    }
    const encProf = encodeURIComponent(resolvedProfile);

    return {
      id: endpointId,
      endpointId,
      endpointName,
      profileName: resolvedProfile,
      isDefault: false,
      url: rootUrl,
      rootUrl,
      baseUrl: `${rootUrl}/p/${encProf}/v1`,
      apiPrefix: `/p/${encProf}/api`,
      port: parseInt(parsedUrl.port || defaultPort, 10),
      apiKey: finalApiKey,
      serverName: `${endpointName} (${resolvedProfile})`
    };
  }
}

async function handleStatus(targetEndpointId, targetProfileName) {
  let cfg;
  try {
    cfg = resolveConfig(targetEndpointId, targetProfileName);
  } catch (err) {
    console.log(JSON.stringify({
      success: false,
      connected: false,
      error: err.message
    }));
    return;
  }
  try {
    const headers = { 'Accept': 'application/json' };
    if (cfg.apiKey) {
      headers['Authorization'] = `Bearer ${cfg.apiKey}`;
    }
    const res = await boundedFetch(`${cfg.baseUrl}/models`, { headers }, 65536, 10000);

    if (res.ok) {
      const data = await readBoundedJson(res, 65536);
      const models = Array.isArray(data.data) ? data.data.map(m => m.id) : ['hermes-agent'];
      console.log(JSON.stringify({
        success: true,
        connected: true,
        endpointId: cfg.endpointId,
        profileName: cfg.profileName,
        rootUrl: cfg.rootUrl,
        baseUrl: cfg.baseUrl,
        models: models.length ? models : ['hermes-agent'],
        serverName: cfg.serverName
      }));
    } else {
      res.boundedRelease();
      console.log(JSON.stringify({
        success: false,
        connected: false,
        endpointId: cfg.endpointId,
        profileName: cfg.profileName,
        statusCode: res.status,
        baseUrl: cfg.baseUrl,
        error: `Server returned HTTP ${res.status}`,
        serverName: cfg.serverName
      }));
    }
  } catch (err) {
    console.log(JSON.stringify({
      success: false,
      connected: false,
      endpointId: cfg.endpointId,
      profileName: cfg.profileName,
      baseUrl: cfg.baseUrl,
      error: err.message,
      serverName: cfg.serverName
    }));
  }
}

async function fetchSessionsForConfig(cfg) {
  try {
    const headers = { 'Accept': 'application/json' };
    if (cfg.apiKey) {
      headers['Authorization'] = `Bearer ${cfg.apiKey}`;
    }
    let res = await boundedFetch(`${cfg.rootUrl}${cfg.apiPrefix}/sessions`, { headers }, 1048576, 10000);

    if (!res.ok) {
      res.boundedRelease();
      res = await boundedFetch(`${cfg.baseUrl}/sessions`, { headers }, 1048576, 10000);
    }

    if (!res.ok) {
      res.boundedRelease();
      return [];
    }

    const raw = await readBoundedJson(res, 1048576);
    const list = Array.isArray(raw) ? raw : (Array.isArray(raw.sessions) ? raw.sessions : (Array.isArray(raw.data) ? raw.data : []));

    return list.slice(0, 500).map((s, idx) => {
      let createdAt = s.created_at || s.createdAt || s.started_at;
      if (typeof createdAt === 'number') {
        createdAt = new Date(createdAt * 1000).toISOString();
      } else if (!createdAt) {
        createdAt = new Date().toISOString();
      }

      let updatedAt = s.updated_at || s.updatedAt || s.last_active || s.started_at;
      if (typeof updatedAt === 'number') {
        updatedAt = new Date(updatedAt * 1000).toISOString();
      } else if (!updatedAt) {
        updatedAt = createdAt;
      }

      const rawId = String(s.id || s.session_id || `session-${idx}`).slice(0, 128);
      const compositeId = `${cfg.endpointId}:${cfg.profileName}:${rawId}`;

      return {
        id: compositeId,
        raw_id: rawId,
        endpoint_id: cfg.endpointId,
        endpoint_name: cfg.endpointName,
        profile_name: cfg.profileName,
        target_id: `${cfg.endpointId}:${cfg.profileName}`,
        title: String(s.title || s.preview || s.name || `Session ${rawId}`).slice(0, 200),
        created_at: createdAt,
        updated_at: updatedAt,
        source: s.source || s.platform || 'hermes',
        message_count: typeof s.message_count === 'number' ? s.message_count : (s.messages?.length || 0),
        model: s.model || 'hermes-agent',
        monogram: getAgentMonogram(cfg.profileName !== 'default' ? cfg.profileName : cfg.endpointName),
        color: getAgentColor(cfg.profileName !== 'default' ? cfg.profileName : cfg.endpointName)
      };
    });
  } catch (err) {
    return [];
  }
}

async function handleListSessions(targetEndpointId, targetProfileName) {
  try {
    const settings = loadSettingsFile();
    const isAll = !targetEndpointId || targetEndpointId === 'all';

    let allSessions = [];

    if (!isAll) {
      const cfg = resolveConfig(targetEndpointId, targetProfileName);
      allSessions = await fetchSessionsForConfig(cfg);
    } else {
      // Query all endpoints and profiles
      const defaultEndpoint = getDefaultEndpoint();
      const endpoints = (settings && Array.isArray(settings.endpoints) && settings.endpoints.length > 0)
        ? settings.endpoints
        : [defaultEndpoint];

      const localProfiles = discoverLocalHermesProfiles();

      const fetchPromises = [];
      for (const ep of endpoints) {
        // Default profile
        const defaultCfg = resolveConfig(ep.id, 'default');
        fetchPromises.push(fetchSessionsForConfig(defaultCfg));

        // Custom profiles
        const seen = new Set(['default']);
        if (Array.isArray(ep.profiles)) {
          for (const p of ep.profiles) {
            const pName = typeof p === 'string' ? p : p.name;
            if (pName && !seen.has(pName.toLowerCase())) {
              seen.add(pName.toLowerCase());
              const profCfg = resolveConfig(ep.id, pName);
              fetchPromises.push(fetchSessionsForConfig(profCfg));
            }
          }
        }

        const epUrl = ep.url || ep.rootUrl || '';
        const isLocal = epUrl.includes('127.0.0.1') || epUrl.includes('localhost');
        if (isLocal) {
          for (const lp of localProfiles) {
            if (!seen.has(lp.name.toLowerCase())) {
              seen.add(lp.name.toLowerCase());
              const profCfg = resolveConfig(ep.id, lp.name);
              fetchPromises.push(fetchSessionsForConfig(profCfg));
            }
          }
        }
      }

      const results = await Promise.all(fetchPromises);
      for (const batch of results) {
        allSessions = allSessions.concat(batch);
      }
    }

    // Sort newest updated first
    allSessions.sort((a, b) => new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime());

    console.log(JSON.stringify({
      success: true,
      sessions: allSessions
    }));
  } catch (err) {
    console.log(JSON.stringify({
      success: false,
      error: err.message,
      sessions: []
    }));
  }
}

function formatToolContent(raw) {
  if (raw === null || raw === undefined) return { preview: '', full: '' };
  const str = typeof raw === 'string' ? raw.trim() : JSON.stringify(raw);
  try {
    let parsed = JSON.parse(str);
    if (parsed && typeof parsed === 'object') {
      let out = parsed.output ?? parsed.stdout ?? parsed.result ?? parsed;
      if (typeof out === 'string') {
        try { out = JSON.parse(out.trim()); } catch (e) {}
      }
      return {
        preview: typeof out === 'object' ? JSON.stringify(out) : (String(out).trim().split('\n')[0] || ''),
        full: typeof out === 'object' ? JSON.stringify(out, null, 2) : String(out).trim()
      };
    }
  } catch (e) {}
  return { preview: str.split('\n')[0] || '', full: str };
}

async function handleGetSession(sessionId, optEndpoint, optProfile) {
  const { endpointId, profileName, rawSessionId } = parseSessionIdentifier(sessionId, optEndpoint, optProfile);
  if (!rawSessionId) {
    console.log(JSON.stringify({ success: false, error: 'Session ID required' }));
    return;
  }

  let cfg;
  try {
    cfg = resolveConfig(endpointId, profileName);
  } catch (err) {
    console.log(JSON.stringify({ success: false, error: err.message }));
    return;
  }
  try {
    let sessionObj = {};
    const headers = { 'Accept': 'application/json' };
    if (cfg.apiKey) {
      headers['Authorization'] = `Bearer ${cfg.apiKey}`;
    }
    let sessionRes = await boundedFetch(`${cfg.rootUrl}${cfg.apiPrefix}/sessions/${encodeURIComponent(rawSessionId)}`, { headers }, 1048576, 10000);

    if (sessionRes.ok) {
      const data = await readBoundedJson(sessionRes, 1048576);
      sessionObj = data.session || data || {};
    } else {
      sessionRes.boundedRelease();
      sessionRes = await boundedFetch(`${cfg.baseUrl}/sessions/${encodeURIComponent(rawSessionId)}`, { headers }, 1048576, 10000);
      if (sessionRes.ok) {
        const data = await readBoundedJson(sessionRes, 1048576);
        sessionObj = data.session || data || {};
      } else {
        sessionRes.boundedRelease();
      }
    }

    // 2. Fetch session messages
    let msgRes = await boundedFetch(`${cfg.rootUrl}${cfg.apiPrefix}/sessions/${encodeURIComponent(rawSessionId)}/messages`, { headers }, 1048576, 10000);

    if (!msgRes.ok) {
      msgRes.boundedRelease();
      msgRes = await boundedFetch(`${cfg.baseUrl}/sessions/${encodeURIComponent(rawSessionId)}/messages`, { headers }, 1048576, 10000);
    }

    let rawMessages = [];
    if (msgRes.ok) {
      const msgData = await readBoundedJson(msgRes, 1048576);
      rawMessages = Array.isArray(msgData.data) ? msgData.data : (Array.isArray(msgData.messages) ? msgData.messages : (Array.isArray(msgData) ? msgData : []));
    } else {
      msgRes.boundedRelease();
      rawMessages = sessionObj.messages || [];
    }

    const messages = rawMessages.slice(0, 1000).filter(Boolean).map(m => {
      let parsedToolCalls = [];
      if (Array.isArray(m.tool_calls)) {
        parsedToolCalls = m.tool_calls.slice(0, 50).map(tc => {
          let fnName = tc?.function?.name || tc?.name || 'tool';
          let fnArgs = tc?.function?.arguments || tc?.arguments || '';
          let summary = '';
          let formattedArgs = '';
          try {
            const parsedArgs = typeof fnArgs === 'string' ? JSON.parse(fnArgs) : fnArgs;
            if (parsedArgs.command) summary = parsedArgs.command;
            else if (parsedArgs.code) summary = parsedArgs.code;
            else if (parsedArgs.query) summary = parsedArgs.query;
            else if (parsedArgs.path) summary = parsedArgs.path;
            else if (typeof parsedArgs === 'object') summary = JSON.stringify(parsedArgs);

            formattedArgs = typeof parsedArgs === 'object' ? JSON.stringify(parsedArgs, null, 2) : String(fnArgs);
          } catch (e) {
            summary = String(fnArgs);
            formattedArgs = String(fnArgs);
          }

          return {
            id: tc.id || tc.call_id,
            name: fnName,
            arguments: formattedArgs || (typeof fnArgs === 'string' ? fnArgs : JSON.stringify(fnArgs, null, 2)),
            summary: summary || fnName
          };
        });
      }

      let toolFormatting = null;
      if (m.role === 'tool') {
        toolFormatting = formatToolContent(m.content);
      }

      return {
        role: m.role || 'user',
        content: typeof m.content === 'string' ? m.content : JSON.stringify(m.content),
        tool_preview: toolFormatting ? toolFormatting.preview : null,
        tool_formatted: toolFormatting ? toolFormatting.full : null,
        timestamp: m.timestamp ? (typeof m.timestamp === 'number' ? new Date(m.timestamp * 1000).toISOString() : m.timestamp) : null,
        tool_calls: parsedToolCalls,
        tool_name: m.tool_name || null,
        tool_call_id: m.tool_call_id || null,
        reasoning: m.reasoning || m.reasoning_content || null
      };
    });

    const compositeId = `${cfg.endpointId}:${cfg.profileName}:${rawSessionId}`;
    console.log(JSON.stringify({
      success: true,
      id: compositeId,
      raw_id: rawSessionId,
      endpoint_id: cfg.endpointId,
      endpoint_name: cfg.endpointName,
      profile_name: cfg.profileName,
      session: {
        id: compositeId,
        raw_id: rawSessionId,
        endpoint_id: cfg.endpointId,
        endpoint_name: cfg.endpointName,
        profile_name: cfg.profileName,
        title: sessionObj.title || sessionObj.name || `Session ${rawSessionId}`,
        messages,
        created_at: sessionObj.created_at || sessionObj.started_at,
        updated_at: sessionObj.updated_at || sessionObj.last_active
      }
    }));
  } catch (err) {
    console.log(JSON.stringify({
      success: false,
      error: err.message
    }));
  }
}

async function handleDeleteSession(sessionId, optEndpoint, optProfile) {
  const { endpointId, profileName, rawSessionId } = parseSessionIdentifier(sessionId, optEndpoint, optProfile);
  if (!rawSessionId) {
    console.log(JSON.stringify({ success: false, error: 'Session ID required' }));
    return;
  }

  let cfg;
  try {
    cfg = resolveConfig(endpointId, profileName);
  } catch (err) {
    console.log(JSON.stringify({ success: false, error: err.message }));
    return;
  }
  try {
    const headers = { 'Accept': 'application/json' };
    if (cfg.apiKey) {
      headers['Authorization'] = `Bearer ${cfg.apiKey}`;
    }
    let res = await boundedFetch(`${cfg.rootUrl}${cfg.apiPrefix}/sessions/${encodeURIComponent(rawSessionId)}`, {
      method: 'DELETE',
      headers
    }, 65536, 10000);

    if (!res.ok && res.status !== 404) {
      res.boundedRelease();
      try { await res.body?.cancel(); } catch (e) {}
      res = await boundedFetch(`${cfg.baseUrl}/sessions/${encodeURIComponent(rawSessionId)}`, {
        method: 'DELETE',
        headers
      }, 65536, 10000);
    }

    // Body is intentionally not read — release the armed timeout and drop
    // the socket so the process can exit promptly.
    res.boundedRelease();
    try { await res.body?.cancel(); } catch (e) {}

    const compositeId = `${cfg.endpointId}:${cfg.profileName}:${rawSessionId}`;
    console.log(JSON.stringify({
      success: true,
      id: compositeId,
      raw_id: rawSessionId,
      endpoint_id: cfg.endpointId,
      profile_name: cfg.profileName,
      deleted: true
    }));
  } catch (err) {
    console.log(JSON.stringify({
      success: false,
      error: err.message
    }));
  }
}

function sendDesktopNotification(title, message, isError = false, appName = 'Hermes') {
  const { spawn } = require('child_process');
  let cleanMsg = String(message || '').replace(/```[\s\S]*?```/g, '[Code]').replace(/[`*_~#<>&]/g, '').replace(/[\u0000-\u001f\u007f-\u009f]/g, '').replace(/\s+/g, ' ').trim();
  if (cleanMsg.length > 140) cleanMsg = cleanMsg.slice(0, 137) + '...';
  if (!cleanMsg) cleanMsg = isError ? 'An error occurred.' : 'Response completed.';

  let cleanTitle = String(title || appName || 'Hermes').replace(/[<>&]/g, '').replace(/[\u0000-\u001f\u007f-\u009f]/g, '').replace(/\s+/g, ' ').trim();
  if (cleanTitle.length > 60) cleanTitle = cleanTitle.slice(0, 57) + '...';

  const urgency = isError ? 'critical' : 'normal';
  const bin = fs.existsSync('/usr/share/omarchy/bin/omarchy-notification-send')
    ? '/usr/share/omarchy/bin/omarchy-notification-send'
    : (fs.existsSync('/usr/bin/omarchy-notification-send') ? '/usr/bin/omarchy-notification-send' : '/usr/bin/notify-send');

  const args = bin.includes('omarchy-notification-send')
    ? ['--app-name', appName || 'Hermes', '-u', urgency, '-g', isError ? '\u{f015a}' : '\u{f06d3}', '--', cleanTitle, cleanMsg]
    : ['-a', appName || 'Hermes', '-u', urgency, '--', cleanTitle, cleanMsg];

  try {
    const child = spawn(bin, args, { detached: true, stdio: 'ignore' });
    child.on('error', () => {});
    child.unref();
  } catch (e) {}
}

async function handleStreamChat(options) {
  const { sessionId, prompt, model, history, systemPrompt, notify, endpoint, profile } = options;

  if (!prompt || typeof prompt !== 'string') {
    process.stdout.write(JSON.stringify({ type: 'error', error: 'Prompt is required' }) + '\n');
    return;
  }

  const { endpointId, profileName, rawSessionId } = parseSessionIdentifier(sessionId, endpoint, profile);
  const cfg = resolveConfig(endpointId, profileName);

  let resolvedSessionId = rawSessionId;
  if (!resolvedSessionId || String(resolvedSessionId).trim() === '') {
    const timestamp = Date.now().toString(36);
    const rand = Math.random().toString(36).substring(2, 7);
    resolvedSessionId = `api-${timestamp}-${rand}`;
  }

  const compositeId = `${cfg.endpointId}:${cfg.profileName}:${resolvedSessionId}`;

  const customHeaders = {
    'X-Hermes-Session-Id': resolvedSessionId,
    'X-Hermes-Source': 'omarchy-bar'
  };

  const messages = [];

  // Add system prompt if provided
  if (systemPrompt && typeof systemPrompt === 'string' && systemPrompt.trim() !== '') {
    messages.push({ role: 'system', content: systemPrompt.trim() });
  }

  if (Array.isArray(history)) {
    for (const m of history) {
      if (m && m.role && m.content) {
        messages.push({ role: m.role, content: m.content });
      }
    }
  }

  messages.push({ role: 'user', content: prompt });

  const isExplicitComposite = sessionId && String(sessionId).includes(':');
  const emitSessionId = isExplicitComposite ? compositeId : resolvedSessionId;

  try {
    process.stdout.write(JSON.stringify({
      type: 'start',
      session_id: emitSessionId,
      raw_session_id: resolvedSessionId,
      endpoint_id: cfg.endpointId,
      endpoint_name: cfg.endpointName,
      profile_name: cfg.profileName,
      composite_id: compositeId,
      model: model || 'hermes-agent'
    }) + '\n');

    const controller = new AbortController();
    const IDLE_TIMEOUT_MS = 60000;
    let idleTimer = setTimeout(() => {
      controller.abort(new Error('Stream request timed out due to 60s inactivity'));
    }, IDLE_TIMEOUT_MS);

    const resetIdleTimer = () => {
      clearTimeout(idleTimer);
      idleTimer = setTimeout(() => {
        controller.abort(new Error('Stream request timed out due to 60s inactivity'));
      }, IDLE_TIMEOUT_MS);
    };

    // Total-duration ceiling: never reset, so a hostile endpoint cannot hold
    // the stream open indefinitely by dribbling data.
    const durationTimer = setTimeout(() => {
      controller.abort(new Error('Stream request exceeded 10m total duration'));
    }, MAX_STREAM_DURATION_MS);

    // Per-stream tool_progress bounds. On overflow emit exactly one
    // 'truncated' notice, then drop further tool events (the stream itself
    // continues for text deltas until done/timeout).
    let toolEventCount = 0;
    let toolEventsTruncated = false;

    const truncateToBytes = (s, maxBytes) => {
      if (Buffer.byteLength(s, 'utf8') <= maxBytes) return s;
      let out = '';
      let bytes = 0;
      for (const ch of s) {
        const b = Buffer.byteLength(ch, 'utf8');
        if (bytes + b > maxBytes) break;
        out += ch;
        bytes += b;
      }
      return out;
    };

    const emitToolProgress = (ev) => {
      if (toolEventsTruncated) {
        return;
      }
      if (toolEventCount >= MAX_TOOL_EVENTS) {
        toolEventsTruncated = true;
        process.stdout.write(JSON.stringify({
          type: 'tool_progress',
          session_id: emitSessionId,
          raw_session_id: resolvedSessionId,
          composite_id: compositeId,
          tool: 'tool',
          status: 'truncated',
          label: 'Tool event limit reached',
          emoji: '',
          id: ''
        }) + '\n');
        return;
      }
      const tool = String(ev.tool || 'tool');
      const emoji = String(ev.emoji || '');
      let label = String(ev.label || '');
      let status = String(ev.status || 'running');
      let id = String(ev.id || '');
      const byteLen = (s) => Buffer.byteLength(s, 'utf8');
      // Every attacker-controlled field (tool, label, status, emoji, id) must
      // fit the per-event byte budget, or a hostile endpoint can grow the
      // retained event list without bound by padding any single field.
      const fixed = byteLen(tool) + byteLen(emoji);
      let total = fixed + byteLen(label) + byteLen(status) + byteLen(id);
      if (total > MAX_TOOL_EVENT_BYTES) {
        // Truncate label, then status, then id; drop only if tool+emoji alone exceed.
        if (fixed > MAX_TOOL_EVENT_BYTES) {
          return;
        }
        label = truncateToBytes(label, MAX_TOOL_EVENT_BYTES - fixed - byteLen(status) - byteLen(id));
        total = fixed + byteLen(label) + byteLen(status) + byteLen(id);
        if (total > MAX_TOOL_EVENT_BYTES) {
          status = truncateToBytes(status, MAX_TOOL_EVENT_BYTES - fixed - byteLen(label) - byteLen(id));
          total = fixed + byteLen(label) + byteLen(status) + byteLen(id);
        }
        if (total > MAX_TOOL_EVENT_BYTES) {
          id = truncateToBytes(id, MAX_TOOL_EVENT_BYTES - fixed - byteLen(label) - byteLen(status));
          total = fixed + byteLen(label) + byteLen(status) + byteLen(id);
          if (total > MAX_TOOL_EVENT_BYTES) {
            return;
          }
        }
      }
      toolEventCount += 1;
      process.stdout.write(JSON.stringify({
        type: 'tool_progress',
        session_id: emitSessionId,
        raw_session_id: resolvedSessionId,
        composite_id: compositeId,
        tool,
        status,
        label,
        emoji,
        id
      }) + '\n');
    };

    const endpointUrl = `${cfg.baseUrl.replace(/\/+$/, '')}/chat/completions`;
    const headers = {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${cfg.apiKey}`,
      'Accept': 'text/event-stream',
      ...customHeaders
    };

    const reqBody = JSON.stringify({
      model: model || 'hermes-agent',
      messages: messages.map(m => ({ role: m.role, content: m.content })),
      stream: true
    });

    let res;
    try {
      res = await fetch(endpointUrl, {
        method: 'POST',
        headers,
        body: reqBody,
        signal: controller.signal,
        redirect: 'manual'
      });
    } catch (fetchErr) {
      clearTimeout(idleTimer);
      clearTimeout(durationTimer);
      throw fetchErr;
    }

    if (!res.ok) {
      clearTimeout(idleTimer);
      // Keep AbortController timeout active through error-body consumption.
      // An error response should be small and arrive promptly; bound it by
      // HERMES_ERROR_BODY_TIMEOUT_MS (default 10s, overridable via env for tests).
      const errorBodyTimeoutMs = parseInt(process.env.HERMES_ERROR_BODY_TIMEOUT_MS, 10) || 10000;
      const errorBodyTimer = setTimeout(() => {
        controller.abort(new Error(`Error response body timed out after ${errorBodyTimeoutMs}ms`));
      }, errorBodyTimeoutMs);

      let errDetail = '';
      try {
        const rawText = await readBoundedText(res, 32768);
        if (rawText) {
          try {
            const errJson = JSON.parse(rawText);
            errDetail = errJson.error?.message || errJson.message || JSON.stringify(errJson);
          } catch (_) {
            errDetail = rawText.slice(0, 512);
          }
        }
      } catch (readErr) {
        if (controller.signal.aborted || /exceeds \d+ byte limit/.test(readErr.message)) {
          throw readErr;
        }
      } finally {
        clearTimeout(errorBodyTimer);
        clearTimeout(durationTimer);
        try { await res.body?.cancel(); } catch (_) {}
      }
      throw new Error(`HTTP ${res.status}${errDetail ? `: ${errDetail}` : ''}`);
    }

    if (!res.body) {
      clearTimeout(idleTimer);
      clearTimeout(durationTimer);
      throw new Error('Response body is null or undefined');
    }

    let fullText = '';
    let fullReasoning = '';
    const decoder = new TextDecoder('utf8');
    const reader = res.body.getReader();
    let lineBuffer = '';
    let currentEventType = 'message';

    const emitReasoningDelta = (reasoningText) => {
      if (fullReasoning.length < MAX_STREAM_CHARS) {
        fullReasoning += reasoningText;
        process.stdout.write(JSON.stringify({
          type: 'reasoning_delta',
          session_id: emitSessionId,
          raw_session_id: resolvedSessionId,
          composite_id: compositeId,
          content: reasoningText
        }) + '\n');
      }
    };

    const processSseLine = (line) => {
      const trimmed = line.trim();
      if (!trimmed) {
        currentEventType = 'message';
        return;
      }

      if (trimmed.startsWith(':')) {
        return;
      }

      if (trimmed.startsWith('event:')) {
        currentEventType = trimmed.slice(6).trim();
        return;
      }

      if (trimmed.startsWith('data:')) {
        const dataStr = trimmed.slice(5).trim();
        if (dataStr === '[DONE]') {
          return;
        }

        let chunk;
        try {
          chunk = JSON.parse(dataStr);
        } catch (e) {
          return;
        }

        // Handle Hermes custom SSE event: hermes.tool.progress
        const isToolProgress = currentEventType === 'hermes.tool.progress' ||
                               currentEventType === 'tool_progress' ||
                               chunk.event === 'hermes.tool.progress' ||
                               chunk.event === 'tool_progress';
        const eventData = chunk.data || chunk.hermes_event || (typeof chunk.event === 'object' ? chunk.event : (isToolProgress ? chunk : null));

        if (isToolProgress && eventData) {
          const ev = eventData;
          emitToolProgress({
            tool: ev.tool || ev.name || 'tool',
            status: ev.status || 'running',
            label: ev.label || ev.detail || ev.message || '',
            emoji: ev.emoji || '',
            id: ev.toolCallId || ev.id || ''
          });
          return;
        }

        // Handle Hermes custom SSE event: hermes.reasoning.delta
        const isReasoningEvent = currentEventType === 'hermes.reasoning.delta' ||
                                 chunk.event === 'hermes.reasoning.delta';
        if (isReasoningEvent) {
          const ev = chunk.data || chunk.hermes_event || chunk;
          const reasoningText = ev.text || ev.content || ev.reasoning;
          if (typeof reasoningText === 'string' && reasoningText) {
            emitReasoningDelta(reasoningText);
          }
          return;
        }

        // Standard OpenAI chunk structure
        const choice = Array.isArray(chunk.choices) ? chunk.choices[0] : (chunk.choices ? chunk.choices[0] : null);
        const delta = choice?.delta || chunk.delta;

        if (delta && delta.content) {
          if (fullText.length < MAX_STREAM_CHARS) {
            fullText += delta.content;
            process.stdout.write(JSON.stringify({
              type: 'delta',
              session_id: emitSessionId,
              raw_session_id: resolvedSessionId,
              composite_id: compositeId,
              content: delta.content
            }) + '\n');
          }
        }

        if (delta) {
          const reasoningChunk = typeof delta.reasoning_content === 'string'
            ? delta.reasoning_content
            : (typeof delta.reasoning === 'string' ? delta.reasoning : '');
          if (reasoningChunk) {
            emitReasoningDelta(reasoningChunk);
          }
        }

        if (delta && delta.tool_calls && Array.isArray(delta.tool_calls)) {
          for (const tc of delta.tool_calls) {
            const fn = tc?.function;
            if (fn && fn.name) {
              emitToolProgress({
                tool: fn.name,
                status: 'running',
                label: fn.arguments || '',
                id: tc.id || tc.call_id || ''
              });
            }
          }
        }
      }
    };

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        resetIdleTimer();

        lineBuffer += decoder.decode(value, { stream: true });
        if (lineBuffer.length > MAX_SSE_LINE_CHARS) {
          throw new Error(`SSE line exceeds ${MAX_SSE_LINE_CHARS} character limit`);
        }
        const lines = lineBuffer.split(/\r?\n/);
        lineBuffer = lines.pop();

        for (const line of lines) {
          processSseLine(line);
        }
      }

      if (lineBuffer && lineBuffer.trim()) {
        processSseLine(lineBuffer);
      }
    } finally {
      clearTimeout(idleTimer);
      clearTimeout(durationTimer);
      try { await reader.cancel(); } catch (_) {}
    }

    process.stdout.write(JSON.stringify({
      type: 'done',
      session_id: emitSessionId,
      raw_session_id: resolvedSessionId,
      composite_id: compositeId,
      endpoint_id: cfg.endpointId,
      profile_name: cfg.profileName,
      full_text: fullText,
      full_reasoning: fullReasoning,
      finish_reason: 'stop'
    }) + '\n');

    if (notify) {
      const notifTitle = cfg.isDefault ? cfg.endpointName : `${cfg.endpointName} (${cfg.profileName})`;
      sendDesktopNotification(notifTitle, fullText, false, cfg.serverName || notifTitle);
    }
  } catch (err) {
    process.stdout.write(JSON.stringify({
      type: 'error',
      session_id: emitSessionId,
      raw_session_id: resolvedSessionId,
      composite_id: compositeId,
      error: err.message
    }) + '\n');

    if (notify) {
      const notifTitle = cfg.isDefault ? cfg.endpointName : `${cfg.endpointName} (${cfg.profileName})`;
      sendDesktopNotification(`${notifTitle} - Error`, err.message, true, cfg.serverName || notifTitle);
    }
  }
}

async function handleRenameSession(sessionId, newTitle, optEndpoint, optProfile) {
  const { endpointId, profileName, rawSessionId } = parseSessionIdentifier(sessionId, optEndpoint, optProfile);
  if (!rawSessionId || !newTitle) {
    console.log(JSON.stringify({ success: false, error: 'Session ID and new title required' }));
    return;
  }

  let cfg;
  try {
    cfg = resolveConfig(endpointId, profileName);
  } catch (err) {
    console.log(JSON.stringify({ success: false, error: err.message }));
    return;
  }
  try {
    const headers = {
      'Content-Type': 'application/json',
      'Accept': 'application/json'
    };
    if (cfg.apiKey) {
      headers['Authorization'] = `Bearer ${cfg.apiKey}`;
    }
    const res = await boundedFetch(`${cfg.rootUrl}${cfg.apiPrefix}/sessions/${encodeURIComponent(rawSessionId)}`, {
      method: 'PATCH',
      headers,
      body: JSON.stringify({ title: String(newTitle).slice(0, 200) })
    }, 65536, 10000);

    if (!res.ok) {
      res.boundedRelease();
      console.log(JSON.stringify({ success: false, error: `Failed to rename session: ${res.status}` }));
      return;
    }

    const data = await readBoundedJson(res, 65536);
    const sessionObj = data.session || data;
    const compositeId = `${cfg.endpointId}:${cfg.profileName}:${rawSessionId}`;
    console.log(JSON.stringify({
      success: true,
      id: compositeId,
      raw_id: rawSessionId,
      endpoint_id: cfg.endpointId,
      profile_name: cfg.profileName,
      title: sessionObj.title || newTitle
    }));
  } catch (err) {
    console.log(JSON.stringify({ success: false, error: err.message }));
  }
}

async function handleListTargets() {
  const settings = loadSettingsFile() || { endpoints: [] };
  let endpoints = settings.endpoints;

  if (!endpoints || endpoints.length === 0) {
    endpoints = [getDefaultEndpoint()];
  }

  const localProfiles = discoverLocalHermesProfiles();

  // Test all endpoints in parallel
  const targetResults = await Promise.all(endpoints.map(async ep => {
    const parsedUrl = parseEndpointUrl(ep.url, ep.port || 8642);
    const rootUrl = parsedUrl.origin;
    const isLocal = isLoopbackHost(parsedUrl.hostname);

    let connected = false;
    let models = ['hermes-agent'];
    try {
      const headers = { 'Accept': 'application/json' };
      if (ep.apiKey) {
        if (parsedUrl.protocol === 'https:' || isPrivateOrLoopbackHost(parsedUrl.hostname)) {
          headers['Authorization'] = `Bearer ${sanitizeHeaderValue(ep.apiKey)}`;
        }
      }
      const res = await boundedFetch(`${rootUrl}/v1/models`, { headers }, 65536, 2500);
      if (res.ok) {
        connected = true;
        const data = await readBoundedJson(res, 65536);
        if (Array.isArray(data.data) && data.data.length > 0) {
          models = data.data.map(m => m.id);
        }
      } else {
        res.boundedRelease();
      }
    } catch (e) {
      connected = false;
    }

    // Merge profiles: default profile is always present
    const profilesList = [{
      name: 'default',
      isDefault: true,
      targetId: `${ep.id}:default`,
      displayName: `${ep.name} (default)`,
      monogram: getAgentMonogram(ep.name),
      color: getAgentColor(ep.name)
    }];

    const existingNames = new Set(['default']);
    if (Array.isArray(ep.profiles)) {
      for (const p of ep.profiles) {
        const pName = typeof p === 'string' ? p : p.name;
        if (pName && !existingNames.has(pName.toLowerCase())) {
          existingNames.add(pName.toLowerCase());
          profilesList.push({
            name: pName,
            isDefault: false,
            targetId: `${ep.id}:${pName}`,
            displayName: `${ep.name} • ${pName}`,
            monogram: getAgentMonogram(pName),
            color: getAgentColor(pName)
          });
        }
      }
    }

    if (isLocal) {
      for (const lp of localProfiles) {
        if (!existingNames.has(lp.name.toLowerCase())) {
          existingNames.add(lp.name.toLowerCase());
          profilesList.push({
            name: lp.name,
            isDefault: false,
            targetId: `${ep.id}:${lp.name}`,
            displayName: `${ep.name} • ${lp.name}`,
            monogram: getAgentMonogram(lp.name),
            color: getAgentColor(lp.name)
          });
        }
      }
    }

    return {
      id: ep.id,
      endpointId: ep.id,
      name: ep.name,
      endpointName: ep.name,
      url: ep.url,
      port: ep.port,
      connected,
      models,
      monogram: getAgentMonogram(ep.name),
      color: getAgentColor(ep.name),
      profiles: profilesList
    };
  }));

  console.log(JSON.stringify({
    success: true,
    targets: targetResults,
    activeTarget: settings.activeTarget || { endpointId: 'all', profileName: 'all' }
  }));
}

async function handleSetActiveTarget(endpointId, profileName) {
  let settings = loadSettingsFile() || { endpoints: [] };
  settings.activeTarget = {
    endpointId: endpointId || 'all',
    profileName: profileName || 'all'
  };

  try {
    writeAtomicSettings(settings);

    console.log(JSON.stringify({
      success: true,
      activeTarget: settings.activeTarget
    }));
  } catch (err) {
    console.log(JSON.stringify({
      success: false,
      error: `Failed to save active target: ${err.message}`
    }));
  }
}

async function handleGetSettings() {
  const settingsPath = getSettingsPath();
  const content = readBoundedFile(settingsPath, MAX_SETTINGS_BYTES);
  if (content) {
    try {
      const data = JSON.parse(content);
      if (data && Array.isArray(data.endpoints)) {
        // Strip any legacy 'default' profiles; default profile is purely ornamental in UI
        data.endpoints.forEach(ep => {
          if (!Array.isArray(ep.profiles)) {
            ep.profiles = [];
          } else {
            ep.profiles = ep.profiles.filter(p => {
              const name = typeof p === 'string' ? p : (p && p.name);
              return name && name.toLowerCase() !== 'default';
            });
          }
        });
        console.log(JSON.stringify({
          success: true,
          seeded: false,
          settings: {
            activeTarget: data.activeTarget || { endpointId: 'all', profileName: 'all' },
            endpoints: data.endpoints
          }
        }));
        return;
      }
    } catch (e) {
      // Fall through to seeded fallback
    }
  }

  // Seed default settings from active environment / ~/.hermes/.env
  const hermesEnv = loadHermesEnvFile();
  const defaultPort = parseInt(process.env.HERMES_API_SERVER_PORT || hermesEnv.API_SERVER_PORT || hermesEnv.PORT || '8642', 10) || 8642;
  const defaultUrl = parseEndpointUrl(process.env.HERMES_API_SERVER_URL || hermesEnv.API_SERVER_URL, defaultPort).origin;
  const defaultKey = process.env.HERMES_API_SERVER_KEY || hermesEnv.API_SERVER_KEY || '';
  const defaultName = process.env.HERMES_API_SERVER_NAME || hermesEnv.HERMES_API_SERVER_NAME || 'Local Hermes';

  const seededSettings = {
    activeTarget: { endpointId: 'all', profileName: 'all' },
    endpoints: [
      {
        id: 'endpoint-default',
        name: defaultName,
        url: defaultUrl,
        port: isNaN(defaultPort) ? 8642 : defaultPort,
        apiKey: defaultKey,
        profiles: []
      }
    ]
  };

  console.log(JSON.stringify({
    success: true,
    seeded: true,
    settings: seededSettings
  }));
}

async function handleSaveSettings(rawInput) {
  let jsonString = rawInput;
  if (!jsonString || jsonString === '--stdin') {
    try {
      jsonString = await readStdinLineOrEof(MAX_SETTINGS_BYTES);
    } catch (e) {
      // stdin read failed
    }
  }

  if (!jsonString || !jsonString.trim()) {
    console.log(JSON.stringify({
      success: false,
      error: 'No settings data provided to save'
    }));
    return;
  }

  let data;
  try {
    data = JSON.parse(jsonString);
  } catch (err) {
    console.log(JSON.stringify({
      success: false,
      error: `Invalid JSON format: ${err.message}`
    }));
    return;
  }

  if (!data || !Array.isArray(data.endpoints)) {
    console.log(JSON.stringify({
      success: false,
      error: 'Settings must contain an "endpoints" array'
    }));
    return;
  }

  if (data.endpoints.length === 0) {
    console.log(JSON.stringify({
      success: false,
      error: 'At least one endpoint is required'
    }));
    return;
  }

  const validatedEndpoints = [];
  for (let i = 0; i < data.endpoints.length; i++) {
    const ep = data.endpoints[i];
    if (!ep || typeof ep !== 'object') {
      console.log(JSON.stringify({
        success: false,
        error: `Endpoint #${i + 1} must be a valid object`
      }));
      return;
    }

    const name = typeof ep.name === 'string' ? ep.name.trim() : '';
    if (!name) {
      console.log(JSON.stringify({
        success: false,
        error: `Endpoint #${i + 1} display name is required`
      }));
      return;
    }

    let url = typeof ep.url === 'string' ? ep.url.trim() : '';
    if (!url) {
      console.log(JSON.stringify({
        success: false,
        error: `Endpoint "${name}" URL is required`
      }));
      return;
    }

    let parsedUrl;
    try {
      parsedUrl = parseEndpointUrl(url, 8642, true);
    } catch (err) {
      console.log(JSON.stringify({
        success: false,
        error: `Endpoint "${name}" has an invalid URL format: ${ep.url}`
      }));
      return;
    }

    if (parsedUrl.protocol === 'http:' && !isPrivateOrLoopbackHost(parsedUrl.hostname)) {
      console.log(JSON.stringify({
        success: false,
        error: `Endpoint "${name}" must use HTTPS for remote hosts (HTTP is only permitted for loopback or private networks)`
      }));
      return;
    }

    const cleanUrl = `${parsedUrl.protocol}//${parsedUrl.hostname}`;

    let port = ep.port !== undefined && ep.port !== null ? parseInt(ep.port, 10) : 8642;
    if (parsedUrl.port && (!ep.port || ep.port === 8642)) {
      port = parseInt(parsedUrl.port, 10);
    }

    if (isNaN(port) || port < 1 || port > 65535) {
      console.log(JSON.stringify({
        success: false,
        error: `Endpoint "${name}" port must be an integer between 1 and 65535 (got ${ep.port})`
      }));
      return;
    }

    const id = ep.id && typeof ep.id === 'string' && ep.id.trim()
      ? ep.id.trim()
      : `endpoint-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

    const apiKey = typeof ep.apiKey === 'string' ? sanitizeHeaderValue(ep.apiKey) : '';

    // Only custom profiles are saved; the default profile is ornamental in the UI and never persisted
    const profiles = [];
    if (Array.isArray(ep.profiles)) {
      for (let j = 0; j < ep.profiles.length; j++) {
        const prof = ep.profiles[j];
        let profName = '';
        let profKey = '';
        if (typeof prof === 'string') {
          profName = prof.trim();
        } else if (prof && typeof prof === 'object') {
          profName = typeof prof.name === 'string' ? prof.name.trim() : '';
          profKey = typeof prof.apiKey === 'string' ? sanitizeHeaderValue(prof.apiKey) : '';
        }

        // Never save "default" profile - it represents the built-in endpoint agent
        if (profName.toLowerCase() === 'default') {
          continue;
        }

        if (!profName) {
          console.log(JSON.stringify({
            success: false,
            error: `Profile #${j + 1} in endpoint "${name}" must have a name`
          }));
          return;
        }
        profiles.push({ name: profName, apiKey: profKey });
      }
    }

    validatedEndpoints.push({
      id,
      name,
      url: cleanUrl,
      port,
      apiKey,
      profiles
    });
  }

  let activeTarget = data.activeTarget;
  if (!activeTarget) {
    const existing = loadSettingsFile();
    if (existing && existing.activeTarget) {
      activeTarget = existing.activeTarget;
    }
  }

  const cleanSettings = {
    activeTarget: activeTarget || { endpointId: 'all', profileName: 'all' },
    endpoints: validatedEndpoints
  };

  try {
    writeAtomicSettings(cleanSettings);

    console.log(JSON.stringify({
      success: true,
      settings: cleanSettings
    }));
  } catch (err) {
    console.log(JSON.stringify({
      success: false,
      error: `Failed to write settings file: ${err.message}`
    }));
  }
}

function parseCliOptions(args) {
  let endpoint = null, profile = null;
  const rest = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--') { rest.push(...args.slice(i + 1)); break; }
    if ((a === '-e' || a === '--endpoint') && i + 1 < args.length) endpoint = args[++i];
    else if ((a === '-p' || a === '--profile') && i + 1 < args.length) profile = args[++i];
    else if (a.startsWith('--endpoint=')) endpoint = a.slice(11);
    else if (a.startsWith('--profile=')) profile = a.slice(10);
    else rest.push(a);
  }
  return { endpoint, profile, rest };
}

async function main() {
  const rawArgs = process.argv.slice(2);
  const { endpoint, profile, rest } = parseCliOptions(rawArgs);
  const command = rest[0] || 'status';

  switch (command) {
    case 'status':
      await handleStatus(endpoint, profile);
      break;

    case 'list-targets':
      await handleListTargets();
      break;

    case 'set-active-target':
      await handleSetActiveTarget(rest[1] || endpoint, rest[2] || profile);
      break;

    case 'list-sessions':
      await handleListSessions(endpoint, profile);
      break;

    case 'get-session':
      await handleGetSession(rest[1], endpoint, profile);
      break;

    case 'rename-session':
      await handleRenameSession(rest[1], rest.slice(2).join(' '), endpoint, profile);
      break;

    case 'delete-session':
      await handleDeleteSession(rest[1], endpoint, profile);
      break;

    case 'get-settings':
      await handleGetSettings();
      break;

    case 'save-settings':
      await handleSaveSettings(rest[1]);
      break;

    case 'stream-chat': {
      let sessionId = null;
      let prompt = '';
      let model = 'hermes-agent';
      let systemPrompt = '';
      let history = [];
      let notify = false;

      for (let i = 1; i < rest.length; i++) {
        if ((rest[i] === '--session' || rest[i] === '--session-id') && rest[i + 1]) {
          sessionId = rest[++i];
        } else if (rest[i] === '--prompt' && rest[i + 1]) {
          prompt = rest[++i];
        } else if ((rest[i] === '--system' || rest[i] === '--system-prompt') && rest[i + 1]) {
          systemPrompt = rest[++i];
        } else if (rest[i] === '--model' && rest[i + 1]) {
          model = rest[++i];
        } else if (rest[i] === '--notify') {
          notify = true;
        } else if (rest[i] === '--history' && rest[i + 1]) {
          try {
            history = JSON.parse(rest[++i]);
          } catch (e) {
            history = [];
          }
        } else if (rest[i] === '--json-input') {
          try {
            const stdinData = await readStdinLineOrEof(262144);
            const parsed = JSON.parse(stdinData);
            sessionId = parsed.sessionId || sessionId;
            prompt = parsed.prompt || prompt;
            systemPrompt = parsed.systemPrompt || parsed.system || systemPrompt;
            model = parsed.model || model;
            history = parsed.history || history;
            notify = parsed.notify !== undefined ? parsed.notify : notify;
            if (parsed.endpoint) endpoint = parsed.endpoint;
            if (parsed.profile) profile = parsed.profile;
          } catch (e) {
            // ignore
          }
        }
      }

      await handleStreamChat({ sessionId, prompt, model, history, systemPrompt, notify, endpoint, profile });
      break;
    }

    default:
      console.log(JSON.stringify({
        success: false,
        error: `Unknown command: ${command}. Available: status, list-targets, set-active-target, list-sessions, get-session, delete-session, rename-session, stream-chat, get-settings, save-settings`
      }));
      process.exit(1);
  }
}

if (require.main === module) {
  main().catch(err => {
    console.error(JSON.stringify({ success: false, error: err.message }));
    process.exit(1);
  });
}

module.exports = {
  parseCliOptions,
  getAgentMonogram,
  getAgentColor,
  boundedFetch,
  readBoundedJson,
  readBoundedText
};

