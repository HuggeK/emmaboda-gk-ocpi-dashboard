// Builds the static dashboard into an output directory: a copy of public/ plus
// data/snapshot.json with everything the UI shows, ready for GitHub Pages or
// any static host. The OCPI key is only used here, at build time.
//
//   node scripts/build-snapshot.js [--out dist] [--days 400] [--demo] [--verbose]
//
// Configuration comes from the environment (OCPI_TOKEN, OCPI_VERSIONS_URL, ...)
// or from .env, exactly like the local server. Inside GitHub Actions the script
// also writes step outputs and a job summary so the workflow can report.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createOcpiClient, OcpiError } from '../server/ocpi-client.js';
import { createDemoClient } from '../server/demo-data.js';
import { buildSnapshot, DEFAULT_CDR_DAYS } from '../server/snapshot.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PUBLIC_DIR = path.join(ROOT, 'public');
const SNAPSHOT_META = '<meta name="dashboard-snapshot" content="data/snapshot.json">';
const args = process.argv.slice(2);

try {
  process.loadEnvFile(path.join(ROOT, '.env'));
} catch {
  // No .env - rely on real environment variables (GitHub Actions) or --demo.
}

function argValue(flag) {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : undefined;
}

const config = {
  demo: args.includes('--demo') || process.env.OCPI_DEMO === '1',
  verbose: args.includes('--verbose') || process.env.OCPI_VERBOSE === '1',
  outDir: path.resolve(ROOT, argValue('--out') || 'dist'),
  cdrDays: Number(argValue('--days') || DEFAULT_CDR_DAYS),
  versionsUrl: process.env.OCPI_VERSIONS_URL || 'https://ocpi.chargenode.eu/ocpi/cpo/versions',
  token: process.env.OCPI_TOKEN || '',
  tokenEncoding: process.env.OCPI_TOKEN_ENCODING || 'auto',
  preferredVersion: process.env.OCPI_PREFERRED_VERSION || undefined,
  fromCountryCode: process.env.OCPI_FROM_COUNTRY_CODE || undefined,
  fromPartyId: process.env.OCPI_FROM_PARTY_ID || undefined,
};
const inGitHubActions = process.env.GITHUB_ACTIONS === 'true';

const log = (message) => {
  if (config.verbose) console.log(`[ocpi] ${message}`);
};

// GitHub Actions plumbing; both are no-ops outside a workflow run.
function setOutputs(pairs) {
  if (!process.env.GITHUB_OUTPUT) return;
  const lines = Object.entries(pairs).map(([key, value]) => `${key}=${String(value ?? '').replace(/\r?\n/g, ' ')}`);
  fs.appendFileSync(process.env.GITHUB_OUTPUT, `${lines.join('\n')}\n`);
}
function addSummary(markdown) {
  if (!process.env.GITHUB_STEP_SUMMARY) return;
  fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${markdown}\n`);
}

function createClient() {
  if (config.demo) return createDemoClient();
  if (!config.token || config.token === 'replace-me') {
    throw new Error('No OCPI_TOKEN configured. Set it in .env or the environment, or run with --demo.');
  }
  return createOcpiClient({ ...config, log });
}

function writeSite(snapshot) {
  const { outDir } = config;
  if (outDir === ROOT || ROOT.startsWith(outDir + path.sep)) {
    throw new Error(`Refusing to build into ${outDir}: it contains the project itself.`);
  }
  fs.rmSync(outDir, { recursive: true, force: true });
  fs.cpSync(PUBLIC_DIR, outDir, { recursive: true });

  const indexPath = path.join(outDir, 'index.html');
  const html = fs.readFileSync(indexPath, 'utf8');
  const anchor = '<meta name="viewport"';
  if (!html.includes(anchor)) throw new Error('public/index.html has no viewport meta tag to anchor the snapshot tag on');
  fs.writeFileSync(indexPath, html.replace(anchor, `${SNAPSHOT_META}\n  ${anchor}`));

  fs.mkdirSync(path.join(outDir, 'data'), { recursive: true });
  fs.writeFileSync(path.join(outDir, 'data', 'snapshot.json'), JSON.stringify(snapshot));
  fs.writeFileSync(path.join(outDir, '.nojekyll'), '');
}

function describe(snapshot) {
  const { status, live, cdrs } = snapshot;
  const thirtyDaysAgo = Date.parse(status.generated_at) - 30 * 86_400_000;
  const recent = cdrs.items.filter((c) => Date.parse(c.start || c.end || 0) >= thirtyDaysAgo);
  return {
    generated_at: status.generated_at,
    ocpi_version: status.discovery.version,
    modules: Object.keys(status.discovery.endpoints).join(', '),
    evses: live.summary.evses_total,
    evses_charging: live.summary.evses_charging,
    cdr_count: cdrs.items.length,
    cdr_days: status.cdr_window.days,
    cdr_pages: status.counts.cdr_pages,
    sessions_30d: recent.length,
    kwh_30d: Math.round(recent.reduce((sum, c) => sum + (c.energy_kwh || 0), 0) * 10) / 10,
  };
}

// Set once ChargeNode has accepted the key on the versions endpoint, so a
// later 401 on a data module can be told apart from a rejected key.
let keyAccepted = false;

async function main() {
  const client = createClient();
  const startedAt = Date.now();

  // The versions call is what keeps the key alive at ChargeNode. Report it on
  // its own so a later failure (say, a CDR page timing out) cannot hide that
  // the key was in fact used.
  const discovery = await client.discover();
  keyAccepted = true;
  setOutputs({ key_used: 'true' });
  console.log(`Connected: OCPI ${discovery.version}, modules: ${Object.keys(discovery.endpoints).join(', ')}`);

  const snapshot = await buildSnapshot({
    client,
    cdrDays: config.cdrDays,
    generator: config.demo ? 'demo' : inGitHubActions ? 'github-actions' : 'local',
  });
  writeSite(snapshot);

  const info = describe(snapshot);
  const size = fs.statSync(path.join(config.outDir, 'data', 'snapshot.json')).size;
  console.log(`Snapshot written to ${config.outDir} (${Math.round(size / 1024)} kB) in ${Date.now() - startedAt} ms`);
  console.log(`  ${info.evses} charging points, ${info.cdr_count} charge records over ${info.cdr_days} days (${info.cdr_pages} pages), ${info.sessions_30d} sessions / ${info.kwh_30d} kWh in the last 30 days`);

  setOutputs({ result: 'ok', ...info });
  addSummary([
    '### Snapshot built',
    '',
    '| | |',
    '|---|---|',
    `| Generated | ${info.generated_at} |`,
    `| OCPI | ${info.ocpi_version} (${info.modules}) |`,
    `| Charging points | ${info.evses} (${info.evses_charging} charging at snapshot time) |`,
    `| Charge records | ${info.cdr_count} over ${info.cdr_days} days |`,
    `| Last 30 days | ${info.sessions_30d} sessions, ${info.kwh_30d} kWh |`,
  ].join('\n'));
}

main().catch((err) => {
  const details = err instanceof OcpiError ? err.toJSON() : { message: err?.message || String(err) };
  const unauthorized = details.code === 'UNAUTHORIZED';
  const result = !unauthorized ? 'error' : keyAccepted ? 'module_unauthorized' : 'unauthorized';
  const explanation = {
    unauthorized: 'ChargeNode rejected the OCPI key on the versions endpoint (HTTP 401). The key expires after a week without use; ask ChargeNode for a new one and update the SECRET_KEY repository secret.',
    module_unauthorized: `ChargeNode accepted the key on the versions and credentials endpoints but refused the data module (HTTP 401 from ${details.url}). That is how an OCPI registration token ("token A") behaves before the credentials handshake: ask ChargeNode for a key with direct read access to locations, sessions and cdrs, or to complete the registration.`,
    error: `Snapshot failed: ${details.message}`,
  }[result];
  console.error(explanation);
  console.error(JSON.stringify(details, null, 2));
  setOutputs({ result, error: details.message });
  addSummary(`### Snapshot failed\n\n${explanation}\n\n\`\`\`\n${JSON.stringify(details, null, 2)}\n\`\`\``);
  process.exit(1);
});
