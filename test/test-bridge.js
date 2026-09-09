/**
 * Test suite for Hermes API Bridge and Subprocess Interface
 */

const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');
const assert = require('assert');

const bridgePath = path.join(__dirname, '..', 'bin', 'hermes-bridge.js');

function runBridge(args, input = null) {
  return new Promise((resolve, reject) => {
    const proc = spawn('node', [bridgePath, ...args], {
      env: process.env,
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
  
  const lines = res.stdout.trim().split('\n');
  assert(lines.length > 0, 'Should output at least one NDJSON event line');
  
  const events = lines.map(l => JSON.parse(l));
  const types = events.map(e => e.type);

  assert(types.includes('start'), 'Should have a start event');
  assert(types.includes('done') || types.includes('error'), 'Should finish with done or error event');
  console.log('  ✔ stream-chat passed with events:', types.filter((v, i, a) => a.indexOf(v) === i).join(', '));
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

  const lines = res.stdout.trim().split('\n');
  assert(lines.length > 0, 'Should output at least one NDJSON event line');

  const events = lines.map(l => JSON.parse(l));
  const types = events.map(e => e.type);

  assert(types.includes('start'), 'Should have a start event');
  assert(types.includes('done'), 'Should have a done event');
  console.log('  ✔ stream-chat with --notify completed successfully');
}

async function testClientGeneratedSessionId() {
  console.log('Testing: client session ID auto-generation and event tagging...');
  const res = await runBridge(['stream-chat', '--prompt', 'Reply with "AUTO_ID_OK" only.']);
  assert.strictEqual(res.code, 0, `Exit code should be 0, got ${res.code}`);

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
  } finally {
    if (initialContent !== null) {
      fs.writeFileSync(settingsPath, initialContent, { mode: 0o600 });
    }
  }
}

async function testMonograms() {
  console.log('Testing: monogram command and algorithm...');
  const cases = [
    { input: 'Luna Bot', expected: 'LB' },
    { input: 'LunaBot', expected: 'LB' },
    { input: 'Lunabot', expected: 'L' },
    { input: 'aryabot', expected: 'A' },
    { input: 'Deep Research Agent', expected: 'DR' }
  ];
  for (const c of cases) {
    const res = await runBridge(['monogram', c.input]);
    assert.strictEqual(res.code, 0);
    const json = JSON.parse(res.stdout);
    assert.strictEqual(json.monogram, c.expected, `Monogram for "${c.input}" should be "${c.expected}", got "${json.monogram}"`);
    assert(json.color.startsWith('#'), 'Color should be hex string');
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

async function runAllTests() {
  console.log('====================================');
  console.log(' Running Omarchy Hermes API Tests');
  console.log('====================================\n');

  try {
    await testManifest();
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
    console.log('\n====================================');
    console.log(' All tests passed successfully! 🎉');
    console.log('====================================\n');
  } catch (err) {
    console.error('\n❌ Test failed:', err.message);
    process.exit(1);
  }
}

runAllTests();

