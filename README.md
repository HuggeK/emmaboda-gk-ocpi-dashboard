# Emmaboda GK charger dashboard

A small local web app that shows what the club's EV chargers are doing, using
the OCPI API that ChargeNode exposes for the chargers.

- **Overview** (first page) - this month's peak so far, the effektavgift this
  year and the chargers' part of it, the limit in force, and the billed peak
  per month.
- **Meter** - the whole facility's measured hourly power from E.ON's grid
  meter, split into the chargers' (estimated) part and everything else, the
  limits in force, when the peaks happen and which loads probably cause them
  (`public/facility.js`), monthly billed peaks, and a cost breakdown worked out
  from the meter values, with the energy priced per quarter hour at the SE4
  spot price. See [Grid meter (E.ON)](#grid-meter-eon).
- **Analysis** - how often several chargers run at once, the busy hours
  (weekday × hour heatmap) and an estimate of the effektavgift the chargers
  alone would cause, computed from the charge records.
- **Economics** - what the chargers earn and cost, the break-even price, whether
  the winter ceiling or a night stop pays, what can be negotiated in the
  electricity contracts (from E.ON's cost export, `public/contracts.js`, with
  E.ON Elnät's 2027 prices), including E.ON's surcharge worked out from the
  bill and the quarter-hour spot prices.
- **Solar** - would solar panels pay? The club's roofs in 3D from
  Lantmäteriet's laser scans with the panels that fit and the sun's path, what
  each roof would save (simulated per quarter hour on the club's own
  consumption), the roof work for the board (the barn's asbestos roof, the old
  office's split roof) and a collapsible section for installers. See
  [Solar tab](#solar-tab).
- **Chargers** - three sub-tabs: *Live* (power in use right now, which charging
  points are charging / available / out of service), *Records* (charge detail
  records: sessions, kWh, cost, time plugged in, energy per day, per-charger
  breakdown, CSV export) and *Charging points* (the locations, EVSEs and
  connectors ChargeNode publishes).
- **Connection** - exactly what the OCPI server and E.ON answered, for troubleshooting.
- **Så funkar det** - a plain-language explanation in Swedish for club members:
  where the numbers come from, why one hour can set the month's effektavgift,
  and what the limits mean, with diagrams.

Everything runs on your own computer. A tiny Node server keeps the OCPI token
out of the browser and proxies the OCPI calls (the OCPI server does not allow
browser calls directly). No packages are installed; only Node.js 22 or newer is
needed. A read-only copy is also published on GitHub Pages every hour; see
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
   `data/snapshot.json` holding locations, live status and every charge
   record since the chargers went live (June 2024). To spare ChargeNode's
   servers, a run first downloads the previously published snapshot and asks
   ChargeNode only for the records changed since it was built (two days of
   overlap catches late corrections), so an hourly run makes about five
   requests. The 03:xx UTC run and manual runs refetch everything.
3. Deploys the result to GitHub Pages (Pages source: GitHub Actions).
4. Tracks the outcome on the issue labelled `ocpi-key-heartbeat` (created on
   the first run and assigned to the repository owner). The status line in
   the issue body is rewritten on every run without notifying anyone; a
   comment, which does notify, is posted when the outcome changes and once a
   day while runs keep failing. GitHub also e-mails failed runs on its own,
   which can be switched off under Settings → Notifications → Actions.

The workflow runs every hour (at :17), on every push to `main` that touches
the app, and on demand from the Actions tab (*Snapshot to GitHub Pages* →
*Run workflow*). The repository is public, so GitHub-hosted runners cost
nothing (a private repository would use about 720 of the account's 3,000
Actions minutes a month), and the OCPI specification's advice to pull lists
"in hours, not minutes" is respected. Change the `cron`
line to adjust; `17 6-20 * * *` would limit it to daytime.

The site and the repository are public, so the published snapshot leaves out the fields that identify who charged (`token_uid` and
`contract_id`). Everything else is what the local app shows. In snapshot mode
the header says "Snapshot · x ago", the Live tab does not auto-refresh, and
the Records date ranges count back from the snapshot time instead of today.

If ChargeNode accepts the key on the versions endpoint but refuses the data
modules, the site is still published, without data, so the Connection tab can
say why; the run is then marked failed and the tracking issue shows ⚠️.
`public/ocpi/` holds our minimal OCPI presence (versions, version
details and a credentials object as static JSON) so that ChargeNode has
something to reach during the credentials handshake that turns a registration
key into a real access key.

Things to know:

- GitHub can delay scheduled runs by minutes to hours when the platform is
  busy, so an hourly run may land late or be skipped now and then.
- Since 23 Nov 2026 GitHub's artifact list sometimes lags the upload, and
  `deploy-pages` then reports "No artifacts named github-pages were found"
  although the upload succeeded. The workflow waits 10 s before deploying and
  retries once after 30 s.
- Scheduled workflows in public repositories are switched off after 60 days
  without activity. To keep the hourly job and the yearly reminder running
  through quiet months, the 03:xx UTC run re-enables both through GitHub's API,
  which resets that timer. If GitHub still sends a "workflow disabled" e-mail,
  enable it again under Actions and run it once.
- Only `main` may deploy to the `github-pages` environment, so the workflow
  cannot be tested from a branch; it runs for real once merged.
- GitHub Pages serves every file with a 10-minute cache. The build stamps the
  script and stylesheet URLs with a build id so a new deploy never pairs a
  fresh page with stale scripts, but a browser that loaded the page within the
  last 10 minutes may still show the old version until a hard refresh
  (Ctrl+F5, or reload twice on a phone).

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
npm run handshake -- --token <registration key>             # the real, one-shot exchange
```

The script prints the new key and proves it on the locations module. Store it
as the `SECRET_KEY` secret (see below); keep it out of files on disk
(`--write-env` exists but writes it into `.env`, which is not recommended).
After a successful exchange the registration key stops working, so do not run
it twice. Our side is registered as party `SE`/`EGK`, role `EMSP`, name
"Emmaboda GK" (override with `OCPI_OUR_*` environment variables).

### Rotating the key

When ChargeNode sends a new key, or a run reports HTTP 401:

```powershell
gh secret set SECRET_KEY -R HuggeK/emmaboda-gk-ocpi-dashboard   # paste the key when prompted
gh workflow run "Snapshot to GitHub Pages" -R HuggeK/emmaboda-gk-ocpi-dashboard
```

For the local app, pass the key through the environment instead of writing it
into `.env`:

```powershell
$env:OCPI_TOKEN = '<key>'; npm start
```

### Building the static site locally

```powershell
npm run build          # real data with OCPI_TOKEN from .env -> dist/ (full history)
npm run build:demo     # invented data, no token needed
python -m http.server 8080 -d dist   # then open http://127.0.0.1:8080/
```

`npm run build -- --base-url https://huggek.github.io/emmaboda-gk-ocpi-dashboard/data/snapshot.json`
extends the published snapshot the way the workflow does; `--full` forces a
complete refetch and `--history-from 2025-01-01` limits a full fetch.

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

Local API routes: `/api/status`, `/api/live`, `/api/locations`, `/api/eon`,
`/api/sessions`, `/api/cdrs`, `/api/tariffs`. All are GET and return JSON.

## Analysis tab

The Analysis tab works from the same charge records as the Records tab. What
it shows and how it is computed:

- **Simultaneous sessions.** Plugged-in overlap comes straight from the
  records' start and end times. "Charging" is an estimate, because ChargeNode
  reports one energy total per session and no power curve: each car is assumed
  to charge at a fixed rate (default 11 kW) from plug-in until its energy is
  delivered, then idle. "Spread evenly" instead spreads the energy over the
  whole plugged-in time, which is a floor.
- **Busy hours.** Average estimated charger power per weekday and clock hour
  over the chosen range, as a heatmap with a table view.
- **Monthly peaks and effektavgift.** The highest hourly average per month,
  capped at ChargeNode's group limit (default 43.5 kW, the 63 A setting),
  multiplied by the tariff (default 120 kr/kW) gives what the chargers alone
  would cost in effektavgift. Hours are clock hours, which is how grid
  companies bill.
- **Revenue and coverage.** Next to each month's peak: the charging revenue
  earned in that peak hour, the revenue of the whole month, and whether the
  month's revenue covered the effektavgift. Revenue is the charged amount
  incl. VAT from the records, before any ChargeNode fee; an hour's share
  follows the energy delivered in it under the model.
- **"Car charges at"** is the power one car is assumed to draw while it is
  actually charging (11 kW for a three-phase 16 A car, 7.4 kW single-phase,
  22 kW three-phase 32 A). It decides how long each session's energy took to
  deliver, and therefore how much overlaps in any hour.

Everything on the tab is **chargers only**. The real effektavgift is billed
on the whole facility's highest hourly average, so the club's other loads
in the same hours are missing; the Meter tab has the measured values. Hours are
capped at the limit in force at the time (see [Limits](#limits)).

## Grid meter (E.ON)

ChargeNode reports energy per charging session, not power, so the chargers'
power per hour is a model. The grid company measures the real thing: E.ON's
**Energidata API** (<https://navigator-api.eon.se>, bought as the
*mätvärden* subscription) gives the facility's energy per hour and per quarter
hour. Energy in one hour (kWh) is the hour's average power (kW), which is
exactly what the effektavgift is billed on.

**Credentials.** OAuth2 client credentials: the client id and secret from the
Navigator portal are exchanged at `/connect/token` (scope `navigator`) for a
bearer token. They are stored as repository secrets and passed to the build:

```powershell
gh secret set CLIENTID -R HuggeK/emmaboda-gk-ocpi-dashboard       # paste the client id
gh secret set CLIENTSECRET -R HuggeK/emmaboda-gk-ocpi-dashboard   # paste the client secret
gh workflow run "Snapshot to GitHub Pages" -R HuggeK/emmaboda-gk-ocpi-dashboard
```

The workflow maps them to `EON_CLIENT_ID` / `EON_CLIENT_SECRET`. For the local
app, pass them through the environment, not `.env`:

```powershell
$env:EON_CLIENT_ID = '<client id>'; $env:EON_CLIENT_SECRET = '<client secret>'; npm start
```

Optional: `EON_HISTORY_FROM` (default `2024-01-01`; E.ON keeps the current year
plus five back), `EON_SERIES_ID` / `EON_INSTALLATION_ID` to pin a series or
installation when the automatic choice (active-energy consumption in kWh) is
wrong. The Connection tab lists the installations and series E.ON offers.

**What each run fetches.** Hourly and quarter-hour values since
`EON_HISTORY_FROM` (in chunks under E.ON's limits of one year and three months).
Both are kept: the effektavgift is billed on the hourly mean, while the
electricity contract (P15M) and, from 2027, the grid energy fee are priced per
quarter hour. Chunks E.ON refuses, such as quarter hours from before the meter
was read every 15 minutes, are skipped. Like the charge records, a run extends
the previously published snapshot and only asks for the last three days again,
so an hourly run makes about four requests; a range the snapshot is missing
(e.g. older quarter hours) is fetched once. E.ON publishes values about a day late. An E.ON failure
never fails the run: the previous values are kept, the Meter tab says why, and
the tracking issue's status line shows `meter ❌`.

**Timestamps.** E.ON writes Swedish local time without an offset, and for
hour and quarter values the stamp is the *end* of the interval. The night the
clocks go back the repeated hour is marked `.01` (`02:00.01` is the second
02:00); `server/eon.js` turns all of it into UTC interval starts, and the tests
cover both DST nights.

**Privacy.** The published site is public. It carries the installation's
name, city, grid and price area and the hourly values, but not the
anläggnings-id (only a short hash of it) nor the organisation number.

**How the Meter tab computes.**

- *Chargers' part of an hour*: the charge-record model from the Analysis tab,
  never more than the meter measured. *Everything else* = measured − chargers.
- *Billed peak*: the month's highest hour, or the average of the 2/3/5 highest
  hours on different days (*Billed on*; check the E.ON Elnät tariff).
- *Cost*: energy priced per quarter hour, + billed peak × kr/kW + fixed fee,
  plus VAT. Each quarter's measured kWh is priced at that quarter's SE4 spot
  price plus the contract surcharge (the club's contract is quarter-hour spot,
  P15M); the grid energy fee is flat until 2026 and from 2027 6.40 öre + 12.1 %
  of the quarter's spot; energy tax per kWh. The defaults are fitted to E.ON's
  bill (surcharge 8.0 öre: the bill's contract cost minus the spot price of
  the quarters actually used); they can be changed and are saved in the
  browser. Hours without a spot price use the flat price. The effektavgift
  stays on the hourly mean, as E.ON bills it.
- *Spot prices*: SE4 day-ahead prices per quarter hour from
  [elprisetjustnu.se](https://www.elprisetjustnu.se/elpris-api) (one price per
  hour before 1 Oct 2025, stored as four equal quarters), fetched by the build
  into `snapshot.spot` and extended run by run: only the last two days and
  tomorrow are asked for. A failure keeps the previous prices.
- *Chargers' share*: what the club would not have paid without them: their
  kWh at the per-kWh prices plus the drop in effektavgift if their part of every
  hour were removed (billed peak with them − billed peak without them),
  compared with the charging revenue.

## Economics tab

Per year and for the last 12 full months: charging revenue (excl. VAT), the
electricity it took (each month's kWh at what the energy cost in the hours the
cars charged, from the Meter tab's quarter-hour pricing; the flat tariff
without meter values), ChargeNode's fee, this system's cost, and the effektavgift the
chargers added. That last one is measured from the E.ON values where they
exist (billed peak with the chargers − billed peak without them); without
them it is a range from nothing to the worst case (the chargers' own monthly
peak always on top of the club's). From that it gives the break-even price
per kWh and a verdict on the current price, and with meter values a table of
what lowering the limits saved (the chargers' unlimited estimate on top of
the measured rest of the club, minus the actual peak). *Is the winter ceiling
worth the e-mail?* checks every past winter (26 Oct – 28 Feb): the
effektavgift the chargers would add without the 25 kW whole-facility ceiling,
minus what they add with it, against the margin on the charging the ceiling
holds back (an upper bound, since held-back charging is often only delayed),
and compares 20, 25, 30 and 35 kW for the last winter.

*What can be negotiated* splits E.ON's bill into its parts. Priced quarter by
quarter on the meter values, the contract's spot part was 80.4 öre/kWh in Jul
2025 – Jun 2026, so E.ON's surcharge, fees and certificates came to about
8.0 öre/kWh: the number to compare other retailers' offers with. The 2027 grid
energy fee uses the spot price the club actually paid.

Costs are set on the tab and saved in the browser. ChargeNode charges the club
60 kr per outlet (uttag) per month, i.e. 4,320 kr a year for six. The
E.ON meter values (19 kr/month) count from November 2026, when they were
bought; the 49 kr/month cost breakdown is 0 unless bought. GitHub costs
nothing within the plan.

Reference figures used for defaults and the market band:

- Energy tax 2026: 36.0 öre/kWh excl. VAT (43.9 in 2025) —
  [Skatteverket](https://www.skatteverket.se/foretag/skatterochavdrag/punktskatter/energiskatter/skattpael).
- SE4 spot price 2025: about 84 öre/kWh incl. VAT (≈ 67 excl.) —
  [boio.se](https://boio.se/el/elpris-historik/2025); the default 80 öre adds the retailer's surcharge.
- Public AC charging 2026: Mer's plans 3.75–4.98 kr/kWh, Recharge and OKQ8
  5.49 kr/kWh — [Realtid](https://www.realtid.se/efter-chockhojningen-i-hostas-nu-sanker-laddjatten-priserna/),
  [hurbra.se](https://hurbra.se/vad-kostar-det-att-ladda-en-elbil/).

## Solar tab

Would solar panels pay? Everything on the tab comes from data files built
by [`tools/roof-solar`](tools/roof-solar/README.md):

- `public/data/solar-site.json`: the golf course around the buildings, from
  OpenStreetMap (© OpenStreetMap contributors, ODbL, via golfTiles), drawn
  under the 3D model so people can find their way, and the glare runs from
  `walkzone.mjs` and `glare.mjs`: where and when the panels' reflection reaches
  golfers' view of the pin, with the high season (June–August) weighted most.
  The feeder cables and the camping buildings are in `public/contracts.js`
  (`FEEDERS`, from the club's energy analysis, and `CAMPING_SITES`).

- `public/data/solar-roofs.json`: the roofs and the panels that fit, from
  Lantmäteriet's laser scans (2019 and 2026 merged) and building outlines.
  Each roof face's pitch and direction is measured. Panels are kept 0.5 m from
  the edges, off bulges in the roof (patches standing 0.5 m out of the roof
  plane), and away from obstacles placed by hand from the aerial photo (the
  chimney on the office building). The golf carts' lean-to on the old office is
  described by hand, because the laser data is too sparse to measure it: its
  15° pitch is an assumption to check on site. No aerial photo or raw
  Lantmäteriet data is published.
- `public/data/solar-effekt.json`: what each roof and combination saves, from
  `tools/roof-solar/simulate.mjs`. It runs per quarter hour: the club's
  measured quarter-hour consumption, each roof face's output from PVGIS (five
  weather years, checked against SMHI STRÅNG for the actual weather), SE4
  quarter-hour spot prices with the contract surcharge, and E.ON Elnät's 2027
  prices. The effektavgift is worked out on the hourly mean bought, as E.ON
  bills it.

On the tab:

- **The verdict and a 3D model** (three.js, loaded only on this tab) with the
  panels on rails, the sun's path on 21 Jun, the equinoxes and 21 Dec, and a
  day/time control that moves the sun and the shadows.
- **Per building and per roof:** panels, kWp, yield, and the effektavgift and
  energy saved, with the range over the weather years and the result in the
  actual weather.
- **Roof work first:** the barn's eternit roof has asbestos and must be
  replaced, and the old office's roof is split. Both are costs the club takes
  anyway; the card shows how far the panels' savings go towards them, and the
  feeder cable to the old office (the trench is already dug).
- **What size pays best** for generic east/west roofs, and what the price per
  kWp covers: a turnkey system incl. inverter and installation (8,000–12,000
  kr/kWp excl. VAT, an assumption until quotes arrive), not a later inverter
  swap, roof work, the cable, service or insurance.
- **For installers** (collapsed): each building's position (WGS 84 with a map
  link, and SWEREF 99 TM), every roof face's direction, pitch, area and panels,
  the grid connection (E.ON Elnät, tariff E4N04L, 400 V, 125 A main fuse, SE4,
  the 43.5 kW export limit), what to price, and CSV downloads of the roof faces
  and of the measured consumption per quarter hour over the last 12 months.

The figures are estimates and simulations: take them with a grain of salt and
check them against invoices, quotes and a site visit. To update them after
new laser data or a changed roof, run `roof_solar.py` with `--publish` and then
`simulate.mjs` (see the tool's README).

## Limits

The numbers depend on the limits ChargeNode's load balancing has been set to.
They are listed in `LIMIT_HISTORY` in `public/analysis.js`, drawn in the charts
(dashed: a limit on the chargers; dotted: a ceiling on the whole facility) and
shown per month in the tables:

| From | Limit | Meaning |
|---|---|---|
| (start) | chargers ≤ about 57 kW | approximate setting before July 2026 |
| 17 Jul 2026 | chargers ≤ 63 A (43.5 kW) | the chargers together; the rest of the club is not counted |
| 2 Nov 2026 | whole facility ≤ 36 A (≈ 25 kW) | dynamic: the chargers only get what the rest of the club leaves under 25 kW; no charging if ChargeNode's meter fails |
| every year from 1 Mar | chargers ≤ 63 A (43.5 kW) | yearly plan: full charging for the golf season |
| every year from 26 Oct | whole facility ≤ 36 A (≈ 25 kW) | yearly plan: the chargers only use the room left in winter |
| always | main fuse 125 A ≈ 86.6 kW | the most the facility can draw |

**Yearly plan.** After the last confirmed setting the dashboard assumes the
plan in `SEASON_PLAN`: the club e-mails ChargeNode to lower the limit on
26 October and raise it again on 1 March. The workflow
`.github/workflows/season-reminder.yml` opens an issue on 12 October and
15 February (assigned to the owner, label `chargenode-season`) with the e-mail
ready to send; it can also be run by hand (Actions → *Season reminder*). If
ChargeNode switches on another date, add that date as a row to `LIMIT_HISTORY`.

The *Limits* control also offers a what-if (other values on the plan's
dates: a charger limit in season, a facility ceiling in winter) and *None*.

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
server/eon-client.js   E.ON Energidata API: OAuth2 client credentials, retries
server/eon.js          Meter values: Swedish time stamps -> UTC, series choice, incremental fetch
server/eon-demo.js     Invented meter values in E.ON's format, for demo mode
server/spot.js         SE4 spot prices per quarter hour (elprisetjustnu.se), incremental
tools/roof-solar/      Roofs from Lantmäteriet's laser data; simulate.mjs: solar per quarter hour (PVGIS, SMHI STRÅNG)
public/meter.js        Meter maths: chargers vs. the rest, billed peaks, quarter-hour cost breakdown
public/solar3d.js      The Solar tab's 3D model: roofs, panels, sun paths (three.js)
public/contracts.js    The bill, E.ON Elnät's 2027 prices, solar sizes, roof work and the feeder cable
public/data/           solar-roofs.json and solar-effekt.json for the Solar tab (from tools/roof-solar)
public/economics.js    Accounts, break-even price, what the limits saved
server/demo-data.js    Deterministic demo data (OCPI 2.2.1 shaped)
public/                index.html, styles.css, app.js (no build step)
public/analysis.js     Concurrency, hourly profile and monthly peak maths (pure functions)
public/ocpi/           Static OCPI versions / credentials JSON for the handshake
scripts/build-snapshot.js             public/ + data/snapshot.json -> dist/
scripts/ocpi-handshake.js             Exchanges a registration key for the real key
.github/workflows/snapshot-pages.yml  Hourly fetch (ChargeNode + E.ON), deploy and report
.github/scripts/report-run.cjs        Comments each run's outcome on the tracking issue
.github/workflows/season-reminder.yml Yearly reminders to e-mail ChargeNode (26 Oct, 1 Mar)
```

## License

[Mozilla Public License 2.0](LICENSE) (MPL-2.0).

- **You may** use, copy and change this code, also in commercial and closed
  products, and combine it with code under other licenses.
- **You must** make the source code of the files from this project, with
  your changes, available under MPL-2.0 to everyone you give the program to.
  New files of your own can stay under your own license.
- Please send improvements back to the project as a pull request. The
  license requires the changed source to be available to those you
  distribute to; a pull request is the easiest way to do that and keeps
  everyone on the same version.

The license applies per file ("file-level copyleft"), which is why it fits a
dashboard that others may want to build into their own products. Like GPL, it
only applies when the program is handed out: running a changed copy on your
own server, without distributing it, does not oblige you to share the changes.
