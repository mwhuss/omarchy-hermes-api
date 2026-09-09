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
const { URL } = require('url');
const { OpenAI } = require('openai');

function loadHermesEnvFile() {
  const envPath = path.join(os.homedir(), '.hermes', '.env');
  const vars = {};
  if (fs.existsSync(envPath)) {
    try {
      const content = fs.readFileSync(envPath, 'utf8');
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
      // Ignore reading errors
    }
  }
  return vars;
}

function getSettingsPath() {
  return path.join(os.homedir(), '.config', 'omarchy-hermes-api', 'settings.json');
}

function loadSettingsFile() {
  const settingsPath = getSettingsPath();
  if (fs.existsSync(settingsPath)) {
    try {
      const content = fs.readFileSync(settingsPath, 'utf8');
      const parsed = JSON.parse(content);
      if (parsed && Array.isArray(parsed.endpoints)) {
        return parsed;
      }
    } catch (e) {
      // Ignore reading / parsing errors
    }
  }
  return null;
}

function discoverLocalHermesProfiles() {
  const profilesDir = path.join(os.homedir(), '.hermes', 'profiles');
  const discovered = [];
  if (fs.existsSync(profilesDir)) {
    try {
      const entries = fs.readdirSync(profilesDir, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isDirectory()) {
          const profName = entry.name;
          if (profName.toLowerCase() === 'default') continue;
          let apiKey = '';
          const envPath = path.join(profilesDir, profName, '.env');
          if (fs.existsSync(envPath)) {
            try {
              const content = fs.readFileSync(envPath, 'utf8');
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
  }
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
  const endpointApiKey = (targetEndpoint && targetEndpoint.apiKey) || process.env.HERMES_API_SERVER_KEY || hermesEnv.API_SERVER_KEY || 'dummy-key';

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
        profApiKey = found.apiKey;
      }
    }
    const isLocal = parsedUrl.hostname === '127.0.0.1' || parsedUrl.hostname === 'localhost';
    if (!profApiKey && isLocal) {
      const discovered = discoverLocalHermesProfiles();
      const d = discovered.find(p => p.name.toLowerCase() === resolvedProfile.toLowerCase());
      if (d && d.apiKey) profApiKey = d.apiKey;
    }

    const finalApiKey = profApiKey || endpointApiKey;
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
  const cfg = resolveConfig(targetEndpointId, targetProfileName);
  try {
    const res = await fetch(`${cfg.baseUrl}/models`, {
      headers: {
        'Authorization': `Bearer ${cfg.apiKey}`,
        'Accept': 'application/json'
      }
    });

    if (res.ok) {
      const data = await res.json();
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
    let res = await fetch(`${cfg.rootUrl}${cfg.apiPrefix}/sessions`, {
      headers: {
        'Authorization': `Bearer ${cfg.apiKey}`,
        'Accept': 'application/json'
      }
    });

    if (!res.ok) {
      res = await fetch(`${cfg.baseUrl}/sessions`, {
        headers: {
          'Authorization': `Bearer ${cfg.apiKey}`,
          'Accept': 'application/json'
        }
      });
    }

    if (!res.ok) return [];

    const raw = await res.json();
    const list = Array.isArray(raw) ? raw : (Array.isArray(raw.sessions) ? raw.sessions : (Array.isArray(raw.data) ? raw.data : []));

    return list.map((s, idx) => {
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

      const rawId = s.id || s.session_id || `session-${idx}`;
      const compositeId = `${cfg.endpointId}:${cfg.profileName}:${rawId}`;

      return {
        id: compositeId,
        raw_id: rawId,
        endpoint_id: cfg.endpointId,
        endpoint_name: cfg.endpointName,
        profile_name: cfg.profileName,
        target_id: `${cfg.endpointId}:${cfg.profileName}`,
        title: s.title || s.preview || s.name || `Session ${rawId}`,
        created_at: createdAt,
        updated_at: updatedAt,
        source: s.source || s.platform || 'hermes',
        message_count: s.message_count || s.messages?.length || 0,
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

  const cfg = resolveConfig(endpointId, profileName);
  try {
    let sessionObj = {};
    let sessionRes = await fetch(`${cfg.rootUrl}${cfg.apiPrefix}/sessions/${encodeURIComponent(rawSessionId)}`, {
      headers: {
        'Authorization': `Bearer ${cfg.apiKey}`,
        'Accept': 'application/json'
      }
    });

    if (sessionRes.ok) {
      const data = await sessionRes.json();
      sessionObj = data.session || data || {};
    } else {
      sessionRes = await fetch(`${cfg.baseUrl}/sessions/${encodeURIComponent(rawSessionId)}`, {
        headers: {
          'Authorization': `Bearer ${cfg.apiKey}`,
          'Accept': 'application/json'
        }
      });
      if (sessionRes.ok) {
        const data = await sessionRes.json();
        sessionObj = data.session || data || {};
      }
    }

    // 2. Fetch session messages
    let msgRes = await fetch(`${cfg.rootUrl}${cfg.apiPrefix}/sessions/${encodeURIComponent(rawSessionId)}/messages`, {
      headers: {
        'Authorization': `Bearer ${cfg.apiKey}`,
        'Accept': 'application/json'
      }
    });

    if (!msgRes.ok) {
      msgRes = await fetch(`${cfg.baseUrl}/sessions/${encodeURIComponent(rawSessionId)}/messages`, {
        headers: {
          'Authorization': `Bearer ${cfg.apiKey}`,
          'Accept': 'application/json'
        }
      });
    }

    let rawMessages = [];
    if (msgRes.ok) {
      const msgData = await msgRes.json();
      rawMessages = Array.isArray(msgData.data) ? msgData.data : (Array.isArray(msgData.messages) ? msgData.messages : (Array.isArray(msgData) ? msgData : []));
    } else {
      rawMessages = sessionObj.messages || [];
    }

    const messages = rawMessages.filter(Boolean).map(m => {
      let parsedToolCalls = [];
      if (Array.isArray(m.tool_calls)) {
        parsedToolCalls = m.tool_calls.map(tc => {
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

  const cfg = resolveConfig(endpointId, profileName);
  try {
    let res = await fetch(`${cfg.rootUrl}${cfg.apiPrefix}/sessions/${encodeURIComponent(rawSessionId)}`, {
      method: 'DELETE',
      headers: {
        'Authorization': `Bearer ${cfg.apiKey}`,
        'Accept': 'application/json'
      }
    });

    if (!res.ok && res.status !== 404) {
      res = await fetch(`${cfg.baseUrl}/sessions/${encodeURIComponent(rawSessionId)}`, {
        method: 'DELETE',
        headers: {
          'Authorization': `Bearer ${cfg.apiKey}`,
          'Accept': 'application/json'
        }
      });
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

function sendDesktopNotification(title, message, isError = false) {
  const { spawn } = require('child_process');
  let cleanMsg = String(message || '').trim();
  cleanMsg = cleanMsg.replace(/```[\s\S]*?```/g, '[Code]');
  cleanMsg = cleanMsg.replace(/`([^`]+)`/g, '$1');
  cleanMsg = cleanMsg.replace(/\[([^\]]+)\]\([^\)]+\)/g, '$1');
  cleanMsg = cleanMsg.replace(/[*_~>#]/g, '');
  cleanMsg = cleanMsg.replace(/\s+/g, ' ').trim();
  if (cleanMsg.length > 140) cleanMsg = cleanMsg.slice(0, 137) + '...';
  if (!cleanMsg) cleanMsg = isError ? 'An error occurred.' : 'Response completed.';

  const urgency = isError ? 'critical' : 'normal';
  const glyph = isError ? '\u{f015a}' : '\u{f06d3}';

  const script = 'if command -v omarchy-notification-send >/dev/null 2>&1; then ' +
    '  omarchy-notification-send --app-name "$1" -u "$2" -g "$3" "$4" "$5"; ' +
    'else ' +
    '  notify-send -a "$1" -u "$2" "$4" "$5"; ' +
    'fi';

  try {
    const child = spawn('bash', ['-lc', script, 'bash', config.serverName, urgency, glyph, title, cleanMsg], {
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
        fullText += delta.content;
        process.stdout.write(JSON.stringify({
          type: 'delta',
          session_id: emitSessionId,
          raw_session_id: resolvedSessionId,
          composite_id: compositeId,
          content: delta.content
        }) + '\n');
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
      sendDesktopNotification(notifTitle, fullText, false);
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
      sendDesktopNotification(`${notifTitle} - Error`, err.message, true);
    }
  }
}

async function handleRenameSession(sessionId, newTitle, optEndpoint, optProfile) {
  const { endpointId, profileName, rawSessionId } = parseSessionIdentifier(sessionId, optEndpoint, optProfile);
  if (!rawSessionId || !newTitle) {
    console.log(JSON.stringify({ success: false, error: 'Session ID and new title required' }));
    return;
  }

  const cfg = resolveConfig(endpointId, profileName);
  try {
    const res = await fetch(`${cfg.rootUrl}${cfg.apiPrefix}/sessions/${encodeURIComponent(rawSessionId)}`, {
      method: 'PATCH',
      headers: {
        'Authorization': `Bearer ${cfg.apiKey}`,
        'Content-Type': 'application/json',
        'Accept': 'application/json'
      },
      body: JSON.stringify({ title: newTitle })
    });

    if (!res.ok) {
      const errText = await res.text();
      console.log(JSON.stringify({ success: false, error: `Failed to rename session: ${res.status} ${errText}` }));
      return;
    }

    const data = await res.json();
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
    const isLocal = parsedUrl.hostname === '127.0.0.1' || parsedUrl.hostname === 'localhost';

    let connected = false;
    let models = ['hermes-agent'];
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 2500);
      const res = await fetch(`${rootUrl}/v1/models`, {
        headers: {
          'Authorization': `Bearer ${ep.apiKey || ''}`,
          'Accept': 'application/json'
        },
        signal: controller.signal
      });
      clearTimeout(timeout);
      if (res.ok) {
        connected = true;
        const data = await res.json();
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
  const settingsPath = getSettingsPath();
  let settings = loadSettingsFile() || { endpoints: [] };
  settings.activeTarget = {
    endpointId: endpointId || 'all',
    profileName: profileName || 'all'
  };

  try {
    const configDir = path.dirname(settingsPath);
    if (!fs.existsSync(configDir)) {
      fs.mkdirSync(configDir, { recursive: true, mode: 0o700 });
    }
    const tmpPath = path.join(configDir, `settings.json.tmp.${process.pid}.${Date.now()}`);
    fs.writeFileSync(tmpPath, JSON.stringify(settings, null, 2) + '\n', { mode: 0o600 });
    fs.chmodSync(tmpPath, 0o600);
    fs.renameSync(tmpPath, settingsPath);
    fs.chmodSync(settingsPath, 0o600);

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
  if (fs.existsSync(settingsPath)) {
    try {
      const content = fs.readFileSync(settingsPath, 'utf8');
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
      jsonString = fs.readFileSync(0, 'utf8');
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

    const apiKey = typeof ep.apiKey === 'string' ? ep.apiKey.trim() : '';

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
          profKey = typeof prof.apiKey === 'string' ? prof.apiKey.trim() : '';
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
    const settingsPath = getSettingsPath();
    const configDir = path.dirname(settingsPath);
    if (!fs.existsSync(configDir)) {
      fs.mkdirSync(configDir, { recursive: true, mode: 0o700 });
    }

    const tmpPath = path.join(configDir, `settings.json.tmp.${process.pid}.${Date.now()}`);
    fs.writeFileSync(tmpPath, JSON.stringify(cleanSettings, null, 2) + '\n', { mode: 0o600 });
    fs.chmodSync(tmpPath, 0o600);
    fs.renameSync(tmpPath, settingsPath);
    fs.chmodSync(settingsPath, 0o600);

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
    if ((arg === '--endpoint' || arg === '-e') && i + 1 < args.length) {
      endpoint = args[++i];
    } else if ((arg === '--profile' || arg === '-p') && i + 1 < args.length) {
      profile = args[++i];
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
          const stdinData = fs.readFileSync(0, 'utf-8');
          try {
            const parsed = JSON.parse(stdinData);
            sessionId = parsed.sessionId || sessionId;
            prompt = parsed.prompt || prompt;
            systemPrompt = parsed.systemPrompt || parsed.system || systemPrompt;
            model = parsed.model || model;
            history = parsed.history || history;
            notify = parsed.notify || notify;
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

main().catch(err => {
  console.error(JSON.stringify({ success: false, error: err.message }));
  process.exit(1);
});

