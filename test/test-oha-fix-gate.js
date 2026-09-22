/**
 * Regression test: oha-fix cron task0 ready-for-agent tag exemption.
 *
 * Background: the oha-fix cron watchdog (oha_cron_watchdog.sh) picks an issue
 * tagged `ready-for-agent`, creates the Task 0 (scaffold) kanban card, and
 * immediately CLAIMS the issue by removing the label. The task0 worker then
 * loads the oha-fix skill, whose specific-issue-path gate used to STOP on any
 * issue lacking the label — so the watchdog's own claim blocked the task it
 * just created. The fix exempts Task 0 from the label check while keeping the
 * gate intact for every other invocation.
 *
 * This test covers two behaviors:
 *   1. A task0 card without the ready-for-agent tag is eligible to run.
 *   2. A non-task0 card without the tag remains blocked.
 *
 * Part A (always runs, deterministic): the gate decision rule as a pure
 * function — the executable spec of the post-fix behavior.
 * Part B (runs when the real oha-fix SKILL.md is reachable): a contract check
 * against the actual skill file the task0 worker loads, so the prose gate and
 * this spec cannot drift apart. Skipped (not failed) in CI, where the skill
 * file does not exist.
 *
 * Run: node test/test-oha-fix-gate.js
 * Override the skill path: OHA_FIX_SKILL_PATH=/path/to/SKILL.md
 */

const fs = require('fs');
const assert = require('assert');

// The copy the coder-profile task0 worker actually loads (confirmed via
// skill_view _source_path). Override with OHA_FIX_SKILL_PATH for testing.
const DEFAULT_SKILL_PATH = '/opt/data/profiles/coder/skills/oha-fix/SKILL.md';
const skillPath = process.env.OHA_FIX_SKILL_PATH || DEFAULT_SKILL_PATH;

// ---------------------------------------------------------------------------
// Part A: gate decision rule (executable spec)
// ---------------------------------------------------------------------------

/**
 * Post-fix oha-fix specific-issue-path gate.
 *
 * - Task 0 (scaffold): exempt. The cron watchdog already verified the label
 *   and claimed the issue by removing it, so task0 proceeds without
 *   re-checking it.
 * - Any other invocation (direct /oha-fix <N>, tasks 1-4): the issue must
 *   carry the ready-for-agent label or the gate is a hard stop.
 */
function isEligibleToRun({ isTask0, hasReadyForAgentTag }) {
  if (isTask0) return true;
  return hasReadyForAgentTag === true;
}

function testGateDecisionTable() {
  // The regression case: task0 without the tag must run.
  assert.strictEqual(
    isEligibleToRun({ isTask0: true, hasReadyForAgentTag: false }),
    true,
    'task0 card without ready-for-agent tag must be eligible to run'
  );
  // task0 with the tag (watchdog has not claimed yet) also runs.
  assert.strictEqual(
    isEligibleToRun({ isTask0: true, hasReadyForAgentTag: true }),
    true,
    'task0 card with ready-for-agent tag must be eligible to run'
  );
  // The acceptance case: non-task0 without the tag stays blocked.
  assert.strictEqual(
    isEligibleToRun({ isTask0: false, hasReadyForAgentTag: false }),
    false,
    'non-task0 card without ready-for-agent tag must remain blocked'
  );
  // Non-task0 with the tag is the normal path and still runs.
  assert.strictEqual(
    isEligibleToRun({ isTask0: false, hasReadyForAgentTag: true }),
    true,
    'non-task0 card with ready-for-agent tag must be eligible to run'
  );
  console.log('  ✓ gate decision table (task0 exempt, non-task0 gated)');
}

// ---------------------------------------------------------------------------
// Part B: contract check against the real oha-fix SKILL.md
// ---------------------------------------------------------------------------

function sectionBetween(text, startHeading, endHeading) {
  const start = text.indexOf(startHeading);
  assert.notStrictEqual(start, -1, `skill is missing section "${startHeading}"`);
  const rest = text.slice(start + startHeading.length);
  const end = rest.indexOf(endHeading);
  return end === -1 ? rest : rest.slice(0, end);
}

function testSkillContract() {
  let text;
  try {
    text = fs.readFileSync(skillPath, 'utf8');
  } catch (err) {
    console.log(`  ⚠ SKIP skill contract check — ${skillPath} not readable here (CI): ${err.code}`);
    return;
  }

  const specificIssue = sectionBetween(
    text,
    '### If an issue number was given',
    '### If no number was given'
  );

  // 1. Task 0 exemption: the specific-issue-path gate must carry an explicit
  //    Task 0 (scaffold) exception that skips the label check. Without this
  //    clause, a task0 card whose issue was already claimed by the watchdog
  //    (label removed) would be blocked — the regression this test guards.
  assert.match(
    specificIssue,
    /Exception\s*—\s*Task 0 \(scaffold\)/,
    'specific-issue path must contain the "Exception — Task 0 (scaffold)" clause'
  );
  assert.match(
    specificIssue,
    /Skip this label check/,
    'Task 0 exception must skip the ready-for-agent label check'
  );

  // 2. Non-task0 gate preserved: the hard stop for a specified issue without
  //    the label must still be present (the exemption is task0-only).
  assert.match(
    specificIssue,
    /no `ready-for-agent` label: STOP/,
    'specific-issue path must still STOP for non-task0 issues without the label'
  );

  // 3. Auto-selection path unchanged: the cron still only picks issues that
  //    carry the ready-for-agent label (claim-by-removal depends on this).
  const autoSelect = sectionBetween(
    text,
    '### If no number was given',
    '### Plan check (both paths)'
  );
  assert.match(
    autoSelect,
    /l\["name"\] == "ready-for-agent"/,
    'auto-selection path must still filter issues by the ready-for-agent label'
  );

  // 4. Pitfalls documents the exemption so future edits keep it intentional.
  assert.match(
    text,
    /Task 0\s*\(scaffold\) is exempt/,
    'Pitfalls must document that Task 0 (scaffold) is exempt from the label gate'
  );

  console.log(`  ✓ skill contract (${skillPath})`);
}

// ---------------------------------------------------------------------------

function runAllTests() {
  console.log('oha-fix task0 tag exemption regression tests\n');
  try {
    testGateDecisionTable();
    testSkillContract();
    console.log('\n====================================');
    console.log(' All tests passed successfully! 🎉');
    console.log('====================================\n');
  } catch (err) {
    console.error('\n❌ Test failed:', err.message);
    process.exit(1);
  }
}

runAllTests();
