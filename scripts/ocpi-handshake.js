// OCPI 2.2.1 credentials handshake: exchanges a registration key from
// ChargeNode ("token A") for the real access key ("token C").
//
//   node scripts/ocpi-handshake.js [--token <token A>] [--dry-run] [--write-env [path]]
//
// Token A comes from --token, from OCPI_TOKEN in the environment, or from .env.
// Our side of the handshake is the static OCPI presence published under /ocpi
// on GitHub Pages (see public/ocpi/), which ChargeNode fetches while we wait.
// The handshake is one-shot: on success token A stops working and token C
// replaces it, so the script prints token C and can write it into .env.
//
// Optional environment: OCPI_OUR_VERSIONS_URL (default: the Pages URL),
// OCPI_OUR_PARTY_ID (EGK), OCPI_OUR_COUNTRY_CODE (SE), OCPI_OUR_ROLE (EMSP),
// OCPI_OUR_NAME (Emmaboda GK).
import { randomBytes, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createOcpiClient } from '../server/ocpi-client.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);

try {
  process.loadEnvFile(path.join(ROOT, '.env'));
} catch {
  // No .env - rely on --token or the environment.
}

function argValue(flag) {
  const index = args.indexOf(flag);
  if (index < 0) return undefined;
  const next = args[index + 1];
  return next && !next.startsWith('--') ? next : true;
}

const config = {
  tokenA: (typeof argValue('--token') === 'string' ? argValue('--token') : '') || process.env.OCPI_TOKEN || '',
  dryRun: args.includes('--dry-run'),
  writeEnv: argValue('--write-env'),
  versionsUrl: process.env.OCPI_VERSIONS_URL || 'https://ocpi.chargenode.eu/ocpi/cpo/versions',
  ourVersionsUrl: process.env.OCPI_OUR_VERSIONS_URL || 'https://huggek.github.io/emmaboda-gk-ocpi-dashboard/ocpi/versions.json',
  ourPartyId: process.env.OCPI_OUR_PARTY_ID || 'EGK',
  ourCountryCode: process.env.OCPI_OUR_COUNTRY_CODE || 'SE',
  ourRole: process.env.OCPI_OUR_ROLE || 'EMSP',
  ourName: process.env.OCPI_OUR_NAME || 'Emmaboda GK',
};

const mask = (s) => (typeof s === 'string' && s.length > 8 ? `${s.slice(0, 4)}…${s.slice(-4)} (${s.length} chars)` : String(s));
const encode = (token, encoding) => (encoding === 'base64' ? Buffer.from(token, 'utf8').toString('base64') : token);
const routingIds = () => ({ 'X-Request-ID': randomUUID(), 'X-Correlation-ID': randomUUID() });

async function request(url, { method = 'GET', headers = {}, body } = {}) {
  const res = await fetch(url, {
    method,
    headers: { Accept: 'application/json', ...routingIds(), ...headers },
    body,
    signal: AbortSignal.timeout(60_000),
  });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = null;
  }
  return { status: res.status, contentType: res.headers.get('content-type') || '', json, text };
}

function fail(message) {
  console.error(`\n${message}`);
  process.exit(1);
}

function writeEnvFile(file, tokenC) {
  const line = `OCPI_TOKEN=${tokenC}`;
  let text = '';
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    text = '';
  }
  const updated = /^OCPI_TOKEN=.*$/m.test(text)
    ? text.replace(/^OCPI_TOKEN=.*$/m, line)
    : `${text}${text && !text.endsWith('\n') ? '\n' : ''}${line}\n`;
  fs.writeFileSync(file, updated);
  console.log(`OCPI_TOKEN updated in ${file}`);
}

async function main() {
  if (!config.tokenA || config.tokenA === 'replace-me') {
    fail('No registration key given. Pass --token <key>, set OCPI_TOKEN, or put it in .env.');
  }

  // 1. ChargeNode must accept token A and tell us where its credentials endpoint is.
  const client = createOcpiClient({ versionsUrl: config.versionsUrl, token: config.tokenA, tokenEncoding: 'auto' });
  let discovery;
  try {
    discovery = await client.discover();
  } catch (err) {
    fail(`ChargeNode did not accept the registration key on the versions endpoint: ${err.message}`);
  }
  const credentialsUrl = discovery.endpoints.credentials;
  if (!credentialsUrl) fail(`ChargeNode offers no credentials endpoint (modules: ${Object.keys(discovery.endpoints).join(', ')}).`);
  const auth = { Authorization: `Token ${encode(config.tokenA, discovery.encoding)}` };
  console.log(`ChargeNode: OCPI ${discovery.version}, token accepted (${discovery.encoding} encoding), credentials endpoint ${credentialsUrl}`);

  // 2. Their party, for the OCPI routing headers.
  const theirs = await request(credentialsUrl, { headers: auth });
  const theirRole = theirs.json?.data?.roles?.[0];
  if (theirs.status !== 200 || !theirRole) fail(`GET ${credentialsUrl} answered HTTP ${theirs.status}; cannot read ChargeNode's party.`);
  console.log(`ChargeNode party: ${theirRole.country_code}/${theirRole.party_id} (${theirRole.business_details?.name || 'no name'})`);

  // 3. Our side must be reachable the way ChargeNode will fetch it.
  const probeAuth = { Authorization: `Token ${encode('probe', 'base64')}` };
  const ours = await request(config.ourVersionsUrl, { headers: probeAuth });
  if (ours.status !== 200 || !Array.isArray(ours.json?.data)) {
    fail(`Our versions URL ${config.ourVersionsUrl} answered HTTP ${ours.status} (${ours.contentType}); publish the site first (the workflow does it on every push to main).`);
  }
  const detailsUrl = ours.json.data.find((v) => v.version === '2.2.1')?.url;
  const details = detailsUrl ? await request(detailsUrl, { headers: probeAuth }) : { status: 0, json: null, contentType: '' };
  if (details.status !== 200 || !details.json?.data?.endpoints?.length) {
    fail(`Our version details ${detailsUrl} answered HTTP ${details.status} (${details.contentType}); publish the site first.`);
  }
  console.log(`Our side: ${config.ourVersionsUrl} -> ${details.json.data.endpoints.map((e) => e.identifier).join(', ')} (${ours.contentType})`);

  // 4. Our credentials object. Token B is what ChargeNode would use to call us;
  //    our side is static JSON, so it only needs to exist.
  const tokenB = randomBytes(32).toString('hex');
  const credentials = {
    token: tokenB,
    url: config.ourVersionsUrl,
    roles: [{ role: config.ourRole, party_id: config.ourPartyId, country_code: config.ourCountryCode, business_details: { name: config.ourName } }],
  };
  console.log(`POST body: ${JSON.stringify({ ...credentials, token: mask(tokenB) })}`);
  if (config.dryRun) {
    console.log('\n--dry-run: stopping before the POST. Nothing was changed at ChargeNode.');
    return;
  }

  // 5. The one-shot registration.
  const res = await request(credentialsUrl, {
    method: 'POST',
    headers: {
      ...auth,
      'Content-Type': 'application/json',
      'OCPI-from-country-code': config.ourCountryCode,
      'OCPI-from-party-id': config.ourPartyId,
      'OCPI-to-country-code': theirRole.country_code,
      'OCPI-to-party-id': theirRole.party_id,
    },
    body: JSON.stringify(credentials),
  });
  const tokenC = res.json?.data?.token;
  const shownBody = tokenC ? res.text.split(tokenC).join(mask(tokenC)) : res.text;
  console.log(`\nPOST ${credentialsUrl} -> HTTP ${res.status}`);
  console.log(shownBody.slice(0, 2000));

  if (!tokenC) {
    const again = await request(config.versionsUrl, { headers: auth });
    fail(`No access token in the reply. The registration key ${again.status === 200 ? 'still works' : 'no longer works'} on the versions endpoint (HTTP ${again.status}). Send the reply above to ChargeNode.`);
  }

  // 6. Prove the new key on a data module.
  const locationsUrl = discovery.endpoints.locations;
  let working = null;
  for (const encoding of ['base64', 'plain']) {
    const check = await request(`${locationsUrl}?limit=1`, { headers: { Authorization: `Token ${encode(tokenC, encoding)}` } });
    console.log(`locations with the new key (${encoding}) -> HTTP ${check.status}`);
    if (check.status === 200) {
      working = encoding;
      break;
    }
  }
  const oldKey = await request(config.versionsUrl, { headers: auth });
  console.log(`versions with the old registration key -> HTTP ${oldKey.status}`);

  console.log('\n================ NEW OCPI ACCESS KEY (token C) ================');
  console.log(tokenC);
  console.log('===============================================================');
  console.log(working
    ? `It reads the data modules (${working} encoding). Store it as the SECRET_KEY repository secret and as OCPI_TOKEN in .env.`
    : 'It was issued but the locations module did not answer 200 with it; ask ChargeNode.');
  console.log('  gh secret set SECRET_KEY -R HuggeK/emmaboda-gk-ocpi-dashboard');
  console.log('  gh workflow run "Snapshot to GitHub Pages" -R HuggeK/emmaboda-gk-ocpi-dashboard');

  if (config.writeEnv) {
    writeEnvFile(typeof config.writeEnv === 'string' ? path.resolve(config.writeEnv) : path.join(ROOT, '.env'), tokenC);
  }
}

main().catch((err) => fail(`Handshake failed: ${err?.message || err}`));
