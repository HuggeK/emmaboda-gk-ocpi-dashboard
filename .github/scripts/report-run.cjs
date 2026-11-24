// Tracks the outcome of snapshot runs on one issue. Every run rewrites a
// status line in the issue body, which does not notify anyone. A comment,
// which does notify, is posted only when the outcome changes and once a day
// while the runs keep failing. Called from the workflow through
// actions/github-script; all inputs arrive as environment variables set in
// the workflow file. CommonJS on purpose: package.json says "type": "module",
// and github-script's require() cannot load ES modules.
'use strict';

const LABEL = 'ocpi-key-heartbeat';
const TITLE = 'OCPI key heartbeat and dashboard publishing';
const TIME_ZONE = 'Europe/Stockholm';
const REMINDER_MS = 24 * 3_600_000;
const STATE_MARKER = /<!-- snapshot-state: (\{.*?\}) -->/s;

const INTRO = [
  'The **Snapshot to GitHub Pages** workflow tracks its runs here.',
  '',
  '- The status line below is rewritten on every run (no notification).',
  '- A comment is posted when the outcome changes, and once a day while the runs keep failing, so each of those arrives as a notification.',
  '- Each run calls ChargeNode with the OCPI access key from the `SECRET_KEY` secret and rebuilds the public dashboard.',
  '- If a run reports **HTTP 401** on the versions endpoint, the key is dead: get a new registration key from ChargeNode and run `npm run handshake` (see the README).',
  '',
  `Keep this issue open; the workflow finds it by the \`${LABEL}\` label. Closing it only makes the next run open a new one.`,
].join('\n');

const TOKEN_A_HINT = '- The key opens the versions and credentials endpoints but not `locations`, `sessions` or `cdrs`. That is how an OCPI registration token ("token A") behaves before the credentials handshake; run `npm run handshake` with it (see the README).';

const LABELS = {
  ok: 'Snapshot published',
  module_unauthorized: 'Key accepted, data refused',
  unauthorized: 'Key rejected',
  deploy_failed: 'Deploy to GitHub Pages failed',
  cancelled: 'Run cancelled',
  error: 'Run failed',
};

function stamp(iso) {
  const date = iso ? new Date(iso) : new Date();
  if (Number.isNaN(date.getTime())) return String(iso);
  return date.toLocaleString('sv-SE', { timeZone: TIME_ZONE, dateStyle: 'short', timeStyle: 'short' });
}

function outcomeOf(env) {
  if (env.JOB_STATUS === 'success' && env.BUILD_RESULT === 'ok') return 'ok';
  if (env.BUILD_RESULT && env.BUILD_RESULT !== 'ok') return env.BUILD_RESULT;
  if (env.DEPLOY_OUTCOME === 'failure') return 'deploy_failed';
  return env.JOB_STATUS === 'cancelled' ? 'cancelled' : 'error';
}

function readState(body) {
  const match = STATE_MARKER.exec(body || '');
  if (!match) return null;
  try {
    return JSON.parse(match[1]);
  } catch {
    return null;
  }
}

async function findOrCreateIssue({ github, context }) {
  const { owner, repo } = context.repo;
  const { data: open } = await github.rest.issues.listForRepo({ owner, repo, labels: LABEL, state: 'open', per_page: 1 });
  if (open.length) return open[0];

  try {
    await github.rest.issues.createLabel({ owner, repo, name: LABEL, color: '1d76db', description: 'Automated reports from the snapshot workflow' });
  } catch (err) {
    if (err.status !== 422) throw err; // 422: the label already exists
  }

  const create = (assignees) => github.rest.issues.create({ owner, repo, title: TITLE, body: INTRO, labels: [LABEL], assignees });
  try {
    return (await create([owner])).data; // assigning the owner subscribes them to the thread
  } catch (err) {
    if (err.status !== 422) throw err; // owner not assignable (an organisation); create unassigned
    return (await create([])).data;
  }
}

function runUrlOf(context) {
  return `${context.serverUrl}/${context.repo.owner}/${context.repo.repo}/actions/runs/${context.runId}`;
}

function buildComment({ context, env, previous }) {
  const outcome = outcomeOf(env);
  const { owner, repo } = context.repo;
  const trigger = context.eventName === 'schedule'
    ? 'Scheduled run'
    : context.eventName === 'workflow_dispatch'
      ? 'Manual run'
      : `Run after push to ${String(context.ref).replace('refs/heads/', '')}`;
  const keyUsed = env.KEY_USED === 'true';
  const recovered = outcome === 'ok' && previous && previous.outcome !== 'ok';
  const lines = [];

  if (outcome === 'ok') {
    lines.push(`### ✅ ${recovered ? 'Recovered: snapshot published' : 'Snapshot published'} · ${stamp(env.GENERATED_AT)}`);
    lines.push('');
    lines.push(`- OCPI key used against ChargeNode: **yes** (OCPI ${env.OCPI_VERSION})`);
    lines.push(`- Dashboard: ${env.PAGE_URL || '(no page URL reported)'}`);
    lines.push(`- ${env.EVSES} charging points · ${env.CDR_COUNT} charge records since ${env.CDR_SINCE} (${env.INCREMENTAL === 'true' ? `${env.CDR_FETCHED} changed since the previous snapshot` : 'full fetch'}) · last 30 days: ${env.SESSIONS_30D} sessions, ${env.KWH_30D} kWh`);
    lines.push(`- ${eonLine(env)}`);
  } else if (outcome === 'module_unauthorized' && env.DEPLOY_OUTCOME === 'success') {
    // The build publishes a data-less site when the key opens versions but not
    // the data modules; a later workflow step then marks the run failed.
    lines.push(`### ⚠️ Key accepted, but ChargeNode refused the data modules (HTTP 401) · ${stamp(env.GENERATED_AT)}`);
    lines.push('');
    lines.push('- OCPI key used against ChargeNode: **yes** (the versions and credentials endpoints answered)');
    lines.push(`- Dashboard published without data: ${env.PAGE_URL || '(no page URL reported)'}`);
    if (env.BUILD_ERROR) lines.push(`- Error: \`${env.BUILD_ERROR}\``);
    lines.push(TOKEN_A_HINT);
  } else {
    const failedWhile = env.BUILD_OUTCOME === 'failure'
      ? 'fetching data from ChargeNode'
      : env.DEPLOY_OUTCOME === 'failure'
        ? 'deploying to GitHub Pages'
        : `an earlier step (job status: ${env.JOB_STATUS})`;
    const heading = outcome === 'module_unauthorized'
      ? '⚠️ Key accepted, but ChargeNode refused the data modules (HTTP 401)'
      : outcome === 'unauthorized'
        ? '❌ ChargeNode rejected the OCPI key (HTTP 401)'
        : `❌ ${LABELS[outcome] || 'Run failed'}`;
    lines.push(`### ${heading} · ${stamp()}`);
    lines.push('');
    lines.push(`- Failed while: **${failedWhile}**`);
    lines.push(`- OCPI key used against ChargeNode: **${keyUsed ? 'yes' : 'no'}**${keyUsed ? ' (the versions and credentials endpoints answered)' : ' (no endpoint accepted it, so ChargeNode may not count this run as use)'}`);
    if (env.BUILD_ERROR) lines.push(`- Error: \`${env.BUILD_ERROR}\``);
    if (outcome === 'unauthorized') {
      lines.push('- **The key looks expired or revoked.** Get a new registration key from ChargeNode, exchange it with `npm run handshake`, store the result, then re-run:');
      lines.push('  ```');
      lines.push(`  gh secret set SECRET_KEY -R ${owner}/${repo}`);
      lines.push(`  gh workflow run "Snapshot to GitHub Pages" -R ${owner}/${repo}`);
      lines.push('  ```');
    }
    if (outcome === 'module_unauthorized') lines.push(TOKEN_A_HINT);
  }
  lines.push(`- ${trigger} · [run log](${runUrlOf(context)})`);
  return { outcome, body: lines.join('\n') };
}

// The grid meter (E.ON Energidata API) is optional and never fails the run,
// so it is reported as a line of its own rather than as the outcome.
function eonLine(env) {
  switch (env.EON_RESULT) {
    case 'ok': return `Grid meter (E.ON): ${env.EON_HOURS} hourly values up to ${stamp(env.EON_LAST)}${env.EON_ERROR ? ` ⚠️ ${env.EON_ERROR}` : ''}`;
    case 'no_data': return `Grid meter (E.ON): ⚠️ connected but no values${env.EON_ERROR ? `: ${env.EON_ERROR}` : ''}`;
    case 'error': return `Grid meter (E.ON): ❌ ${env.EON_ERROR || 'failed'} (previous values kept; check the \`CLIENTID\` / \`CLIENTSECRET\` secrets)`;
    case 'not_configured': return 'Grid meter (E.ON): not configured (`CLIENTID` / `CLIENTSECRET` secrets unset)';
    default: return 'Grid meter (E.ON): not reported';
  }
}

function statusLine(outcome, env, now) {
  const icon = outcome === 'ok' ? '✅' : outcome === 'module_unauthorized' ? '⚠️' : '❌';
  const eonIcon = { ok: env.EON_ERROR ? ' · meter ⚠️' : ' · meter ✅', no_data: ' · meter ⚠️', error: ' · meter ❌' }[env.EON_RESULT] || '';
  const details = outcome === 'ok'
    ? ` · ${env.EVSES} charging points, ${env.CDR_COUNT} records, last 30 days ${env.SESSIONS_30D} sessions / ${env.KWH_30D} kWh${eonIcon}`
    : env.BUILD_ERROR ? ` · ${env.BUILD_ERROR}` : '';
  return `${icon} **${LABELS[outcome] || outcome}** · ${stamp(now.toISOString())}${details}`;
}

function renderBody({ context, env, outcome, now, state }) {
  const lines = [
    INTRO,
    '',
    '## Status',
    '',
    `- Latest run: ${statusLine(outcome, env, now)} ([run log](${runUrlOf(context)}))`,
    `- Last notification: ${state.notified_at ? stamp(state.notified_at) : 'never'}`,
  ];
  if (env.PAGE_URL) lines.push(`- Dashboard: ${env.PAGE_URL}`);
  lines.push('', `<!-- snapshot-state: ${JSON.stringify(state)} -->`);
  return lines.join('\n');
}

module.exports = async ({ github, context, core }) => {
  const env = process.env;
  const now = new Date();
  const issue = await findOrCreateIssue({ github, context });
  const previous = readState(issue.body);
  const { outcome, body } = buildComment({ context, env, previous });

  const changed = !previous || previous.outcome !== outcome;
  const reminderDue = outcome !== 'ok' && Boolean(previous) && now.getTime() - Date.parse(previous.notified_at || 0) >= REMINDER_MS;
  const notify = changed || reminderDue;
  if (notify) await github.rest.issues.createComment({ ...context.repo, issue_number: issue.number, body });

  const state = { outcome, at: now.toISOString(), notified_at: notify ? now.toISOString() : previous?.notified_at || null };
  await github.rest.issues.update({ ...context.repo, issue_number: issue.number, body: renderBody({ context, env, outcome, now, state }) });
  core.info(`${notify ? 'Commented on' : 'Updated status of'} issue #${issue.number}: ${body.split('\n')[0]}`);
};

module.exports.buildComment = buildComment;
module.exports.outcomeOf = outcomeOf;
module.exports.readState = readState;
module.exports.renderBody = renderBody;
