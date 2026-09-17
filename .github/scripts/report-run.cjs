// Posts the outcome of a snapshot run as a comment on one tracking issue, so
// every run (pass or fail) produces a GitHub notification. Called from the
// workflow through actions/github-script; all inputs arrive as environment
// variables set in the workflow file. CommonJS on purpose: package.json says
// "type": "module", and github-script's require() cannot load ES modules.
'use strict';

const LABEL = 'ocpi-key-heartbeat';
const TITLE = 'OCPI key heartbeat and dashboard publishing';
const TIME_ZONE = 'Europe/Stockholm';

function stamp(iso) {
  const date = iso ? new Date(iso) : new Date();
  if (Number.isNaN(date.getTime())) return String(iso);
  return date.toLocaleString('sv-SE', { timeZone: TIME_ZONE, dateStyle: 'short', timeStyle: 'short' });
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

  const body = [
    'The **Snapshot to GitHub Pages** workflow comments here after every run, so each pass and each failure shows up as a notification.',
    '',
    '- The OCPI key ChargeNode issued expires after **7 days without use**. Each run calls ChargeNode with it, which keeps it alive.',
    '- On success the run also rebuilds the public dashboard.',
    '- If a run reports **HTTP 401**, the key has expired: ask ChargeNode for a new key and store it with `gh secret set SECRET_KEY`.',
    '',
    `Keep this issue open; the workflow finds it by the \`${LABEL}\` label. Closing it only makes the next run open a new one.`,
  ].join('\n');

  const create = (assignees) => github.rest.issues.create({ owner, repo, title: TITLE, body, labels: [LABEL], assignees });
  try {
    return (await create([owner])).data; // assigning the owner subscribes them to the thread
  } catch (err) {
    if (err.status !== 422) throw err; // owner not assignable (an organisation); create unassigned
    return (await create([])).data;
  }
}

const TOKEN_A_HINT = '- The key opens the versions and credentials endpoints but not `locations`, `sessions` or `cdrs`. That is how an OCPI registration token ("token A") behaves before the credentials handshake, which needs an OCPI endpoint on our side. Ask ChargeNode for a key with direct read access to the CPO modules, or to complete the registration for us.';

function buildComment({ context, env }) {
  const result = env.BUILD_RESULT;
  const ok = env.JOB_STATUS === 'success' && result === 'ok';
  // The build publishes a data-less site when the key opens versions but not
  // the data modules; a later workflow step then marks the run failed.
  const degraded = result === 'module_unauthorized' && env.DEPLOY_OUTCOME === 'success';
  const { owner, repo } = context.repo;
  const runUrl = `${context.serverUrl}/${owner}/${repo}/actions/runs/${context.runId}`;
  const trigger = context.eventName === 'schedule'
    ? 'Scheduled run'
    : context.eventName === 'workflow_dispatch'
      ? 'Manual run'
      : `Run after push to ${String(context.ref).replace('refs/heads/', '')}`;
  const keyUsed = env.KEY_USED === 'true';
  const lines = [];

  if (ok) {
    lines.push(`### ✅ Snapshot published · ${stamp(env.GENERATED_AT)}`);
    lines.push('');
    lines.push(`- OCPI key used against ChargeNode: **yes** (OCPI ${env.OCPI_VERSION})`);
    lines.push(`- Dashboard: ${env.PAGE_URL || '(no page URL reported)'}`);
    lines.push(`- ${env.EVSES} charging points · ${env.CDR_COUNT} charge records over ${env.CDR_DAYS} days · last 30 days: ${env.SESSIONS_30D} sessions, ${env.KWH_30D} kWh`);
  } else if (degraded) {
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
    const heading = result === 'module_unauthorized'
      ? '⚠️ Key accepted, but ChargeNode refused the data modules (HTTP 401)'
      : result === 'unauthorized'
        ? '❌ ChargeNode rejected the OCPI key (HTTP 401)'
        : '❌ Run failed';
    lines.push(`### ${heading} · ${stamp()}`);
    lines.push('');
    lines.push(`- Failed while: **${failedWhile}**`);
    lines.push(`- OCPI key used against ChargeNode: **${keyUsed ? 'yes' : 'no'}**${keyUsed ? ' (the versions and credentials endpoints answered)' : ' (no endpoint accepted it, so ChargeNode may not count this run as use)'}`);
    if (env.BUILD_ERROR) lines.push(`- Error: \`${env.BUILD_ERROR}\``);
    if (result === 'unauthorized') {
      lines.push('- **The key looks expired or revoked.** Ask ChargeNode for a new key, store it, then re-run:');
      lines.push('  ```');
      lines.push(`  gh secret set SECRET_KEY -R ${owner}/${repo}`);
      lines.push(`  gh workflow run "Snapshot to GitHub Pages" -R ${owner}/${repo}`);
      lines.push('  ```');
    }
    if (result === 'module_unauthorized') lines.push(TOKEN_A_HINT);
  }
  lines.push(`- ${trigger} · [run log](${runUrl})`);
  return lines.join('\n');
}

module.exports = async ({ github, context, core }) => {
  const issue = await findOrCreateIssue({ github, context });
  const body = buildComment({ context, env: process.env });
  await github.rest.issues.createComment({ ...context.repo, issue_number: issue.number, body });
  core.info(`Reported on issue #${issue.number}: ${body.split('\n')[0]}`);
};

module.exports.buildComment = buildComment;
