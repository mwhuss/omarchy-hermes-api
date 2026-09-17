/**
 * Test suite for Hermes API Bridge and Subprocess Interface
 */

const http = require('http');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');
const assert = require('assert');

const bridgePath = path.join(__dirname, '..', 'bin', 'hermes-bridge.js');

const isLiveTest = process.env.HERMES_LIVE === '1';
let defaultBridgeEnv = {};
let mockServer = null;
const mockSessions = new Map();

function resetMockSessions() {
  mockSessions.clear();
  mockSessions.set('seed-session-1', {
    id: 'seed-session-1',
    title: 'Initial Test Session',
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    message_count: 2
  });
  mockSessions.set('cron_test-job-1_1700000000', {
    id: 'cron_test-job-1_1700000000',
    title: 'Scheduled Repo Check',
    source: 'cron',
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    message_count: 1
  });
}

function startMockServer() {
  resetMockSessions();
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      const parsedUrl = new URL(req.url, 'http://127.0.0.1');
      const pathname = parsedUrl.pathname;

      // Models endpoint
      if (pathname.endsWith('/models') && req.method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          object: 'list',
          data: [{ id: 'hermes-agent', object: 'model' }]
        }));
        return;
      }

      // Chat completions SSE endpoint
      if (pathname.endsWith('/chat/completions') && req.method === 'POST') {
        let body = '';
        req.on('data', chunk => { body += chunk; });
        req.on('end', () => {
          const sid = req.headers['x-hermes-session-id'];
          if (sid && !mockSessions.has(sid)) {
            mockSessions.set(sid, {
              id: sid,
              title: `Session ${sid}`,
              created_at: new Date().toISOString(),
              updated_at: new Date().toISOString(),
              message_count: 1
            });
          }
          res.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            'Connection': 'keep-alive'
          });
          res.write(': ping\n\n');
          res.write('data: {"choices":[{"delta":{"role":"assistant","content":"Mock test response"}}]}\n\n');
          res.write('data: [DONE]\n\n');
          res.end();
        });
        return;
      }

      // Session messages endpoint
      if (pathname.endsWith('/messages') && req.method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          messages: [
            { role: 'user', content: 'Hello' },
            { role: 'assistant', content: 'Mock response' }
          ]
        }));
        return;
      }

      // Session collection endpoint
      if ((pathname.endsWith('/sessions') || pathname.endsWith('/sessions/')) && req.method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          sessions: Array.from(mockSessions.values())
        }));
        return;
      }

      // Single session endpoints (/sessions/:id)
      const sessionMatch = pathname.match(/\/sessions\/([^/]+)$/);
      if (sessionMatch) {
        const sid = decodeURIComponent(sessionMatch[1]);
        if (req.method === 'GET') {
          const session = mockSessions.get(sid) || {
            id: sid,
            title: `Session ${sid}`,
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
            message_count: 1
          };
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ session }));
          return;
        }

        if (req.method === 'PATCH' || req.method === 'PUT') {
          let body = '';
          req.on('data', chunk => { body += chunk; });
          req.on('end', () => {
            let newTitle = 'Renamed Session';
            try {
              const parsed = JSON.parse(body);
              if (parsed.title) newTitle = parsed.title;
            } catch (e) {}
            if (mockSessions.has(sid)) {
              mockSessions.get(sid).title = newTitle;
              mockSessions.get(sid).updated_at = new Date().toISOString();
            }
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ session: { id: sid, title: newTitle } }));
          });
          return;
        }

        if (req.method === 'DELETE') {
          mockSessions.delete(sid);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: true, id: sid, deleted: true }));
          return;
        }
      }

      // Default fallback
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Not found' }));
    });

    server.listen(0, '127.0.0.1', () => {
      resolve(server);
    });
    server.on('error', reject);
  });
}

const createdSessionIds = [];

function trackCreatedSessionFromStdout(stdout) {
  try {
    const lines = stdout.trim().split('\n');
    for (const line of lines) {
      const ev = JSON.parse(line);
      if (ev && ev.type === 'start') {
        const sid = ev.composite_id || ev.session_id;
        if (sid && !createdSessionIds.includes(sid)) {
          createdSessionIds.push(sid);
          return sid;
        }
      }
    }
  } catch (e) {}
  return null;
}

function runBridge(args, input = null, envExtra = {}) {
  return new Promise((resolve, reject) => {
    const proc = spawn('node', [bridgePath, ...args], {
      env: { ...process.env, ...defaultBridgeEnv, ...envExtra },
      stdio: ['pipe', 'pipe', 'pipe']
    });

    let stdout = '';
    let stderr = '';

    proc.stdout.on('data', data => { stdout += data.toString(); });
    proc.stderr.on('data', data => { stderr += data.toString(); });

    if (input) {
      proc.stdin.write(input);
      proc.stdin.end();
    }

    proc.on('close', code => {
      resolve({ code, stdout, stderr });
    });
    proc.on('error', err => reject(err));
  });
}

async function testStatus() {
  console.log('Testing: status command...');
  const res = await runBridge(['status']);
  assert.strictEqual(res.code, 0, `Exit code should be 0, got ${res.code}`);
  const json = JSON.parse(res.stdout);
  assert(typeof json.success === 'boolean', 'json.success should be boolean');
  assert(typeof json.connected === 'boolean', 'json.connected should be boolean');
  console.log('  ✔ status check passed (connected:', json.connected, ')');
}

async function testListSessions() {
  console.log('Testing: list-sessions command...');
  const res = await runBridge(['list-sessions']);
  assert.strictEqual(res.code, 0, `Exit code should be 0, got ${res.code}`);
  const json = JSON.parse(res.stdout);
  assert.strictEqual(json.success, true, 'json.success should be true');
  assert(Array.isArray(json.sessions), 'json.sessions should be an array');
  if (json.sessions.length > 0) {
    const first = json.sessions[0];
    assert(typeof first.id !== 'undefined', 'session id must exist');
    assert(typeof first.title === 'string', 'session title must be string');
    assert(typeof first.created_at === 'string', 'created_at must be formatted');
  }
  console.log(`  ✔ list-sessions passed (retrieved ${json.sessions.length} sessions)`);
}

async function testStreamChat() {
  console.log('Testing: stream-chat command...');
  const res = await runBridge(['stream-chat', '--prompt', 'Respond with the word "TEST" only.']);
  assert.strictEqual(res.code, 0, `Exit code should be 0, got ${res.code}`);
  trackCreatedSessionFromStdout(res.stdout);
  
  const lines = res.stdout.trim().split('\n');
  assert(lines.length > 0, 'Should output at least one NDJSON event line');
  
  const events = lines.map(l => JSON.parse(l));
  const types = events.map(e => e.type);

  assert(types.includes('start'), 'Should have a start event');
  assert(types.includes('done') || types.includes('error'), 'Should finish with done or error event');
  console.log('  ✔ stream-chat passed with events:', types.filter((v, i, a) => a.indexOf(v) === i).join(', '));

  console.log('Testing: stream-chat with --json-input stdin pipeline...');
  const jsonInputRes = await runBridge(['stream-chat', '--json-input'], JSON.stringify({
    prompt: 'Respond with "JSON_INPUT_OK" only.'
  }) + '\n');
  assert.strictEqual(jsonInputRes.code, 0, `Exit code should be 0, got ${jsonInputRes.code}`);
  trackCreatedSessionFromStdout(jsonInputRes.stdout);
  const jsonInputLines = jsonInputRes.stdout.trim().split('\n');
  assert(jsonInputLines.length > 0, 'Should output at least one line');
  const jsonEvents = jsonInputLines.map(l => JSON.parse(l));
  const jsonTypes = jsonEvents.map(e => e.type);
  assert(jsonTypes.includes('start'), 'Should have start event');
  assert(jsonTypes.includes('done') || jsonTypes.includes('error'), 'Should finish with done or error event');
  console.log('  ✔ stream-chat --json-input pipeline passed');
}

async function testGetSession() {
  console.log('Testing: get-session command...');
  const listRes = await runBridge(['list-sessions']);
  const listJson = JSON.parse(listRes.stdout);
  if (listJson.sessions && listJson.sessions.length > 0) {
    const targetId = listJson.sessions[0].id;
    const res = await runBridge(['get-session', targetId]);
    assert.strictEqual(res.code, 0, `Exit code should be 0, got ${res.code}`);
    const json = JSON.parse(res.stdout);
    assert.strictEqual(json.success, true, 'json.success should be true');
    assert(json.session, 'json.session must exist');
    assert(Array.isArray(json.session.messages), 'json.session.messages must be an array');
    console.log(`  ✔ get-session passed for ${targetId} (${json.session.messages.length} messages loaded)`);

    const resDelimiter = await runBridge(['get-session', '--', targetId]);
    assert.strictEqual(resDelimiter.code, 0, `Exit code should be 0, got ${resDelimiter.code}`);
    const jsonDelimiter = JSON.parse(resDelimiter.stdout);
    assert.strictEqual(jsonDelimiter.success, true, 'jsonDelimiter.success should be true');
    assert.strictEqual(jsonDelimiter.id, targetId, 'Session ID should match');
    console.log(`  ✔ get-session passed with '--' option delimiter`);
  } else {
    console.log('  ⚠ get-session skipped (no sessions available)');
  }
}

async function testRenameSession() {
  console.log('Testing: rename-session command...');
  const listRes = await runBridge(['list-sessions']);
  const listJson = JSON.parse(listRes.stdout);
  if (listJson.sessions && listJson.sessions.length > 0) {
    const targetId = listJson.sessions[0].id;
    const testTitle = `Test Session ${Date.now()}`;

    const renameRes = await runBridge(['rename-session', targetId, testTitle]);
    assert.strictEqual(renameRes.code, 0, `Exit code should be 0, got ${renameRes.code}`);
    const renameJson = JSON.parse(renameRes.stdout);
    assert.strictEqual(renameJson.success, true, `renameJson.success should be true, got error: ${renameJson.error}`);
    assert.strictEqual(renameJson.title, testTitle, 'Title should match testTitle');

    console.log(`  ✔ rename-session passed for ${targetId} -> "${renameJson.title}"`);
  } else {
    console.log('  ⚠ rename-session skipped (no sessions available)');
  }
}

async function testManifest() {
  console.log('Testing: manifest.json schema and defaults...');
  const manifestPath = path.join(__dirname, '..', 'manifest.json');
  const manifest = JSON.parse(require('fs').readFileSync(manifestPath, 'utf8'));
  
  assert.strictEqual(manifest.id, 'com.mwhuss.omarchy-hermes-api');
  assert.strictEqual(manifest.barWidget.defaults.notifyOnComplete, true);
  assert.strictEqual(manifest.barWidget.defaults.notifyOnError, true);

  const keys = manifest.barWidget.schema.map(s => s.key);
  assert(keys.includes('notifyOnComplete'), 'Schema should include notifyOnComplete');
  assert(keys.includes('notifyOnError'), 'Schema should include notifyOnError');
  console.log('  ✔ manifest configuration validation passed');
}

async function testStreamChatNotify() {
  console.log('Testing: stream-chat with --notify flag...');
  const res = await runBridge(['stream-chat', '--prompt', 'Respond with "OK" only.', '--notify']);
  assert.strictEqual(res.code, 0, `Exit code should be 0, got ${res.code}`);
  trackCreatedSessionFromStdout(res.stdout);

  const lines = res.stdout.trim().split('\n');
  assert(lines.length > 0, 'Should output at least one NDJSON event line');

  const events = lines.map(l => JSON.parse(l));
  const types = events.map(e => e.type);

  assert(types.includes('start'), 'Should have a start event');
  assert(types.includes('done'), 'Should have a done event');
  assert(!res.stderr.includes('ReferenceError'), 'stderr should not contain ReferenceError');
  console.log('  ✔ stream-chat with --notify completed successfully');
}

async function testClientGeneratedSessionId() {
  console.log('Testing: client session ID auto-generation and event tagging...');
  const res = await runBridge(['stream-chat', '--prompt', 'Reply with "AUTO_ID_OK" only.']);
  assert.strictEqual(res.code, 0, `Exit code should be 0, got ${res.code}`);
  trackCreatedSessionFromStdout(res.stdout);

  const lines = res.stdout.trim().split('\n');
  assert(lines.length > 0, 'Should output at least one line');
  const events = lines.map(l => JSON.parse(l));

  const startEv = events.find(e => e.type === 'start');
  assert(startEv, 'Should have start event');
  assert(startEv.session_id, 'start event must contain session_id');
  assert(typeof startEv.session_id === 'string' && startEv.session_id.startsWith('api-'), 'session_id should be non-empty string starting with api-');

  const doneEv = events.find(e => e.type === 'done');
  assert(doneEv, 'Should have done event');
  assert.strictEqual(doneEv.session_id, startEv.session_id, 'done event session_id must match start session_id');

  // Verify all delta and tool_progress events carry this session_id
  for (const ev of events) {
    if (ev.type === 'delta' || ev.type === 'tool_progress') {
      assert.strictEqual(ev.session_id, startEv.session_id, `${ev.type} must include session_id matching start event`);
    }
  }

  console.log('  ✔ auto-generated session_id verified across events (id:', startEv.session_id, ')');
}

async function testConcurrentStreams() {
  console.log('Testing: concurrent multi-session stream execution...');
  const session1 = `test-concurrent-1-${Date.now()}`;
  const session2 = `test-concurrent-2-${Date.now()}`;

  const [res1, res2] = await Promise.all([
    runBridge(['stream-chat', '--session', session1, '--prompt', 'Reply with "CONC_ONE" only.']),
    runBridge(['stream-chat', '--session', session2, '--prompt', 'Reply with "CONC_TWO" only.'])
  ]);

  trackCreatedSessionFromStdout(res1.stdout);
  trackCreatedSessionFromStdout(res2.stdout);
  if (!createdSessionIds.includes(session1)) createdSessionIds.push(session1);
  if (!createdSessionIds.includes(session2)) createdSessionIds.push(session2);

  assert.strictEqual(res1.code, 0, `Stream 1 exit code should be 0, got ${res1.code}`);
  assert.strictEqual(res2.code, 0, `Stream 2 exit code should be 0, got ${res2.code}`);

  const events1 = res1.stdout.trim().split('\n').map(l => JSON.parse(l));
  const events2 = res2.stdout.trim().split('\n').map(l => JSON.parse(l));

  const done1 = events1.find(e => e.type === 'done');
  const done2 = events2.find(e => e.type === 'done');

  assert(done1, 'Stream 1 should finish with done');
  assert(done2, 'Stream 2 should finish with done');
  assert.strictEqual(done1.session_id, session1, 'Stream 1 done event should match session1');
  assert.strictEqual(done2.session_id, session2, 'Stream 2 done event should match session2');

  console.log('  ✔ concurrent streams completed independently and successfully');
}

async function testSettings() {
  const settingsPath = path.join(os.homedir(), '.config', 'omarchy-hermes-api', 'settings.json');
  const initialContent = fs.existsSync(settingsPath) ? fs.readFileSync(settingsPath, 'utf8') : null;

  try {
    console.log('Testing: get-settings command...');
    const getRes = await runBridge(['get-settings']);
    assert.strictEqual(getRes.code, 0, `Exit code should be 0, got ${getRes.code}`);
    const getJson = JSON.parse(getRes.stdout);
    assert.strictEqual(getJson.success, true, 'get-settings should succeed');
    assert(Array.isArray(getJson.settings.endpoints), 'settings should contain endpoints array');
    console.log('  ✔ get-settings passed (endpoints:', getJson.settings.endpoints.length, ')');

    console.log('Testing: save-settings command and permissions...');
    const testPayload = {
      endpoints: [
        {
          id: 'test-endpoint',
          name: 'Test Endpoint',
          url: 'http://127.0.0.1',
          port: 8642,
          apiKey: 'test-key',
          profiles: [
            { name: 'default', apiKey: '' },
            { name: 'coder', apiKey: 'coder-key' }
          ]
        }
      ]
    };

    const saveRes = await runBridge(['save-settings', JSON.stringify(testPayload)]);
    assert.strictEqual(saveRes.code, 0, `Exit code should be 0, got ${saveRes.code}`);
    const saveJson = JSON.parse(saveRes.stdout);
    assert.strictEqual(saveJson.success, true, 'save-settings should succeed');

    assert(fs.existsSync(settingsPath), 'settings.json must exist on disk');
    const stat = fs.statSync(settingsPath);
    const mode = stat.mode & 0o777;
    assert.strictEqual(mode, 0o600, `File permissions should be 0600, got ${mode.toString(8)}`);
    console.log('  ✔ save-settings passed with 0600 file permissions');

    // Verify default profile is never saved to JSON and only custom profiles exist
    const savedData = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    assert.strictEqual(savedData.endpoints[0].profiles.length, 1, 'Only custom profiles should be saved in JSON');
    assert.strictEqual(savedData.endpoints[0].profiles[0].name, 'coder', 'Only custom coder profile should be saved');
    assert.strictEqual(savedData.endpoints[0].profiles.some(p => p.name === 'default'), false, 'Default profile must never be saved in JSON');
    console.log('  ✔ default profile omission from JSON verified');

    console.log('Testing: save-settings via stdin pipeline (--stdin)...');
    const stdinPayload = {
      endpoints: [
        {
          id: 'stdin-endpoint',
          name: 'Stdin Endpoint',
          url: 'http://127.0.0.1',
          port: 8642,
          apiKey: 'stdin-secret-key',
          profiles: []
        }
      ]
    };
    const stdinRes = await runBridge(['save-settings', '--stdin'], JSON.stringify(stdinPayload) + '\n');
    assert.strictEqual(stdinRes.code, 0, `Exit code should be 0, got ${stdinRes.code}`);
    const stdinJson = JSON.parse(stdinRes.stdout);
    assert.strictEqual(stdinJson.success, true, 'save-settings --stdin should succeed');
    console.log('  ✔ save-settings --stdin pipeline verified');

    console.log('Testing: save-settings validation...');
    // Invalid port
    const invalidPortRes = await runBridge(['save-settings', JSON.stringify({
      endpoints: [{ name: 'Test', url: 'http://127.0.0.1', port: 99999 }]
    })]);
    const invalidPortJson = JSON.parse(invalidPortRes.stdout);
    assert.strictEqual(invalidPortJson.success, false, 'invalid port should fail');

    // Empty name
    const emptyNameRes = await runBridge(['save-settings', JSON.stringify({
      endpoints: [{ name: '', url: 'http://127.0.0.1', port: 8642 }]
    })]);
    const emptyNameJson = JSON.parse(emptyNameRes.stdout);
    assert.strictEqual(emptyNameJson.success, false, 'empty endpoint name should fail');

    // Empty endpoints array
    const emptyArrayRes = await runBridge(['save-settings', JSON.stringify({
      endpoints: []
    })]);
    const emptyArrayJson = JSON.parse(emptyArrayRes.stdout);
    assert.strictEqual(emptyArrayJson.success, false, 'empty endpoints array should fail');

    console.log('  ✔ save-settings validation properly rejects invalid inputs');

    console.log('Testing: hideCronSessions preference (get-settings default)...');
    // Normalize state: the default assertion must not depend on a pre-existing user preference
    await runBridge(['set-hide-cron', 'false']);
    const getHideRes = await runBridge(['get-settings']);
    const getHideJson = JSON.parse(getHideRes.stdout);
    assert.strictEqual(getHideJson.success, true, 'get-settings should succeed');
    assert.strictEqual(getHideJson.settings.hideCronSessions, false, 'hideCronSessions should default to false when absent');
    console.log('  ✔ hideCronSessions defaults to false');

    console.log('Testing: set-hide-cron command...');
    const setHideRes = await runBridge(['set-hide-cron', 'true']);
    assert.strictEqual(setHideRes.code, 0, `set-hide-cron exit code should be 0, got ${setHideRes.code}`);
    const setHideJson = JSON.parse(setHideRes.stdout);
    assert.strictEqual(setHideJson.success, true, 'set-hide-cron should succeed');
    assert.strictEqual(setHideJson.hideCronSessions, true, 'set-hide-cron should report hideCronSessions true');

    const stat2 = fs.statSync(settingsPath);
    assert.strictEqual(stat2.mode & 0o777, 0o600, 'set-hide-cron must preserve 0600 file permissions');

    const getHide2Res = await runBridge(['get-settings']);
    const getHide2Json = JSON.parse(getHide2Res.stdout);
    assert.strictEqual(getHide2Json.settings.hideCronSessions, true, 'get-settings should reflect set-hide-cron true');
    console.log('  ✔ set-hide-cron true round-trips with 0600 permissions');

    console.log('Testing: save-settings round-trips hideCronSessions...');
    const saveHideRes = await runBridge(['save-settings', JSON.stringify({
      endpoints: [{ name: 'Test', url: 'http://127.0.0.1', port: 8642 }],
      hideCronSessions: true
    })]);
    const saveHideJson = JSON.parse(saveHideRes.stdout);
    assert.strictEqual(saveHideJson.success, true, 'save-settings with hideCronSessions should succeed');
    assert.strictEqual(saveHideJson.settings.hideCronSessions, true, 'save-settings should echo hideCronSessions true');
    const savedHide = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    assert.strictEqual(savedHide.hideCronSessions, true, 'hideCronSessions must be persisted to disk by save-settings');
    console.log('  ✔ save-settings round-trips hideCronSessions');

    console.log('Testing: save-settings preserves hideCronSessions when omitted...');
    const saveOmitRes = await runBridge(['save-settings', JSON.stringify({
      endpoints: [{ name: 'Test', url: 'http://127.0.0.1', port: 8642 }]
    })]);
    const saveOmitJson = JSON.parse(saveOmitRes.stdout);
    assert.strictEqual(saveOmitJson.success, true, 'save-settings without hideCronSessions should succeed');
    assert.strictEqual(saveOmitJson.settings.hideCronSessions, true, 'save-settings must preserve existing hideCronSessions when omitted');
    const savedOmit = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    assert.strictEqual(savedOmit.hideCronSessions, true, 'hideCronSessions must survive a save-settings that omits it');
    console.log('  ✔ save-settings preserves hideCronSessions when omitted');

    console.log('Testing: set-hide-cron fails closed on an invalid settings file...');
    const invalidContent = '{ not valid json';
    fs.writeFileSync(settingsPath, invalidContent, { mode: 0o600 });
    const badHideRes = await runBridge(['set-hide-cron', 'true']);
    const badHideJson = JSON.parse(badHideRes.stdout);
    assert.strictEqual(badHideJson.success, false, 'set-hide-cron must fail when the settings file is invalid');
    assert.strictEqual(fs.readFileSync(settingsPath, 'utf8'), invalidContent, 'set-hide-cron must not overwrite an invalid settings file');
    console.log('  ✔ set-hide-cron fails closed and leaves the invalid file untouched');

    console.log('Testing: set-hide-cron seeds defaults when no settings file exists...');
    fs.unlinkSync(settingsPath);
    const seedHideRes = await runBridge(['set-hide-cron', 'true'], null, { HERMES_API_SERVER_KEY: 'seed-test-key' });
    const seedHideJson = JSON.parse(seedHideRes.stdout);
    assert.strictEqual(seedHideJson.success, true, 'set-hide-cron should succeed on a fresh install by seeding defaults');
    assert.strictEqual(seedHideJson.hideCronSessions, true, 'set-hide-cron should report hideCronSessions true');
    const seededData = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    assert(Array.isArray(seededData.endpoints) && seededData.endpoints.length > 0, 'seeded settings must include the default endpoint');
    assert.strictEqual(seededData.hideCronSessions, true, 'seeded settings must persist hideCronSessions');
    console.log('  ✔ set-hide-cron seeds defaults on a fresh install');

    // Reset the preference so the finally-restore leaves a clean state
    await runBridge(['set-hide-cron', 'false']);
  } finally {
    if (initialContent !== null) {
      fs.writeFileSync(settingsPath, initialContent, { mode: 0o600 });
    } else if (fs.existsSync(settingsPath)) {
      try { fs.unlinkSync(settingsPath); } catch (e) {}
    }
  }
}

async function testMonograms() {
  console.log('Testing: monogram algorithm...');
  const { getAgentMonogram, getAgentColor } = require(bridgePath);
  const cases = [
    { input: 'Luna Bot', expected: 'LB' },
    { input: 'LunaBot', expected: 'LB' },
    { input: 'Lunabot', expected: 'L' },
    { input: 'aryabot', expected: 'A' },
    { input: 'Deep Research Agent', expected: 'DR' }
  ];
  for (const c of cases) {
    const monogram = getAgentMonogram(c.input);
    const color = getAgentColor(c.input);
    assert.strictEqual(monogram, c.expected, `Monogram for "${c.input}" should be "${c.expected}", got "${monogram}"`);
    assert(color.startsWith('#'), 'Color should be hex string');
  }
  console.log('  ✔ monogram generation rules verified (2-word, CamelCase, 1-word)');
}

async function testListTargetsAndActiveTarget() {
  console.log('Testing: list-targets and set-active-target commands...');
  const targetsRes = await runBridge(['list-targets']);
  assert.strictEqual(targetsRes.code, 0);
  const targetsJson = JSON.parse(targetsRes.stdout);
  assert.strictEqual(targetsJson.success, true);
  assert(Array.isArray(targetsJson.targets), 'targets should be an array');
  assert(targetsJson.targets.length > 0, 'at least one target endpoint');
  const firstTarget = targetsJson.targets[0];
  assert(firstTarget.endpointId, 'target must have endpointId');
  assert(firstTarget.profiles.length > 0, 'target must have profiles');
  assert.strictEqual(firstTarget.profiles[0].name, 'default', 'first profile must be default');
  console.log(`  ✔ list-targets passed (${targetsJson.targets.length} endpoints checked)`);

  const setRes = await runBridge(['set-active-target', firstTarget.endpointId, 'default']);
  assert.strictEqual(setRes.code, 0);
  const setJson = JSON.parse(setRes.stdout);
  assert.strictEqual(setJson.success, true);
  assert.strictEqual(setJson.activeTarget.endpointId, firstTarget.endpointId);
  assert.strictEqual(setJson.activeTarget.profileName, 'default');
  console.log('  ✔ set-active-target passed');
}

function testCliOptionsParser() {
  console.log('Testing: CLI options parser (parseCliOptions)...');
  const { parseCliOptions } = require(bridgePath);
  assert.strictEqual(typeof parseCliOptions, 'function', 'parseCliOptions must be exported');

  // 1. Basic command
  let r = parseCliOptions(['status']);
  assert.deepStrictEqual(r, { endpoint: null, profile: null, rest: ['status'] });

  // 2. Command with -- delimiter
  r = parseCliOptions(['get-session', '--', 'my-session-id']);
  assert.deepStrictEqual(r, { endpoint: null, profile: null, rest: ['get-session', 'my-session-id'] });

  // 3. Flags before -- delimiter
  r = parseCliOptions(['rename-session', '--endpoint', 'ep1', '--profile', 'prof1', '--', 'my-session-id', 'New Title']);
  assert.deepStrictEqual(r, { endpoint: 'ep1', profile: 'prof1', rest: ['rename-session', 'my-session-id', 'New Title'] });

  // 4. Short flags (-e, -p)
  r = parseCliOptions(['-e', 'ep2', '-p', 'prof2', 'delete-session', '--', 'my-session-id']);
  assert.deepStrictEqual(r, { endpoint: 'ep2', profile: 'prof2', rest: ['delete-session', 'my-session-id'] });

  // 5. Flags with = syntax (--endpoint=..., --profile=...)
  r = parseCliOptions(['--endpoint=ep3', '--profile=prof3', 'get-session', '--', 'my-session-id']);
  assert.deepStrictEqual(r, { endpoint: 'ep3', profile: 'prof3', rest: ['get-session', 'my-session-id'] });

  // 6. Options after -- are treated as positional, not flags
  r = parseCliOptions(['rename-session', '--', '--session-that-looks-like-a-flag', '--endpoint']);
  assert.deepStrictEqual(r, { endpoint: null, profile: null, rest: ['rename-session', '--session-that-looks-like-a-flag', '--endpoint'] });

  console.log('  ✔ CLI options parser verified across all edge cases');
}

async function testZeroDependencies() {
  console.log('Testing: package.json zero-dependency configuration...');
  const pkgPath = path.join(__dirname, '..', 'package.json');
  const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
  assert(!pkg.dependencies || Object.keys(pkg.dependencies).length === 0, 'package.json should have no runtime dependencies');
  assert(pkg.engines && pkg.engines.node, 'package.json must specify engines.node');
  console.log('  ✔ zero runtime dependencies and engines declaration verified');
}

async function testMockSseStreamWithCustomEvents() {
  console.log('Testing: native fetch SSE parser with custom events and fragmented chunks...');
  const server = http.createServer((req, res) => {
    if (req.url.endsWith('/chat/completions') && req.method === 'POST') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive'
      });

      // Write an SSE comment
      res.write(': ping\n\n');

      // Write custom Hermes tool progress event
      res.write('event: hermes.tool.progress\n');
      res.write('data: {"tool":"terminal_run","status":"running","label":"ls -la","id":"call_test_123"}\n\n');

      // Write delta tokens with artificial chunk fragmentation
      res.write('data: {"choices":[{"delta":{"con');
      setTimeout(() => {
        res.write('tent":"Fragmented ' + 'tokens"}}]}\n\n');
        res.write('data: [DONE]\n\n');
        res.end();
      }, 50);
    } else {
      res.writeHead(404);
      res.end();
    }
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;

  try {
    const res = await runBridge(['stream-chat', '--prompt', 'hello'], null, {
      HERMES_API_SERVER_URL: `http://127.0.0.1:${port}`,
      HERMES_API_SERVER_PORT: String(port)
    });

    assert.strictEqual(res.code, 0, `Exit code should be 0, got ${res.code}. stderr: ${res.stderr}`);
    const lines = res.stdout.trim().split('\n').filter(Boolean);
    const events = lines.map(l => JSON.parse(l));

    const toolEvent = events.find(e => e.type === 'tool_progress');
    assert(toolEvent, 'tool_progress event should be parsed from custom SSE event');
    assert.strictEqual(toolEvent.tool, 'terminal_run');
    assert.strictEqual(toolEvent.id, 'call_test_123');

    const deltaEvent = events.find(e => e.type === 'delta');
    assert(deltaEvent, 'delta event should be parsed across fragmented chunks');
    assert.strictEqual(deltaEvent.content, 'Fragmented tokens');

    const doneEvent = events.find(e => e.type === 'done');
    assert(doneEvent, 'done event should be emitted');
    assert.strictEqual(doneEvent.full_text, 'Fragmented tokens');

    console.log('  ✔ native fetch SSE parser handled comments, custom events, and chunk fragmentation');
  } finally {
    server.close();
  }
}

async function testToolProgressEventCap() {
  console.log('Testing: tool_progress event cap (hostile endpoint)...');
  const server = await startTestServer((req, res) => {
    if (req.url.endsWith('/chat/completions') && req.method === 'POST') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive'
      });
      for (let i = 0; i < 501; i++) {
        res.write('event: hermes.tool.progress\n');
        res.write(`data: {"tool":"t","status":"running","label":"l${i}","id":"call_${i}"}\n\n`);
      }
      res.write('data: [DONE]\n\n');
      res.end();
    } else {
      res.writeHead(404);
      res.end();
    }
  });

  try {
    const res = await runBridge(['stream-chat', '--prompt', 'hello'], null, {
      HERMES_API_SERVER_URL: `http://127.0.0.1:${server.address().port}`,
      HERMES_API_SERVER_PORT: String(server.address().port)
    });

    assert.strictEqual(res.code, 0, `Exit code should be 0, got ${res.code}. stderr: ${res.stderr}`);
    const events = res.stdout.trim().split('\n').filter(Boolean).map(l => JSON.parse(l));
    const toolEvents = events.filter(e => e.type === 'tool_progress');
    const running = toolEvents.filter(e => e.status === 'running');
    const truncated = toolEvents.filter(e => e.status === 'truncated');

    assert.strictEqual(running.length, 500, `expected 500 forwarded tool events, got ${running.length}`);
    assert.strictEqual(truncated.length, 1, `expected exactly 1 truncated notice, got ${truncated.length}`);
    assert.strictEqual(truncated[0].label, 'Tool event limit reached');
    assert.strictEqual(running[0].id, 'call_0');
    assert.strictEqual(running[499].id, 'call_499');
    assert(!toolEvents.some(e => e.id === 'call_500'), 'event beyond the cap must be dropped');

    const doneEvent = events.find(e => e.type === 'done');
    assert(doneEvent, 'stream must continue to done after the cap is hit');

    console.log('  ✔ 501-event stream capped at 500 + 1 truncated notice, stream completed cleanly');
  } finally {
    server.close();
  }
}

async function testToolProgressOversizedLabel() {
  console.log('Testing: tool_progress oversized label (hostile endpoint)...');
  const bigLabel = 'x'.repeat(100 * 1024); // 100 KiB
  const server = await startTestServer((req, res) => {
    if (req.url.endsWith('/chat/completions') && req.method === 'POST') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive'
      });
      res.write('event: hermes.tool.progress\n');
      res.write(`data: ${JSON.stringify({ tool: 'terminal_run', status: 'running', label: bigLabel, id: 'call_big' })}\n\n`);
      res.write('data: [DONE]\n\n');
      res.end();
    } else {
      res.writeHead(404);
      res.end();
    }
  });

  try {
    const res = await runBridge(['stream-chat', '--prompt', 'hello'], null, {
      HERMES_API_SERVER_URL: `http://127.0.0.1:${server.address().port}`,
      HERMES_API_SERVER_PORT: String(server.address().port)
    });

    assert.strictEqual(res.code, 0, `Exit code should be 0, got ${res.code}. stderr: ${res.stderr}`);
    const events = res.stdout.trim().split('\n').filter(Boolean).map(l => JSON.parse(l));
    const toolEvents = events.filter(e => e.type === 'tool_progress');
    assert.strictEqual(toolEvents.length, 1, `expected 1 tool event, got ${toolEvents.length}`);

    const ev = toolEvents[0];
    const fieldBytes = Buffer.byteLength(ev.tool, 'utf8') + Buffer.byteLength(ev.label, 'utf8')
      + Buffer.byteLength(ev.emoji || '', 'utf8') + Buffer.byteLength(ev.id, 'utf8');
    assert(fieldBytes <= 4096, `tool event fields must fit 4 KiB, got ${fieldBytes} bytes`);
    assert(ev.label.length > 0, 'label should be truncated to fit, not emptied');
    assert.strictEqual(ev.id, 'call_big');

    const doneEvent = events.find(e => e.type === 'done');
    assert(doneEvent, 'stream must complete after an oversized event');

    console.log(`  ✔ 100 KiB label truncated to ${Buffer.byteLength(ev.label, 'utf8')} bytes, no crash`);
  } finally {
    server.close();
  }
}

async function testToolProgressOversizedStatus() {
  console.log('Testing: tool_progress oversized status (hostile endpoint)...');
  const bigStatus = 's'.repeat(100 * 1024); // 100 KiB
  const server = await startTestServer((req, res) => {
    if (req.url.endsWith('/chat/completions') && req.method === 'POST') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive'
      });
      res.write('event: hermes.tool.progress\n');
      res.write(`data: ${JSON.stringify({ tool: 'terminal_run', status: bigStatus, label: 'ls', id: 'call_s' })}\n\n`);
      res.write('data: [DONE]\n\n');
      res.end();
    } else {
      res.writeHead(404);
      res.end();
    }
  });

  try {
    const res = await runBridge(['stream-chat', '--prompt', 'hello'], null, {
      HERMES_API_SERVER_URL: `http://127.0.0.1:${server.address().port}`,
      HERMES_API_SERVER_PORT: String(server.address().port)
    });

    assert.strictEqual(res.code, 0, `Exit code should be 0, got ${res.code}. stderr: ${res.stderr}`);
    const events = res.stdout.trim().split('\n').filter(Boolean).map(l => JSON.parse(l));
    const toolEvents = events.filter(e => e.type === 'tool_progress');
    assert.strictEqual(toolEvents.length, 1, `expected 1 tool event, got ${toolEvents.length}`);

    const ev = toolEvents[0];
    // All five attacker-controlled fields must fit the 4 KiB per-event budget.
    const fieldBytes = Buffer.byteLength(ev.tool, 'utf8') + Buffer.byteLength(ev.label, 'utf8')
      + Buffer.byteLength(ev.emoji || '', 'utf8') + Buffer.byteLength(ev.id, 'utf8')
      + Buffer.byteLength(ev.status, 'utf8');
    assert(fieldBytes <= 4096, `tool event fields must fit 4 KiB, got ${fieldBytes} bytes`);
    assert.strictEqual(ev.id, 'call_s', 'id must survive status truncation (truncated last)');

    const doneEvent = events.find(e => e.type === 'done');
    assert(doneEvent, 'stream must complete after an oversized status');

    console.log(`  ✔ 100 KiB status truncated to ${Buffer.byteLength(ev.status, 'utf8')} bytes, no crash`);
  } finally {
    server.close();
  }
}

async function testStreamDurationCeiling() {
  console.log('Testing: stream total-duration ceiling (hostile endpoint)...');
  // Dribble one event every 400 ms: keeps the 60 s idle timer perpetually
  // reset, so only the (shortened) total-duration ceiling can end the stream.
  const server = await startTestServer((req, res) => {
    if (req.url.endsWith('/chat/completions') && req.method === 'POST') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive'
      });
      let n = 0;
      const interval = setInterval(() => {
        res.write('event: hermes.tool.progress\n');
        res.write(`data: {"tool":"t","status":"running","label":"tick","id":"tick_${n++}"}\n\n`);
      }, 400);
      res.on('close', () => clearInterval(interval));
    } else {
      res.writeHead(404);
      res.end();
    }
  });

  try {
    const res = await runBridge(['stream-chat', '--prompt', 'hello'], null, {
      HERMES_API_SERVER_URL: `http://127.0.0.1:${server.address().port}`,
      HERMES_API_SERVER_PORT: String(server.address().port),
      HERMES_STREAM_DURATION_MS: '1500'
    });

    assert.strictEqual(res.code, 0, `Exit code should be 0, got ${res.code}. stderr: ${res.stderr}`);
    const events = res.stdout.trim().split('\n').filter(Boolean).map(l => JSON.parse(l));
    const errorEvent = events.find(e => e.type === 'error');
    assert(errorEvent, 'duration ceiling must produce an error event');
    assert(/total duration/.test(errorEvent.error), `error should mention total duration, got: ${errorEvent.error}`);
    assert(!events.some(e => e.type === 'done'), 'stream must not complete normally');

    console.log(`  ✔ dribbling stream aborted at duration ceiling (${errorEvent.error})`);
  } finally {
    server.close();
  }
}

async function testToolProgressRegression() {
  console.log('Testing: normal tool_progress stream unchanged (regression)...');
  const server = await startTestServer((req, res) => {
    if (req.url.endsWith('/chat/completions') && req.method === 'POST') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive'
      });
      const events = [
        { tool: 'terminal_run', status: 'running', label: 'ls -la', emoji: '🖥️', id: 'call_a' },
        { tool: 'terminal_run', status: 'done', label: 'ls -la', emoji: '🖥️', id: 'call_a' },
        { tool: 'web_search', status: 'running', label: 'hermes docs', emoji: '🔎', id: 'call_b' }
      ];
      for (const ev of events) {
        res.write('event: hermes.tool.progress\n');
        res.write(`data: ${JSON.stringify(ev)}\n\n`);
      }
      res.write('data: {"choices":[{"delta":{"content":"All done"}}]}\n\n');
      res.write('data: [DONE]\n\n');
      res.end();
    } else {
      res.writeHead(404);
      res.end();
    }
  });

  try {
    const res = await runBridge(['stream-chat', '--prompt', 'hello'], null, {
      HERMES_API_SERVER_URL: `http://127.0.0.1:${server.address().port}`,
      HERMES_API_SERVER_PORT: String(server.address().port)
    });

    assert.strictEqual(res.code, 0, `Exit code should be 0, got ${res.code}. stderr: ${res.stderr}`);
    const events = res.stdout.trim().split('\n').filter(Boolean).map(l => JSON.parse(l));
    const toolEvents = events.filter(e => e.type === 'tool_progress');
    assert.strictEqual(toolEvents.length, 3, `expected all 3 tool events forwarded, got ${toolEvents.length}`);
    assert.deepStrictEqual(
      toolEvents.map(e => ({ tool: e.tool, status: e.status, label: e.label, emoji: e.emoji, id: e.id })),
      [
        { tool: 'terminal_run', status: 'running', label: 'ls -la', emoji: '🖥️', id: 'call_a' },
        { tool: 'terminal_run', status: 'done', label: 'ls -la', emoji: '🖥️', id: 'call_a' },
        { tool: 'web_search', status: 'running', label: 'hermes docs', emoji: '🔎', id: 'call_b' }
      ],
      'tool events must be forwarded unchanged'
    );
    assert(!toolEvents.some(e => e.status === 'truncated'), 'no truncated notice for a normal stream');

    console.log('  ✔ normal 3-event tool stream forwarded unchanged');
  } finally {
    server.close();
  }
}

async function testNon2xxStalledErrorBody() {
  console.log('Testing: non-2xx stalled error body timeout (hostile endpoint)...');
  const server = await startTestServer((req, res) => {
    if (req.url.endsWith('/chat/completions') && req.method === 'POST') {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.flushHeaders();
      // Never send a body or close the connection
    } else {
      res.writeHead(404);
      res.end();
    }
  });

  try {
    const t0 = Date.now();
    const res = await runBridge(['stream-chat', '--prompt', 'hello'], null, {
      HERMES_API_SERVER_URL: `http://127.0.0.1:${server.address().port}`,
      HERMES_API_SERVER_PORT: String(server.address().port),
      HERMES_ERROR_BODY_TIMEOUT_MS: '400'
    });
    const elapsed = Date.now() - t0;

    assert.strictEqual(res.code, 0, `Exit code should be 0, got ${res.code}. stderr: ${res.stderr}`);
    const events = res.stdout.trim().split('\n').filter(Boolean).map(l => JSON.parse(l));
    const errorEvent = events.find(e => e.type === 'error');
    assert(errorEvent, 'stalled non-2xx body must produce an error event');
    assert(/timed out|abort/i.test(errorEvent.error), `error should mention timeout/abort, got: ${errorEvent.error}`);
    assert(elapsed < 3000, `bridge must exit promptly on error body timeout, took ${elapsed}ms`);

    console.log(`  ✔ stalled non-2xx body aborted promptly at timeout (${elapsed}ms: ${errorEvent.error})`);
  } finally {
    server.close();
  }
}

async function testNon2xxSlowDripErrorBody() {
  console.log('Testing: non-2xx slow-drip error body timeout (hostile endpoint)...');
  const server = await startTestServer((req, res) => {
    if (req.url.endsWith('/chat/completions') && req.method === 'POST') {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.flushHeaders();
      const timer = setInterval(() => {
        if (!res.writableEnded) res.write('x');
      }, 100);
      req.on('close', () => clearInterval(timer));
    } else {
      res.writeHead(404);
      res.end();
    }
  });

  try {
    const t0 = Date.now();
    const res = await runBridge(['stream-chat', '--prompt', 'hello'], null, {
      HERMES_API_SERVER_URL: `http://127.0.0.1:${server.address().port}`,
      HERMES_API_SERVER_PORT: String(server.address().port),
      HERMES_ERROR_BODY_TIMEOUT_MS: '400'
    });
    const elapsed = Date.now() - t0;

    assert.strictEqual(res.code, 0, `Exit code should be 0, got ${res.code}. stderr: ${res.stderr}`);
    const events = res.stdout.trim().split('\n').filter(Boolean).map(l => JSON.parse(l));
    const errorEvent = events.find(e => e.type === 'error');
    assert(errorEvent, 'slow-drip non-2xx body must produce an error event');
    assert(/timed out|abort/i.test(errorEvent.error), `error should mention timeout/abort, got: ${errorEvent.error}`);
    assert(elapsed < 3000, `bridge must exit promptly on slow-drip timeout, took ${elapsed}ms`);

    console.log(`  ✔ slow-drip non-2xx body aborted promptly at timeout (${elapsed}ms: ${errorEvent.error})`);
  } finally {
    server.close();
  }
}

async function testNon2xxNormalErrorBody() {
  console.log('Testing: non-2xx normal error body parses properly...');
  const server = await startTestServer((req, res) => {
    if (req.url.endsWith('/chat/completions') && req.method === 'POST') {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'Invalid model configuration' } }));
    } else {
      res.writeHead(404);
      res.end();
    }
  });

  try {
    const res = await runBridge(['stream-chat', '--prompt', 'hello'], null, {
      HERMES_API_SERVER_URL: `http://127.0.0.1:${server.address().port}`,
      HERMES_API_SERVER_PORT: String(server.address().port)
    });

    assert.strictEqual(res.code, 0, `Exit code should be 0, got ${res.code}. stderr: ${res.stderr}`);
    const events = res.stdout.trim().split('\n').filter(Boolean).map(l => JSON.parse(l));
    const errorEvent = events.find(e => e.type === 'error');
    assert(errorEvent, 'non-2xx must produce an error event');
    assert(/Invalid model configuration/.test(errorEvent.error), `error detail should be extracted, got: ${errorEvent.error}`);

    console.log(`  ✔ normal non-2xx error extracted message: ${errorEvent.error}`);
  } finally {
    server.close();
  }
}

function startTestServer(handler) {
  return new Promise((resolve, reject) => {
    const server = http.createServer(handler);
    server.listen(0, '127.0.0.1', () => resolve(server));
    server.on('error', reject);
  });
}

// Raw-socket server for responses with lying/invalid Content-Length headers.
// Node's http server buffers headers until the body is written, so it cannot
// simulate a server that declares a size it never sends.
function startRawServer(onSocket, rawSockets, servers) {
  return new Promise((resolve, reject) => {
    const server = require('net').createServer((socket) => {
      rawSockets.push(socket);
      onSocket(socket);
    });
    server.listen(0, '127.0.0.1', () => resolve(server));
    server.on('error', reject);
    servers.push(server);
  });
}

async function testBoundedResponse() {
  console.log('Testing: bounded response byte limits and body consumption timeouts...');
  const { boundedFetch, readBoundedJson, readBoundedText } = require(bridgePath);
  assert.strictEqual(typeof boundedFetch, 'function', 'boundedFetch must be exported');
  assert.strictEqual(typeof readBoundedJson, 'function', 'readBoundedJson must be exported');
  assert.strictEqual(typeof readBoundedText, 'function', 'readBoundedText must be exported');

  const servers = [];
  const rawSockets = [];
  const start = async (handler) => {
    const s = await startTestServer(handler);
    servers.push(s);
    return s;
  };
  const portOf = s => s.address().port;

  try {
    // 1. Stream overflow: 128KB in 1KB chunks, no Content-Length
    {
      let clientDisconnected = false;
      const server = await start((req, res) => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        req.on('close', () => { clientDisconnected = true; });
        let sent = 0;
        const timer = setInterval(() => {
          if (res.writableEnded) { clearInterval(timer); return; }
          res.write('x'.repeat(1024));
          sent += 1024;
          if (sent >= 128 * 1024) { clearInterval(timer); res.end(); }
        }, 2);
      });
      const res = await boundedFetch(`http://127.0.0.1:${portOf(server)}/`, {}, 65536, 5000);
      await assert.rejects(readBoundedJson(res, 65536), /exceeds 65536 byte limit/);
      await new Promise(r => setTimeout(r, 50));
      assert(clientDisconnected, 'server should observe client disconnect after overflow abort');
      console.log('  ✔ readBoundedJson rejects on stream overflow and server sees disconnect');
    }

    // 2. Eager Content-Length rejection: oversized CL, body never sent.
    //    If the client tried to read the body it would hang until timeout,
    //    so a fast rejection proves no body read happened.
    {
      const server = await startRawServer((socket) => {
        socket.write(
          'HTTP/1.1 200 OK\r\n' +
          'Content-Type: application/json\r\n' +
          'Content-Length: 200000\r\n' +
          'Connection: close\r\n' +
          '\r\n'
        );
        // Never send a body — a body read would hang until the timeout.
      }, rawSockets, servers);
      const res = await boundedFetch(`http://127.0.0.1:${portOf(server)}/`, {}, 65536, 5000);
      const t0 = Date.now();
      await assert.rejects(readBoundedJson(res, 65536), /Content-Length 200000 exceeds 65536 byte limit/);
      assert(Date.now() - t0 < 1000, 'eager Content-Length rejection must not read the body');
      console.log('  ✔ readBoundedJson rejects eagerly on oversized Content-Length');
    }

    // 3. Invalid Content-Length values. undici rejects malformed CL at
    //    fetch time, so exercise the readBoundedJson validation branch
    //    directly with a stub response.
    for (const badCl of ['abc', '-1']) {
      let released = false;
      const fakeRes = {
        headers: { get: (h) => (String(h).toLowerCase() === 'content-length' ? badCl : null) },
        json: () => Promise.resolve({}),
        body: null,
        boundedRelease: () => { released = true; }
      };
      await assert.rejects(readBoundedJson(fakeRes, 65536), /Invalid Content-Length header/);
      assert(released, 'boundedRelease should be called on invalid Content-Length');
    }
    console.log('  ✔ readBoundedJson rejects on invalid Content-Length values');

    // 4. Total timeout: headers arrive, body slow-drips past timeoutMs
    {
      const server = await start((req, res) => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        const timer = setInterval(() => {
          if (!res.writableEnded) res.write('a');
        }, 100);
        req.on('close', () => clearInterval(timer));
      });
      const res = await boundedFetch(`http://127.0.0.1:${portOf(server)}/`, {}, 65536, 300);
      const t0 = Date.now();
      await assert.rejects(readBoundedJson(res, 65536), /timed out|abort/i);
      const elapsed = Date.now() - t0;
      assert(elapsed < 2000, `total timeout should fire near 300ms, took ${elapsed}ms`);
      console.log(`  ✔ total timeout aborts slow-drip body (fired at ~${elapsed}ms)`);
    }

    // 5. Boundary: exactly maxBytes passes, maxBytes + 1 rejects
    {
      const maxBytes = 1024;
      const padLen = maxBytes - Buffer.byteLength('{"k":""}');
      const exactBody = `{"k":"${'a'.repeat(padLen)}"}`;
      assert.strictEqual(Buffer.byteLength(exactBody), maxBytes);
      const server = await start((req, res) => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(exactBody);
      });
      const res = await boundedFetch(`http://127.0.0.1:${portOf(server)}/`, {}, maxBytes, 5000);
      const data = await readBoundedJson(res, maxBytes);
      assert.strictEqual(data.k.length, padLen, 'exact-maxBytes body should parse');
      console.log('  ✔ body of exactly maxBytes parses successfully');

      const overBody = `{"k":"${'a'.repeat(padLen + 1)}"}`;
      assert.strictEqual(Buffer.byteLength(overBody), maxBytes + 1);
      const server2 = await start((req, res) => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(overBody);
      });
      const res2 = await boundedFetch(`http://127.0.0.1:${portOf(server2)}/`, {}, maxBytes, 5000);
      await assert.rejects(readBoundedJson(res2, maxBytes), /exceeds 1024 byte limit/);
      console.log('  ✔ body of maxBytes+1 rejects');
    }

    // 6. Regression: small valid JSON still parses
    {
      const server = await start((req, res) => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ data: [{ id: 'hermes-agent' }] }));
      });
      const res = await boundedFetch(`http://127.0.0.1:${portOf(server)}/`, {}, 65536, 5000);
      const data = await readBoundedJson(res, 65536);
      assert.strictEqual(data.data[0].id, 'hermes-agent');
      console.log('  ✔ small valid JSON body still parses (regression)');
    }

    // 7. readBoundedText reads a small text body
    {
      const server = await start((req, res) => {
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        res.end('plain error body');
      });
      const res = await boundedFetch(`http://127.0.0.1:${portOf(server)}/`, {}, 32768, 5000);
      const text = await readBoundedText(res, 32768);
      assert.strictEqual(text, 'plain error body');
      console.log('  ✔ readBoundedText reads small text body');
    }

    // 8. E2E: status against a >64KB streaming server reports the byte
    //    limit and exits promptly (no OOM, no 10s hang)
    {
      const server = await start((req, res) => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        const timer = setInterval(() => {
          if (!res.writableEnded) res.write('x'.repeat(1024));
        }, 2);
        req.on('close', () => clearInterval(timer));
      });
      const t0 = Date.now();
      const res = await runBridge(['status'], null, {
        HERMES_API_SERVER_URL: `http://127.0.0.1:${portOf(server)}`,
        HERMES_API_SERVER_PORT: String(portOf(server))
      });
      const elapsed = Date.now() - t0;
      assert.strictEqual(res.code, 0, `status exit code should be 0, got ${res.code}`);
      const json = JSON.parse(res.stdout);
      assert.strictEqual(json.success, false, 'status should fail against overflow server');
      assert(/exceeds 65536 byte limit/.test(json.error), `error should mention byte limit, got: ${json.error}`);
      assert(elapsed < 8000, `bridge should exit promptly, took ${elapsed}ms`);
      console.log(`  ✔ e2e: status against >64KB stream reports byte-limit error and exits in ${elapsed}ms`);
    }

    // 9. SSE stream: a single oversized line with no newline must be
    //    rejected (lineBuffer cap) — the idle timer resets on every chunk,
    //    so without the cap a huge line grows memory without bound.
    {
      const server = await start((req, res) => {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        res.write('data: ' + 'x'.repeat(1500 * 1024) + '\n\n');
        res.end();
      });
      const t0 = Date.now();
      const res = await runBridge(['stream-chat', '--prompt', 'hi'], null, {
        HERMES_API_SERVER_URL: `http://127.0.0.1:${portOf(server)}`,
        HERMES_API_SERVER_PORT: String(portOf(server))
      });
      const elapsed = Date.now() - t0;
      assert.strictEqual(res.code, 0, `stream-chat exit code should be 0, got ${res.code}`);
      const events = res.stdout.trim().split('\n').map(l => JSON.parse(l));
      const errEvent = events.find(e => e.type === 'error');
      assert(errEvent, 'should emit an error event for oversized SSE line');
      assert(/exceeds 1048576 character limit/.test(errEvent.error), `error should mention the line limit, got: ${errEvent.error}`);
      assert(elapsed < 8000, `bridge should exit promptly, took ${elapsed}ms`);
      console.log(`  ✔ e2e: oversized SSE line rejected and bridge exits in ${elapsed}ms`);
    }
  } finally {
    for (const s of servers) {
      s.close();
      if (typeof s.closeAllConnections === 'function') s.closeAllConnections();
    }
    for (const s of rawSockets) {
      try { s.destroy(); } catch (e) {}
    }
  }
}

async function testDeleteCreatedSessions() {
  console.log(`Testing: delete-session command and cleanup of created test sessions...`);
  assert(createdSessionIds.length > 0, 'Should have tracked sessions created during testing');

  // Also clean up any lingering test-concurrent-* sessions from prior test runs
  const initialListRes = await runBridge(['list-sessions']);
  const initialList = JSON.parse(initialListRes.stdout);
  if (Array.isArray(initialList.sessions)) {
    for (const s of initialList.sessions) {
      if (s.id.includes('test-concurrent-') && !createdSessionIds.includes(s.id)) {
        createdSessionIds.push(s.id);
      }
    }
  }

  let deletedCount = 0;
  for (const sid of createdSessionIds) {
    const res = await runBridge(['delete-session', '--', sid]);
    assert.strictEqual(res.code, 0, `delete-session exit code should be 0 for ${sid}, got ${res.code}`);
    const json = JSON.parse(res.stdout);
    assert.strictEqual(json.success, true, `delete-session should succeed for ${sid}`);
    assert.strictEqual(json.deleted, true, `delete-session should report deleted: true for ${sid}`);
    deletedCount++;
  }

  // Verify that none of the deleted sessions remain in list-sessions
  const listRes = await runBridge(['list-sessions']);
  assert.strictEqual(listRes.code, 0);
  const listJson = JSON.parse(listRes.stdout);
  assert.strictEqual(listJson.success, true);
  const remainingIds = new Set((listJson.sessions || []).map(s => s.id));

  for (const sid of createdSessionIds) {
    const rawId = sid.includes(':') ? sid.split(':').slice(2).join(':') : sid;
    const stillExists = Array.from(remainingIds).some(id => id === sid || id.endsWith(`:${rawId}`));
    assert(!stillExists, `Deleted session ${sid} should no longer appear in list-sessions`);
  }

  console.log(`  ✔ successfully deleted all ${deletedCount} created test sessions and verified removal`);
}

function testUrlGuard() {
  console.log('Testing: url-guard allowlist...');
  const guardPath = path.join(__dirname, '..', 'bin', 'url-guard.js');
  const guard = require(guardPath);

  assert(typeof guard.isAllowedWebUrl === 'function', 'isAllowedWebUrl should be a function');
  assert(typeof guard.openSafeUrl === 'function', 'openSafeUrl should be a function');

  // Allowed: http/https with a non-empty host (case-insensitive, trimmed).
  const allowed = [
    'https://example.com',
    'http://127.0.0.1:8642',
    'HTTPS://EXAMPLE.COM',
    '  https://x.com  '
  ];
  for (const url of allowed) {
    assert.strictEqual(guard.isAllowedWebUrl(url), true, `should allow ${JSON.stringify(url)}`);
  }

  // Rejected: dangerous schemes, custom protocols, relative links, empty, non-strings.
  const rejected = [
    'file:///etc/passwd',
    'data:text/html,<script>alert(1)</script>',
    'qrc:/x',
    'javascript:alert(1)',
    'custom-proto://run',
    'relative/path',
    '',
    null,
    undefined,
    42
  ];
  for (const url of rejected) {
    assert.strictEqual(guard.isAllowedWebUrl(url), false, `should reject ${JSON.stringify(url)}`);
  }

  // Rejected: userinfo in the host, control characters, over-length,
  // malformed hosts/ports.
  const rejectedHardened = [
    'https://user:pass@evil.com',
    'https://user@evil.com',
    'http://evil.com\x00',
    'https://evil.com\x07',
    'https://' + 'a'.repeat(2049) + '.com',
    'https://',
    'https://.com',
    'https://-bad.com',
    'http://example.com:99999',
    'http://example.com:80:443'
  ];
  for (const url of rejectedHardened) {
    assert.strictEqual(guard.isAllowedWebUrl(url), false, `should reject ${JSON.stringify(url)}`);
  }

  // Allowed: @ in the PATH is fine (only host userinfo is dangerous), and
  // bracketed IPv6 literals with a port.
  assert.strictEqual(guard.isAllowedWebUrl('https://github.com/@user'), true, 'path @ should be allowed');
  assert.strictEqual(guard.isAllowedWebUrl('http://[::1]:8642'), true, 'bracketed IPv6 should be allowed');

  // openSafeUrl must hand the system handler the exact string it validated
  // (trimmed), and must not call it for rejected URLs.
  const opened = [];
  global.Qt = { openUrlExternally: (u) => opened.push(u) };
  guard.openSafeUrl('  https://x.com  ');
  guard.openSafeUrl('file:///etc/passwd');
  guard.openSafeUrl(null);
  delete global.Qt;
  assert.strictEqual(opened.length, 1, 'openSafeUrl should open exactly one URL');
  assert.strictEqual(opened[0], 'https://x.com', 'openSafeUrl should pass the trimmed URL');

  console.log(`  ✔ url-guard allowlist passed (${allowed.length} allowed, ${rejected.length + rejectedHardened.length} rejected)`);
}

function testSanitizeMarkdown() {
  console.log('Testing: sanitizeMarkdown trust boundary (SSRF and rich-text neutralization)...');
  const guardPath = path.join(__dirname, '..', 'bin', 'url-guard.js');
  const guard = require(guardPath);

  assert(typeof guard.sanitizeMarkdown === 'function', 'sanitizeMarkdown should be a function');

  // 1. Hostile Markdown images: allowed web URLs are converted to safe links [Image: alt](url),
  // preventing automatic image fetching/decoding during document layout.
  assert.strictEqual(
    guard.sanitizeMarkdown('Look at ![Architecture](https://example.com/arch.png) here'),
    'Look at [Image: Architecture](https://example.com/arch.png) here',
    'inline image with allowed web url should become a link'
  );
  assert.strictEqual(
    guard.sanitizeMarkdown('![Logo](<https://example.com/logo.png>)'),
    '[Image: Logo](https://example.com/logo.png)',
    'inline image with angle brackets should become a link'
  );
  assert.strictEqual(
    guard.sanitizeMarkdown('![Chart](https://example.com/chart.png "Quarterly Profits")'),
    '[Image: Chart](https://example.com/chart.png)',
    'inline image with title should become a link'
  );
  assert.strictEqual(
    guard.sanitizeMarkdown('!   [Chart](https://example.com/chart.png)'),
    '[Image: Chart](https://example.com/chart.png)',
    'inline image with whitespace between ! and [ should become a link'
  );
  assert.strictEqual(
    guard.sanitizeMarkdown('\\![Chart](https://example.com/chart.png)'),
    '[Image: Chart](https://example.com/chart.png)',
    'escaped inline image marker should become a link'
  );
  assert.strictEqual(
    guard.sanitizeMarkdown('![](https://example.com/empty-alt.png)'),
    '[Image](https://example.com/empty-alt.png)',
    'image with empty alt should become [Image](url)'
  );

  // 2. Hostile Markdown images: dangerous/local schemes (file:, data:, javascript:, custom protocols)
  // are completely stripped of URL target, preventing local file reading and SSRF.
  assert.strictEqual(
    guard.sanitizeMarkdown('![Passwd](file:///etc/passwd)'),
    '[Image: Passwd]',
    'image pointing to file:// must have url stripped'
  );
  assert.strictEqual(
    guard.sanitizeMarkdown('![](data:image/png;base64,AAAA)'),
    '[Image]',
    'image with data: URI must have url stripped'
  );
  assert.strictEqual(
    guard.sanitizeMarkdown('![Internal](http://169.254.169.254/latest/meta-data/)'),
    '[Image: Internal](http://169.254.169.254/latest/meta-data/)',
    'image with http url becomes link, harmless during layout (clicked links route through openSafeUrl)'
  );

  // 3. Reference-style images: converted to reference links, preventing image resolution
  assert.strictEqual(
    guard.sanitizeMarkdown('![Ref Diagram][diagram]\n\n[diagram]: https://example.com/d.png'),
    '[Image: Ref Diagram][diagram]\n\n[diagram]: https://example.com/d.png',
    'reference image should become reference link'
  );
  assert.strictEqual(
    guard.sanitizeMarkdown('![shortcut]\n\n[shortcut]: https://example.com/s.png'),
    '[Image: shortcut]\n\n[shortcut]: https://example.com/s.png',
    'shortcut reference image should become reference link'
  );

  // 4. Raw HTML and XML rich-text constructs: stripped to prevent unsolicited network requests
  assert.strictEqual(
    guard.sanitizeMarkdown('Check <img src="http://127.0.0.1:8642/leak.png"> this out'),
    'Check  this out',
    'raw html img tag must be stripped'
  );
  assert.strictEqual(
    guard.sanitizeMarkdown('Check <img\n  src="http://leak.com"\n  alt="test"> here'),
    'Check  here',
    'multiline html img tag must be stripped'
  );
  assert.strictEqual(
    guard.sanitizeMarkdown('A<style>@import "evil.css";</style>B'),
    'AB',
    'raw html style block must be stripped'
  );
  assert.strictEqual(
    guard.sanitizeMarkdown('A<script>alert(1)</script>B'),
    'AB',
    'raw html script block must be stripped'
  );
  assert.strictEqual(
    guard.sanitizeMarkdown('A<svg><image xlink:href="http://evil.com/leak"></svg>B'),
    'AB',
    'raw svg block must be stripped'
  );
  assert.strictEqual(
    guard.sanitizeMarkdown('A<object data="http://evil.com/leak"></object>B'),
    'AB',
    'raw object block must be stripped'
  );
  assert.strictEqual(
    guard.sanitizeMarkdown('A<iframe src="http://evil.com/leak"></iframe>B'),
    'AB',
    'raw iframe block must be stripped'
  );
  assert.strictEqual(
    guard.sanitizeMarkdown('A<!-- <img src="evil.com"> -->B'),
    'AB',
    'html comments must be stripped'
  );

  // 5. HTML links & autolinks: safe web links converted to markdown, dangerous links neutralized
  assert.strictEqual(
    guard.sanitizeMarkdown('<a href="https://example.com">Visit Site</a>'),
    '[Visit Site](https://example.com)',
    'safe html <a> tag should convert to markdown link'
  );
  assert.strictEqual(
    guard.sanitizeMarkdown('<a href="file:///etc/passwd">Secret</a>'),
    'Secret',
    'dangerous html <a> href must be dropped'
  );
  assert.strictEqual(
    guard.sanitizeMarkdown('Read <https://example.com> now'),
    'Read [https://example.com](https://example.com) now',
    'safe web autolink should convert to markdown link'
  );
  assert.strictEqual(
    guard.sanitizeMarkdown('Read <file:///etc/passwd> now'),
    'Read  now',
    'dangerous autolink must be stripped'
  );

  // 6. Code blocks and inline code spans: preserved untouched
  const codeBlock = '```html\n<img src="http://example.com/cat.png">\n```';
  assert.strictEqual(
    guard.sanitizeMarkdown(codeBlock),
    codeBlock,
    'code blocks with html must remain literal and untouched'
  );
  const inlineCode = 'Use `<img src="foo.png">` tag';
  assert.strictEqual(
    guard.sanitizeMarkdown(inlineCode),
    inlineCode,
    'inline code with html must remain literal and untouched'
  );
  const dollarCode = '```bash\necho $HOME && echo $1 && echo $$\n```';
  assert.strictEqual(
    guard.sanitizeMarkdown(dollarCode),
    dollarCode,
    'code blocks with dollar signs must be restored literally'
  );

  // 7. Standard Markdown formatting: fully preserved
  const standardMd = '# Title\n**bold** *italic* `code` ~~strike~~\n- item 1\n- item 2\n> blockquote\n[regular link](https://example.com)';
  assert.strictEqual(
    guard.sanitizeMarkdown(standardMd),
    standardMd,
    'standard Markdown formatting and safe links must be preserved'
  );

  // 8. Robustness & boundaries: null, undefined, non-strings, oversized input
  assert.strictEqual(guard.sanitizeMarkdown(null), '');
  assert.strictEqual(guard.sanitizeMarkdown(undefined), '');
  assert.strictEqual(guard.sanitizeMarkdown(123), '');
  assert.strictEqual(guard.sanitizeMarkdown(''), '');
  const hugeInput = 'A'.repeat(2 * 1024 * 1024);
  const sanitizedHuge = guard.sanitizeMarkdown(hugeInput);
  assert.strictEqual(sanitizedHuge.length, 1024 * 1024, 'oversized input must be capped safely');

  console.log('  ✔ sanitizeMarkdown trust boundary verified across 25 hostile & regression cases');
}

async function runAllTests() {
  console.log('====================================');
  console.log(' Running Omarchy Hermes API Tests');
  console.log('====================================\n');

  const settingsPath = path.join(os.homedir(), '.config', 'omarchy-hermes-api', 'settings.json');
  const initialSettings = fs.existsSync(settingsPath) ? fs.readFileSync(settingsPath, 'utf8') : null;

  try {
    if (isLiveTest) {
      console.log('Mode: LIVE integration test against Hermes API daemon\n');
    } else {
      console.log('Mode: Hermetic test using built-in mock Hermes API server\n');
      mockServer = await startMockServer();
      const port = mockServer.address().port;
      defaultBridgeEnv = {
        HERMES_API_SERVER_URL: `http://127.0.0.1:${port}`,
        HERMES_API_SERVER_PORT: String(port)
      };
    }

    testCliOptionsParser();
    await testZeroDependencies();
    await testMockSseStreamWithCustomEvents();
    await testManifest();
    testUrlGuard();
    testSanitizeMarkdown();
    await testSettings();
    await testMonograms();
    await testListTargetsAndActiveTarget();
    await testStatus();
    await testListSessions();
    await testGetSession();
    await testRenameSession();
    await testStreamChat();
    await testClientGeneratedSessionId();
    await testConcurrentStreams();
    await testStreamChatNotify();
    await testToolProgressEventCap();
    await testToolProgressOversizedLabel();
    await testToolProgressOversizedStatus();
    await testStreamDurationCeiling();
    await testToolProgressRegression();
    await testNon2xxStalledErrorBody();
    await testNon2xxSlowDripErrorBody();
    await testNon2xxNormalErrorBody();
    await testBoundedResponse();
    await testDeleteCreatedSessions();
    console.log('\n====================================');
    console.log(' All tests passed successfully! 🎉');
    console.log('====================================\n');
  } catch (err) {
    console.error('\n❌ Test failed:', err.message);
    process.exit(1);
  } finally {
    if (mockServer) {
      mockServer.close();
    }
    if (initialSettings !== null) {
      try { fs.writeFileSync(settingsPath, initialSettings, { mode: 0o600 }); } catch (e) {}
    } else if (fs.existsSync(settingsPath)) {
      try { fs.unlinkSync(settingsPath); } catch (e) {}
    }
  }
}

runAllTests();

