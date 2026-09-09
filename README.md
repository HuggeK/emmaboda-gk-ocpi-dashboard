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
needed.

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
server/demo-data.js    Deterministic demo data (OCPI 2.2.1 shaped)
public/                index.html, styles.css, app.js (no build step)
```
