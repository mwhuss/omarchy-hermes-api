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

function resolveConfig() {
  const hermesEnv = loadHermesEnvFile();

  const defaultPort = process.env.HERMES_API_SERVER_PORT || hermesEnv.API_SERVER_PORT || hermesEnv.PORT || '8642';
  
  let rawUrl = process.env.HERMES_API_SERVER_URL || hermesEnv.API_SERVER_URL || `http://127.0.0.1:${defaultPort}`;

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

  // If port is not explicitly specified in URL and not standard 80/443 without default, apply default port
  if (!parsedUrl.port) {
    // If it's a domain/IP without port, default to defaultPort
    parsedUrl.port = defaultPort;
  }

  let rootUrl = parsedUrl.origin;
  let baseUrl = `${rootUrl}/v1`;

  const apiKey = process.env.HERMES_API_SERVER_KEY || hermesEnv.API_SERVER_KEY || 'dummy-key';

  return {
    rootUrl,
    baseUrl,
    port: parseInt(parsedUrl.port || defaultPort, 10),
    apiKey,
  };
}

const config = resolveConfig();

const openai = new OpenAI({
  baseURL: config.baseUrl,
  apiKey: config.apiKey,
});

async function handleStatus() {
  try {
    const res = await fetch(`${config.baseUrl}/models`, {
      headers: {
        'Authorization': `Bearer ${config.apiKey}`,
        'Accept': 'application/json'
      }
    });

    if (res.ok) {
      const data = await res.json();
      const models = Array.isArray(data.data) ? data.data.map(m => m.id) : ['hermes-agent'];
      console.log(JSON.stringify({
        success: true,
        connected: true,
        rootUrl: config.rootUrl,
        baseUrl: config.baseUrl,
        models: models.length ? models : ['hermes-agent']
      }));
    } else {
      console.log(JSON.stringify({
        success: false,
        connected: false,
        statusCode: res.status,
        baseUrl: config.baseUrl,
        error: `Server returned HTTP ${res.status}`
      }));
    }
  } catch (err) {
    console.log(JSON.stringify({
      success: false,
      connected: false,
      baseUrl: config.baseUrl,
      error: err.message
    }));
  }
}

async function handleListSessions() {
  try {
    let res = await fetch(`${config.rootUrl}/api/sessions`, {
      headers: {
        'Authorization': `Bearer ${config.apiKey}`,
        'Accept': 'application/json'
      }
    });

    if (!res.ok) {
      res = await fetch(`${config.baseUrl}/sessions`, {
        headers: {
          'Authorization': `Bearer ${config.apiKey}`,
          'Accept': 'application/json'
        }
      });
    }

    if (!res.ok) {
      throw new Error(`Failed to fetch sessions: HTTP ${res.status}`);
    }

    const raw = await res.json();
    const list = Array.isArray(raw) ? raw : (Array.isArray(raw.sessions) ? raw.sessions : (Array.isArray(raw.data) ? raw.data : []));

    const normalized = list.map((s, idx) => {
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

      return {
        id: s.id || s.session_id || `session-${idx}`,
        title: s.title || s.preview || s.name || `Session ${s.id || idx}`,
        created_at: createdAt,
        updated_at: updatedAt,
        source: s.source || s.platform || 'hermes',
        message_count: s.message_count || s.messages?.length || 0,
        model: s.model || 'hermes-agent'
      };
    });

    // Sort newest updated first
    normalized.sort((a, b) => new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime());

    console.log(JSON.stringify({
      success: true,
      sessions: normalized
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

async function handleGetSession(sessionId) {
  if (!sessionId) {
    console.log(JSON.stringify({ success: false, error: 'Session ID required' }));
    return;
  }

  try {
    let sessionObj = {};
    let sessionRes = await fetch(`${config.rootUrl}/api/sessions/${encodeURIComponent(sessionId)}`, {
      headers: {
        'Authorization': `Bearer ${config.apiKey}`,
        'Accept': 'application/json'
      }
    });

    if (sessionRes.ok) {
      const data = await sessionRes.json();
      sessionObj = data.session || data || {};
    } else {
      sessionRes = await fetch(`${config.baseUrl}/sessions/${encodeURIComponent(sessionId)}`, {
        headers: {
          'Authorization': `Bearer ${config.apiKey}`,
          'Accept': 'application/json'
        }
      });
      if (sessionRes.ok) {
        const data = await sessionRes.json();
        sessionObj = data.session || data || {};
      }
    }

    // 2. Fetch session messages
    let msgRes = await fetch(`${config.rootUrl}/api/sessions/${encodeURIComponent(sessionId)}/messages`, {
      headers: {
        'Authorization': `Bearer ${config.apiKey}`,
        'Accept': 'application/json'
      }
    });

    if (!msgRes.ok) {
      msgRes = await fetch(`${config.baseUrl}/sessions/${encodeURIComponent(sessionId)}/messages`, {
        headers: {
          'Authorization': `Bearer ${config.apiKey}`,
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

    console.log(JSON.stringify({
      success: true,
      session: {
        id: sessionObj.id || sessionId,
        title: sessionObj.title || sessionObj.name || `Session ${sessionId}`,
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

async function handleDeleteSession(sessionId) {
  if (!sessionId) {
    console.log(JSON.stringify({ success: false, error: 'Session ID required' }));
    return;
  }

  try {
    let res = await fetch(`${config.rootUrl}/api/sessions/${encodeURIComponent(sessionId)}`, {
      method: 'DELETE',
      headers: {
        'Authorization': `Bearer ${config.apiKey}`,
        'Accept': 'application/json'
      }
    });

    if (!res.ok && res.status !== 404) {
      res = await fetch(`${config.baseUrl}/sessions/${encodeURIComponent(sessionId)}`, {
        method: 'DELETE',
        headers: {
          'Authorization': `Bearer ${config.apiKey}`,
          'Accept': 'application/json'
        }
      });
    }

    console.log(JSON.stringify({
      success: true,
      id: sessionId,
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
    '  omarchy-notification-send --app-name "Hermes Agent" -u "$1" -g "$2" "$3" "$4"; ' +
    'else ' +
    '  notify-send -a "Hermes Agent" -u "$1" "$3" "$4"; ' +
    'fi';

  try {
    const child = spawn('bash', ['-lc', script, 'bash', urgency, glyph, title, cleanMsg], {
      detached: true,
      stdio: 'ignore'
    });
    child.unref();
  } catch (e) {
    // Ignore notification errors
  }
}

async function handleStreamChat(options) {
  const { sessionId, prompt, model, history, systemPrompt, notify } = options;

  if (!prompt || typeof prompt !== 'string') {
    process.stdout.write(JSON.stringify({ type: 'error', error: 'Prompt is required' }) + '\n');
    return;
  }

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

  const customHeaders = {};
  if (sessionId) {
    customHeaders['X-Hermes-Session-Id'] = sessionId;
  }
  customHeaders['X-Hermes-Source'] = 'omarchy-bar';

  try {
    process.stdout.write(JSON.stringify({
      type: 'start',
      session_id: sessionId || null,
      model: model || 'hermes-agent'
    }) + '\n');

    const stream = await openai.chat.completions.create(
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
          content: delta.content
        }) + '\n');
      }

      if (delta && delta.tool_calls && Array.isArray(delta.tool_calls)) {
        for (const tc of delta.tool_calls) {
          const fn = tc?.function;
          if (fn && fn.name) {
            process.stdout.write(JSON.stringify({
              type: 'tool_progress',
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
      session_id: sessionId || null,
      full_text: fullText,
      finish_reason: 'stop'
    }) + '\n');

    if (notify) {
      sendDesktopNotification('Hermes Agent', fullText, false);
    }
  } catch (err) {
    process.stdout.write(JSON.stringify({
      type: 'error',
      error: err.message
    }) + '\n');

    if (notify) {
      sendDesktopNotification('Hermes Agent - Error', err.message, true);
    }
  }
}

async function handleRenameSession(sessionId, newTitle) {
  if (!sessionId || !newTitle) {
    console.log(JSON.stringify({ success: false, error: 'Session ID and new title required' }));
    return;
  }

  try {
    const res = await fetch(`${config.rootUrl}/api/sessions/${encodeURIComponent(sessionId)}`, {
      method: 'PATCH',
      headers: {
        'Authorization': `Bearer ${config.apiKey}`,
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
    console.log(JSON.stringify({
      success: true,
      id: sessionId,
      title: sessionObj.title || newTitle
    }));
  } catch (err) {
    console.log(JSON.stringify({ success: false, error: err.message }));
  }
}

async function main() {
  const args = process.argv.slice(2);
  const command = args[0] || 'status';

  switch (command) {
    case 'status':
      await handleStatus();
      break;

    case 'list-sessions':
      await handleListSessions();
      break;

    case 'get-session':
      await handleGetSession(args[1]);
      break;

    case 'rename-session':
      await handleRenameSession(args[1], args.slice(2).join(' '));
      break;

    case 'delete-session':
      await handleDeleteSession(args[1]);
      break;

    case 'stream-chat': {
      let sessionId = null;
      let prompt = '';
      let model = 'hermes-agent';
      let systemPrompt = '';
      let history = [];
      let notify = false;

      for (let i = 1; i < args.length; i++) {
        if (args[i] === '--session' && args[i + 1]) {
          sessionId = args[++i];
        } else if (args[i] === '--prompt' && args[i + 1]) {
          prompt = args[++i];
        } else if ((args[i] === '--system' || args[i] === '--system-prompt') && args[i + 1]) {
          systemPrompt = args[++i];
        } else if (args[i] === '--model' && args[i + 1]) {
          model = args[++i];
        } else if (args[i] === '--notify') {
          notify = true;
        } else if (args[i] === '--history' && args[i + 1]) {
          try {
            history = JSON.parse(args[++i]);
          } catch (e) {
            history = [];
          }
        } else if (args[i] === '--json-input') {
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

      await handleStreamChat({ sessionId, prompt, model, history, systemPrompt, notify });
      break;
    }

    default:
      console.log(JSON.stringify({
        success: false,
        error: `Unknown command: ${command}. Available: status, list-sessions, get-session, delete-session, stream-chat`
      }));
      process.exit(1);
  }
}

main().catch(err => {
  console.error(JSON.stringify({ success: false, error: err.message }));
  process.exit(1);
});
