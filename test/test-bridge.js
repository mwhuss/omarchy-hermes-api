/**
 * Test suite for Hermes API Bridge and Subprocess Interface
 */

const { spawn } = require('child_process');
const path = require('path');
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

async function runAllTests() {
  console.log('====================================');
  console.log(' Running Omarchy Hermes API Tests');
  console.log('====================================\n');

  try {
    await testManifest();
    await testStatus();
    await testListSessions();
    await testGetSession();
    await testRenameSession();
    await testStreamChat();
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
