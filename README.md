# Emmaboda GK charger dashboard

A small local web app that shows what the club's EV chargers are doing, using
the OCPI API that ChargeNode exposes for the chargers.

- **Live** - power in use right now versus installed capacity, which charging
  points are charging / available / out of service, ongoing sessions.
- **Records** - charge detail records (CDRs): sessions, kWh, cost, time plugged
  in, energy per day, per-charger breakdown, sortable table, CSV export.
- **Chargers** - the locations, charging points (EVSEs) and connectors ChargeNode
  publishes.
- **Connection** - exactly what the OCPI server answered, for troubleshooting.

Everything runs on your own computer. A tiny Node server keeps the OCPI token
out of the browser and proxies the OCPI calls (the OCPI server does not allow
browser calls directly). No packages are installed; only Node.js 22 or newer is
needed. A read-only copy is also published on GitHub Pages twice a week; see
[Published dashboard](#published-dashboard-github-pages).

## Quick start

```powershell
cd "C:\projects\Emmaboda GK\ocpi-dashboard"
copy .env.example .env      # then put the ChargeNode token in .env
npm start
```

Open <http://127.0.0.1:3000/>.

To try the UI without a working token:

```powershell
npm run demo
```

To test the token from the command line without starting the UI:

```powershell
npm run check
```

## Configuration (`.env`)

| Variable | Meaning |
|---|---|
| `OCPI_TOKEN` | The token ChargeNode issued. Never commit it. |
| `OCPI_VERSIONS_URL` | ChargeNode's versions endpoint. Default `https://ocpi.chargenode.eu/ocpi/cpo/versions`. |
| `OCPI_TOKEN_ENCODING` | `auto` (default) tries the plain token, then base64 as OCPI 2.2.1 prescribes. Can be pinned to `plain` or `base64`. |
| `OCPI_PREFERRED_VERSION` | Optional. Which OCPI version to pick when several are offered. Default order: 2.2.1, 2.2, 2.1.1. |
| `OCPI_FROM_COUNTRY_CODE`, `OCPI_FROM_PARTY_ID` | Optional. Sent as `OCPI-from-*` headers if ChargeNode requires them. |
| `PORT` | Local port. Default 3000. The server only listens on 127.0.0.1. |
| `OCPI_DEMO` | `1` to use generated demo data. Same as `--demo`. |

Command-line flags: `--demo`, `--check`, `--port 3001`, `--verbose` (logs every OCPI request).

## Published dashboard (GitHub Pages)

A read-only copy of the dashboard is published at
<https://huggek.github.io/emmaboda-gk-ocpi-dashboard/> by the GitHub Actions
workflow in `.github/workflows/snapshot-pages.yml`. Each run:

1. Calls ChargeNode with the OCPI key stored in the repository secret
   `SECRET_KEY`. The key expires after 7 days without use, so this is also
   what keeps it alive.
2. Builds the site with `scripts/build-snapshot.js`: a copy of `public/` plus
   `data/snapshot.json` holding locations, live status and the charge records
   of the last 400 days (so the "This year" range is always complete).
3. Deploys the result to GitHub Pages (Pages source: GitHub Actions).
4. Comments ✅ or ❌ on the tracking issue labelled `ocpi-key-heartbeat`
   (created on the first run and assigned to the repository owner), so every
   run arrives as a GitHub notification. GitHub also e-mails failed runs on
   its own.

The workflow runs Monday and Thursday at 05:17 UTC, on every push to `main`
that touches the app, and on demand from the Actions tab (*Snapshot to GitHub
Pages* → *Run workflow*). Two runs a week means one delayed or failed run does
not let the key lapse.

The site is public even though the repository is private, so the published
snapshot leaves out the fields that identify who charged (`token_uid` and
`contract_id`). Everything else is what the local app shows. In snapshot mode
the header says "Snapshot · x ago", the Live tab does not auto-refresh, and
the Records date ranges count back from the snapshot time instead of today.

If ChargeNode accepts the key on the versions endpoint but refuses the data
modules, the site is still published, without data, so the Connection tab can
say why; the run is then marked failed and the tracking issue gets a ⚠️
comment. `public/ocpi/` holds our minimal OCPI presence (versions, version
details and a credentials object as static JSON) so that ChargeNode has
something to reach during the credentials handshake that turns a registration
key into a real access key.

Things to know:

- GitHub can delay scheduled runs by minutes to hours when the platform is
  busy; the twice-weekly cadence absorbs that.
- Scheduled workflows in *public* repositories are switched off after 60 days
  without commits. This repository is private, so that rule does not apply
  today; if it is ever made public, watch for GitHub's "workflow disabled"
  e-mail.
- Only `main` may deploy to the `github-pages` environment, so the workflow
  cannot be tested from a branch; it runs for real once merged.

### Exchanging a registration key for the real key

A key from ChargeNode that opens `/versions` and `/credentials` but gets
HTTP 401 on every data module is an OCPI *registration* key ("token A"). It
must be exchanged once, through the OCPI credentials handshake, for the real
access key ("token C"). The handshake needs an OCPI versions endpoint on our
side that ChargeNode can fetch; that is the static JSON under `public/ocpi/`,
published with the site. So: make sure the site is deployed (the workflow does
it on every push to `main`), then run the handshake once, from this machine:

```powershell
npm run handshake -- --dry-run --token <registration key>   # checks both sides, changes nothing
npm run handshake -- --token <registration key> --write-env  # the real, one-shot exchange
```

The script prints the new key, proves it on the locations module, and with
`--write-env` puts it into `.env`. Then store it as the `SECRET_KEY` secret
(see below). After a successful exchange the registration key stops working,
so do not run it twice. Our side is registered as party `SE`/`EGK`, role
`EMSP`, name "Emmaboda GK" (override with `OCPI_OUR_*` environment variables).

### Rotating the key

When ChargeNode sends a new key, or a run reports HTTP 401:

```powershell
gh secret set SECRET_KEY -R HuggeK/emmaboda-gk-ocpi-dashboard   # paste the key when prompted
gh workflow run "Snapshot to GitHub Pages" -R HuggeK/emmaboda-gk-ocpi-dashboard
```

Put the new key in the local `.env` too if you use `npm start`.

### Building the static site locally

```powershell
npm run build          # real data with OCPI_TOKEN from .env -> dist/
npm run build:demo     # invented data, no token needed
python -m http.server 8080 -d dist   # then open http://127.0.0.1:8080/
```

`dist/` is git-ignored and is wiped on every build. Serve it over HTTP; opened
straight from disk the browser refuses to load `data/snapshot.json`.

## How it works

```
browser  ──►  http://127.0.0.1:3000  ──►  server/index.js  ──►  https://ocpi.chargenode.eu/ocpi/cpo/...
             (public/ static UI)         (token, cache, normalise)   (OCPI 2.2.1, Token auth)
```

1. On start the server calls the **versions** endpoint with the token, picks
   the newest OCPI version offered, reads the **version details** and learns the
   URLs of the `locations`, `sessions`, `cdrs` and `tariffs` modules.
2. `/api/live` combines **locations** (EVSE status and connector max power) with
   **sessions** updated in the last 24 h. If ChargeNode reports a `POWER`
   dimension in the latest charging period the number is measured; if it only
   reports `ENERGY` the average power over the latest period is derived;
   otherwise the connector's maximum is used and labelled as an estimate.
3. `/api/cdrs?date_from&date_to` fetches all pages of CDRs (following the `Link`
   header) and flattens OCPI 2.1.1 / 2.2 / 2.2.1 shapes into one format.
4. Responses are cached briefly (10-60 s) to be gentle on the OCPI server.

Local API routes: `/api/status`, `/api/live`, `/api/locations`,
`/api/sessions`, `/api/cdrs`, `/api/tariffs`. All are GET and return JSON.

## Troubleshooting

**"Not connected" / HTTP 401.** The versions endpoint is the first call in any
OCPI integration and it is protected by the token. A 401 with an empty body in
every encoding means ChargeNode's server does not recognise the token. Ask
ChargeNode whether the token is activated, whether it is bound to a whitelisted
IP, whether it is a one-time registration token (`CREDENTIALS_TOKEN_A`) that
must be exchanged via `POST /credentials` (that handshake needs a public OCPI
endpoint on our side, which this local app does not have, so a permanent token
is needed instead), or whether it was already consumed. The Connection tab lists
each request made and the status returned.

**Versions OK but every module answers HTTP 401.** The key opens `/versions`,
the version details and `/credentials`, yet `locations`, `sessions`, `cdrs` and
`tariffs` all return 401 in every token encoding and OCPI version. That is how
an OCPI registration token ("token A") behaves: it only allows the credentials
handshake (`POST /credentials`), after which the CPO issues the real access
token. The handshake requires ChargeNode to call back an OCPI versions endpoint
on our side, which neither the local app nor the static site provides. Ask
ChargeNode for a key with direct read access to the CPO modules, or to register
our side with a fixed token. The scheduled workflow reports this case as
"⚠️ Key accepted, but ChargeNode refused the data modules".

**Reproduce by hand** (PowerShell):

```powershell
curl.exe -i -H "Authorization: Token <token>" https://ocpi.chargenode.eu/ocpi/cpo/versions
```

**Power looks like a round number (est.).** ChargeNode did not include a `POWER`
dimension for that session, so the connector maximum is shown as an estimate.

**CSV opens in one column.** The export uses `;` as separator with a UTF-8 BOM,
which Excel with Swedish regional settings opens directly. Other tools may need
the separator set to semicolon.

## Project layout

```
server/index.js        HTTP server, static files, /api routes, caching
server/ocpi-client.js  Token auth, version discovery, pagination
server/normalize.js    OCPI 2.1.1 / 2.2 / 2.2.1 payloads -> one flat shape
server/live.js         "Right now" calculation from locations + sessions
server/snapshot.js     One JSON snapshot of everything the UI shows (static site)
server/demo-data.js    Deterministic demo data (OCPI 2.2.1 shaped)
public/                index.html, styles.css, app.js (no build step)
public/ocpi/           Static OCPI versions / credentials JSON for the handshake
scripts/build-snapshot.js             public/ + data/snapshot.json -> dist/
scripts/ocpi-handshake.js             Exchanges a registration key for the real key
.github/workflows/snapshot-pages.yml  Twice-weekly fetch, deploy and report
.github/scripts/report-run.cjs        Comments each run's outcome on the tracking issue
```
