#!/usr/bin/env node

/**
 * Omarchy Hermes API Bridge
 * 
 * Subprocess bridge connecting Quickshell QML to the Hermes Agent API server.
 * Uses official 'openai' package for streaming and OpenAI-compatible endpoints,
 * and fetch for Hermes custom session management endpoints.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const readline = require('readline');
const { URL } = require('url');
const { OpenAI } = require('openai');

const MAX_SETTINGS_BYTES = 65536;
const MAX_ENV_BYTES = 32768;
const MAX_STREAM_CHARS = 262144;
const MAX_FETCH_BYTES = 1048576;

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

function sanitizeHeaderValue(val) {
  return String(val || '').replace(/[\r\n\0]/g, '').trim();
}

function readBoundedFile(filePath, maxBytes = MAX_SETTINGS_BYTES) {
  try {
    const flags = fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0) | (fs.constants.O_NONBLOCK || 0);
    const fd = fs.openSync(filePath, flags);
    try {
      const st = fs.fstatSync(fd);
      if (!st.isFile()) {
        return null;
      }
      if (typeof process.getuid === 'function' && st.uid !== process.getuid()) {
        return null;
      }
      if ((st.mode & 0o077) !== 0) {
        try { fs.fchmodSync(fd, 0o600); } catch (e) {}
      }
      if (st.size > maxBytes) {
        return null;
      }
      const buf = Buffer.alloc(maxBytes + 1);
      const bytesRead = fs.readSync(fd, buf, 0, maxBytes + 1, 0);
      if (bytesRead > maxBytes) {
        return null;
      }
      return buf.subarray(0, bytesRead).toString('utf8');
    } finally {
      fs.closeSync(fd);
    }
  } catch (e) {
    return null;
  }
}

function readStdinLineOrEof(maxBytes = 262144) {
  return new Promise((resolve) => {
    let buf = '';
    const rl = readline.createInterface({ input: process.stdin, terminal: false });
    let resolved = false;
    rl.on('line', (line) => {
      if (!resolved) {
        resolved = true;
        rl.close();
        resolve(line);
      }
    });
    rl.on('close', () => {
      if (!resolved) {
        resolved = true;
        resolve(buf);
      }
    });
    process.stdin.on('data', (chunk) => {
      if (!resolved) {
        buf += chunk.toString('utf8');
        if (buf.length > maxBytes) {
          resolved = true;
          rl.close();
          resolve(buf.slice(0, maxBytes));
        }
      }
    });
  });
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
  const buf = Buffer.from(content, 'utf8');
  if (buf.length > MAX_SETTINGS_BYTES) {
    throw new Error('Settings payload exceeds size limit');
  }

  const settingsPath = getSettingsPath();
  const dirPath = path.dirname(settingsPath);
  ensurePrivateDir(dirPath);

  const randSuffix = crypto.randomBytes(8).toString('hex');
  const tmpPath = path.join(dirPath, `.settings.${randSuffix}.tmp`);

  const flags = fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | (fs.constants.O_NOFOLLOW || 0);
  const fd = fs.openSync(tmpPath, flags, 0o600);
  try {
    try { fs.fchmodSync(fd, 0o600); } catch (e) {}
    fs.writeSync(fd, buf, 0, buf.length, 0);
    fs.fsyncSync(fd);
    fs.closeSync(fd);
  } catch (err) {
    try { fs.closeSync(fd); } catch (e) {}
    try { fs.unlinkSync(tmpPath); } catch (e) {}
    throw err;
  }

  try {
    fs.renameSync(tmpPath, settingsPath);
    try {
      const dirFd = fs.openSync(dirPath, fs.constants.O_RDONLY | (fs.constants.O_DIRECTORY || 0));
      fs.fsyncSync(dirFd);
      fs.closeSync(dirFd);
    } catch (e) {}
  } catch (err) {
    try { fs.unlinkSync(tmpPath); } catch (e) {}
    throw err;
  }
}

async function boundedFetch(url, options = {}, maxBytes = MAX_FETCH_BYTES, timeoutMs = 10000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      ...options,
      signal: controller.signal,
      redirect: 'manual'
    });
    clearTimeout(timer);
    return res;
  } catch (err) {
    clearTimeout(timer);
    throw err;
  }
}

async function readBoundedJson(res, maxBytes = MAX_FETCH_BYTES) {
  if (!res.body) {
    return {};
  }
  const reader = res.body.getReader();
  let totalBytes = 0;
  const chunks = [];
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    totalBytes += value.length;
    if (totalBytes > maxBytes) {
      try { await reader.cancel(); } catch (e) {}
      throw new Error(`Response body exceeded maximum allowed limit of ${maxBytes} bytes`);
    }
    chunks.push(value);
  }
  const fullBuf = Buffer.concat(chunks);
  return JSON.parse(fullBuf.toString('utf8'));
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
  const defaultPort = process.env.HERMES_API_SERVER_PORT || (targetEndpoint && targetEndpoint.port ? String(targetEndpoint.port) : null) || hermesEnv.API_SERVER_PORT || hermesEnv.PORT || '8642';
  
  let rawUrl = process.env.HERMES_API_SERVER_URL || (targetEndpoint && targetEndpoint.url ? targetEndpoint.url : null) || hermesEnv.API_SERVER_URL || `http://127.0.0.1:${defaultPort}`;

  // Normalize protocol if missing
  if (!rawUrl.startsWith('http://') && !rawUrl.startsWith('https://')) {
    rawUrl = `http://${rawUrl}`;
  }

  let parsedUrl;
  try {
    parsedUrl = new URL(rawUrl);
  } catch (e) {
    parsedUrl = new URL(`http://127.0.0.1:${defaultPort}`);
  }

  if (!parsedUrl.port) {
    parsedUrl.port = defaultPort;
  }

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
      endpointId,
      endpointName,
      profileName: 'default',
      isDefault: true,
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
      endpointId,
      endpointName,
      profileName: resolvedProfile,
      isDefault: false,
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
      res = await boundedFetch(`${cfg.baseUrl}/sessions`, { headers }, 1048576, 10000);
    }

    if (!res.ok) return [];

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
        model: s.model || 'hermes-agent'
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
      const endpoints = (settings && Array.isArray(settings.endpoints) && settings.endpoints.length > 0)
        ? settings.endpoints
        : [resolveConfig()];

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

        const isLocal = ep.url.includes('127.0.0.1') || ep.url.includes('localhost');
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
  let str = typeof raw === 'string' ? raw.trim() : JSON.stringify(raw);
  
  try {
    let parsed = JSON.parse(str);
    if (parsed && typeof parsed === 'object') {
      let mainOutput = parsed.output !== undefined ? parsed.output : (parsed.stdout !== undefined ? parsed.stdout : (parsed.result !== undefined ? parsed.result : null));
      if (mainOutput !== null) {
        if (typeof mainOutput === 'string') {
          try {
            const innerParsed = JSON.parse(mainOutput.trim());
            return {
              preview: typeof innerParsed === 'object' ? JSON.stringify(innerParsed) : String(innerParsed).trim(),
              full: JSON.stringify(innerParsed, null, 2)
            };
          } catch (e) {
            const trimmedText = mainOutput.trim();
            const firstLine = trimmedText.split('\n')[0] || '';
            return { preview: firstLine, full: trimmedText };
          }
        } else if (typeof mainOutput === 'object') {
          return { preview: JSON.stringify(mainOutput), full: JSON.stringify(mainOutput, null, 2) };
        }
      }
      return { preview: JSON.stringify(parsed), full: JSON.stringify(parsed, null, 2) };
    }
  } catch (e) {}

  const trimmed = str.trim();
  const firstLine = trimmed.split('\n')[0] || '';
  return { preview: firstLine, full: trimmed };
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
      sessionRes = await boundedFetch(`${cfg.baseUrl}/sessions/${encodeURIComponent(rawSessionId)}`, { headers }, 1048576, 10000);
      if (sessionRes.ok) {
        const data = await readBoundedJson(sessionRes, 1048576);
        sessionObj = data.session || data || {};
      }
    }

    // 2. Fetch session messages
    let msgRes = await boundedFetch(`${cfg.rootUrl}${cfg.apiPrefix}/sessions/${encodeURIComponent(rawSessionId)}/messages`, { headers }, 1048576, 10000);

    if (!msgRes.ok) {
      msgRes = await boundedFetch(`${cfg.baseUrl}/sessions/${encodeURIComponent(rawSessionId)}/messages`, { headers }, 1048576, 10000);
    }

    let rawMessages = [];
    if (msgRes.ok) {
      const msgData = await readBoundedJson(msgRes, 1048576);
      rawMessages = Array.isArray(msgData.data) ? msgData.data : (Array.isArray(msgData.messages) ? msgData.messages : (Array.isArray(msgData) ? msgData : []));
    } else {
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
      res = await boundedFetch(`${cfg.baseUrl}/sessions/${encodeURIComponent(rawSessionId)}`, {
        method: 'DELETE',
        headers
      }, 65536, 10000);
    }

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
  let cleanMsg = String(message || '').trim();
  cleanMsg = cleanMsg.replace(/```[\s\S]*?```/g, '[Code]');
  cleanMsg = cleanMsg.replace(/`([^`]+)`/g, '$1');
  cleanMsg = cleanMsg.replace(/\[([^\]]+)\]\([^\)]+\)/g, '$1');
  cleanMsg = cleanMsg.replace(/[*_~#]/g, '');
  cleanMsg = cleanMsg.replace(/[<>&]/g, '');
  cleanMsg = cleanMsg.replace(/[\u0000-\u001f\u007f-\u009f\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, '');
  cleanMsg = cleanMsg.replace(/\s+/g, ' ').trim();
  if (cleanMsg.length > 140) cleanMsg = cleanMsg.slice(0, 137) + '...';
  if (!cleanMsg) cleanMsg = isError ? 'An error occurred.' : 'Response completed.';

  let cleanTitle = String(title || appName || 'Hermes').replace(/[<>&]/g, '');
  cleanTitle = cleanTitle.replace(/[\u0000-\u001f\u007f-\u009f\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, '').trim();
  if (cleanTitle.length > 60) cleanTitle = cleanTitle.slice(0, 57) + '...';

  const urgency = isError ? 'critical' : 'normal';

  let bin = '/usr/bin/notify-send';
  if (fs.existsSync('/usr/share/omarchy/bin/omarchy-notification-send')) {
    bin = '/usr/share/omarchy/bin/omarchy-notification-send';
  } else if (fs.existsSync('/usr/bin/omarchy-notification-send')) {
    bin = '/usr/bin/omarchy-notification-send';
  }

  let args = [];
  if (bin.includes('omarchy-notification-send')) {
    const glyph = isError ? '\u{f015a}' : '\u{f06d3}';
    args = ['--app-name', appName || 'Hermes', '-u', urgency, '-g', glyph, '--', cleanTitle, cleanMsg];
  } else {
    args = ['-a', appName || 'Hermes', '-u', urgency, '--', cleanTitle, cleanMsg];
  }

  try {
    const child = spawn(bin, args, {
      detached: true,
      stdio: 'ignore'
    });
    child.unref();
  } catch (e) {
    // Ignore notification errors
  }
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

    const openaiClient = new OpenAI({
      baseURL: cfg.baseUrl,
      apiKey: cfg.apiKey,
      timeout: 60000,
    });

    const stream = await openaiClient.chat.completions.create(
      {
        model: model || 'hermes-agent',
        messages: messages.map(m => ({ role: m.role, content: m.content })),
        stream: true,
      },
      {
        headers: customHeaders
      }
    );

    let fullText = '';

    for await (const chunk of stream) {
      if (!chunk) continue;

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

      if (delta && delta.tool_calls && Array.isArray(delta.tool_calls)) {
        for (const tc of delta.tool_calls) {
          const fn = tc?.function;
          if (fn && fn.name) {
            process.stdout.write(JSON.stringify({
              type: 'tool_progress',
              session_id: emitSessionId,
              raw_session_id: resolvedSessionId,
              composite_id: compositeId,
              tool: fn.name,
              status: 'running',
              label: fn.arguments || '',
              id: tc.id || tc.call_id || ''
            }) + '\n');
          }
        }
      }

      // Handle Hermes custom SSE event: hermes.tool.progress
      const isToolProgress = chunk.event === 'hermes.tool.progress' || chunk.event === 'tool_progress';
      const eventData = chunk.data || chunk.hermes_event || (typeof chunk.event === 'object' ? chunk.event : null);

      if (isToolProgress && eventData) {
        const ev = eventData;
        process.stdout.write(JSON.stringify({
          type: 'tool_progress',
          session_id: emitSessionId,
          raw_session_id: resolvedSessionId,
          composite_id: compositeId,
          tool: ev.tool || ev.name || 'tool',
          status: ev.status || 'running',
          label: ev.label || ev.detail || ev.message || '',
          emoji: ev.emoji || '',
          id: ev.toolCallId || ev.id || ''
        }) + '\n');
      }
    }

    process.stdout.write(JSON.stringify({
      type: 'done',
      session_id: emitSessionId,
      raw_session_id: resolvedSessionId,
      composite_id: compositeId,
      endpoint_id: cfg.endpointId,
      profile_name: cfg.profileName,
      full_text: fullText,
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
  const hermesEnv = loadHermesEnvFile();
  let endpoints = settings.endpoints;

  if (!endpoints || endpoints.length === 0) {
    // Seed default endpoint
    const defaultPort = parseInt(process.env.HERMES_API_SERVER_PORT || hermesEnv.API_SERVER_PORT || hermesEnv.PORT || '8642', 10);
    let rawUrl = process.env.HERMES_API_SERVER_URL || hermesEnv.API_SERVER_URL || 'http://127.0.0.1';
    let defaultUrl = rawUrl;
    try {
      const p = new URL(rawUrl.startsWith('http://') || rawUrl.startsWith('https://') ? rawUrl : `http://${rawUrl}`);
      defaultUrl = `${p.protocol}//${p.hostname}`;
    } catch (e) {
      defaultUrl = 'http://127.0.0.1';
    }
    const defaultKey = process.env.HERMES_API_SERVER_KEY || hermesEnv.API_SERVER_KEY || '';
    const defaultName = process.env.HERMES_API_SERVER_NAME || hermesEnv.HERMES_API_SERVER_NAME || 'Local Hermes';

    endpoints = [{
      id: 'endpoint-default',
      name: defaultName,
      url: defaultUrl,
      port: isNaN(defaultPort) ? 8642 : defaultPort,
      apiKey: defaultKey,
      profiles: []
    }];
  }

  const localProfiles = discoverLocalHermesProfiles();

  // Test all endpoints in parallel
  const targetResults = await Promise.all(endpoints.map(async ep => {
    let rawUrl = ep.url;
    if (!rawUrl.startsWith('http://') && !rawUrl.startsWith('https://')) {
      rawUrl = `http://${rawUrl}`;
    }
    let parsedUrl;
    try {
      parsedUrl = new URL(rawUrl);
    } catch (e) {
      parsedUrl = new URL(`http://127.0.0.1:${ep.port || 8642}`);
    }
    if (!parsedUrl.port && ep.port) {
      parsedUrl.port = String(ep.port);
    }
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
  const defaultPort = parseInt(process.env.HERMES_API_SERVER_PORT || hermesEnv.API_SERVER_PORT || hermesEnv.PORT || '8642', 10);
  let rawUrl = process.env.HERMES_API_SERVER_URL || hermesEnv.API_SERVER_URL || 'http://127.0.0.1';
  let defaultUrl = rawUrl;
  try {
    const p = new URL(rawUrl.startsWith('http://') || rawUrl.startsWith('https://') ? rawUrl : `http://${rawUrl}`);
    defaultUrl = `${p.protocol}//${p.hostname}`;
  } catch (e) {
    defaultUrl = 'http://127.0.0.1';
  }
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

    if (!url.startsWith('http://') && !url.startsWith('https://')) {
      url = `http://${url}`;
    }

    let parsedUrl;
    try {
      parsedUrl = new URL(url);
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
  let endpoint = null;
  let profile = null;
  const rest = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--') {
      rest.push(...args.slice(i + 1));
      break;
    }
    if ((arg === '--endpoint' || arg === '-e') && i + 1 < args.length) {
      endpoint = args[++i];
    } else if ((arg === '--profile' || arg === '-p') && i + 1 < args.length) {
      profile = args[++i];
    } else if (arg.startsWith('--endpoint=')) {
      endpoint = arg.slice(11);
    } else if (arg.startsWith('--profile=')) {
      profile = arg.slice(10);
    } else {
      rest.push(arg);
    }
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

    case 'monogram': {
      const name = rest.slice(1).join(' ') || 'Hermes';
      console.log(JSON.stringify({
        success: true,
        name,
        monogram: getAgentMonogram(name),
        color: getAgentColor(name)
      }));
      break;
    }

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
        error: `Unknown command: ${command}. Available: status, list-targets, set-active-target, monogram, list-sessions, get-session, delete-session, rename-session, stream-chat, get-settings, save-settings`
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
  parseCliOptions
};

