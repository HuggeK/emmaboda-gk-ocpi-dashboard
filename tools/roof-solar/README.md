# Roof solar

How many solar panels fit on the club's roofs, worked out from Lantmäteriet's
surface model (*Ytmodell från flygbilder*, 0.25 m, flown April 2026), with the
yield of each roof face from PVGIS. Tracked in the cost-lowering issue #26.

## 1. Get the height data (needs your Lantmäteriet login)

The height data is open data, but Lantmäteriet only lets logged-in users
download it (a free Geotorget account). The club's roofs are all in one file:

<https://dl1.lantmateriet.se/hojd/data/grid/yhm/2026_b2/y2026_b2-626_53_5050_dsm.tif>

Open the link in a browser, log in when asked, and save the file as
`C:\projects\Emmaboda GK\gis\y2026_b2-626_53_5050_dsm.tif` (outside the
repository; the file is large and the data is Lantmäteriet's). In QGIS the same
file is under *STAC → https://api.lantmateriet.se/stac-hojd/v1/ →
Ythöjdmodell → 2026_b2-626_53_5050*.

## 2. Run the analysis

With QGIS's Python, which has GDAL, NumPy and SciPy:

```powershell
& "C:\Program Files\QGIS 4.2.3\bin\python-qgis.bat" tools\roof-solar\roof_solar.py --dsm "C:\projects\Emmaboda GK\gis\y2026_b2-626_53_5050_dsm.tif"
```

It writes `tools/roof-solar/out/roofs.json` (git-ignored). The buildings and
their coordinates (SWEREF 99 TM) are at the top of `roof_solar.py`; the
coordinate must be on the roof.

## 3. Look at it

```powershell
node -e "require('http').createServer((q,s)=>require('fs').createReadStream('tools/roof-solar'+(q.url.split('?')[0]==='/'?'/index.html':q.url.split('?')[0])).on('error',()=>{s.statusCode=404;s.end()}).pipe(s)).listen(8765)"
```

Then open <http://127.0.0.1:8765/>.

## How it works

1. **Find the roof.** From the coordinate, grow across cells raised more than
   1.5 m above the ground that are smooth (height steps under 0.6 m, low local
   roughness). Tree crowns are rough and stop the growth.
2. **Roof faces.** Tilt and compass direction for every cell from the smoothed
   surface; cells are grouped into faces by direction (8 sectors, or flat
   below 8°). Patches under 4 m² are ignored.
3. **Panels.** 1.13 × 1.76 m (430 Wp) in portrait rows along each face, 0.5 m
   from its edges. Flat roofs get east–west racks at 10°.
4. **Yield.** PVGIS (EU JRC) for each face's tilt and direction. Faces under
   650 kWh/kWp a year (north-facing) are reported but get no panels.
5. **Value and payback** in the viewer: 1.25 kr per kWh used on site (from the
   simulation on the club's own load with 2027 grid prices), at
   8,000 / 10,000 / 12,000 kr per installed kWp.

A planning sketch, not an installer's drawing: chimneys, vents, skylights,
shading from nearby trees and the roof's load capacity are not included.

`make_test_dsm.py` makes a synthetic surface model with roofs of known shape
(gable roofs at 27° and 35°, a flat roof, a tree) for testing without
Lantmäteriet's data.
