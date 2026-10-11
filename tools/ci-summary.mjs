/**
 * Summarize a TAP test report.
 *
 * CI must state the pass and skip counts explicitly rather than leaving them
 * buried in a long log, and the counts have to be readable on both Windows and
 * Linux. Node writes TAP to a file (`--test-reporter-destination`), so this reads
 * a file rather than piping between processes — pipes behave differently on the
 * two platforms.
 *
 * @module dsh-plugin-conversation-toolkit/tools/ci-summary
 */
import fs from 'node:fs';
import process from 'node:process';

const report = process.argv[2] ?? 'test-report.tap';

if (!fs.existsSync(report)) {
  console.error(`no TAP report at ${report}`);
  process.exit(1);
}

const text = fs.readFileSync(report, 'utf8');

/**
 * Read one `# name N` line out of a TAP report.
 *
 * @param name - the TAP counter (`tests`, `pass`, `fail`, `skipped`).
 * @returns the count as a string, or `?` when the line is absent.
 */
function count(name) {
  const match = text.match(new RegExp(`^# ${name} (\\d+)$`, 'm'));
  return match === null ? '?' : match[1];
}

const tests = count('tests');
const pass = count('pass');
const fail = count('fail');
const skipped = count('skipped');

const line = `tests=${tests} pass=${pass} fail=${fail} skipped=${skipped}`;
console.log(line);

// Surface the same line on the workflow run page when GitHub asks for it.
if (typeof process.env.GITHUB_STEP_SUMMARY === 'string' && process.env.GITHUB_STEP_SUMMARY !== '') {
  fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${line}\n`);
}

// The summary must not mask the test result.
process.exit(fail === '0' ? 0 : 1);
