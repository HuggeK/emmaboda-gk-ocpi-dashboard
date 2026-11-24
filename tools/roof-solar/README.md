# Roof solar

How many solar panels fit on the club's roofs, worked out from Lantmäteriet's
surface model (*Ytmodell från flygbilder*, 0.25 m, flown April 2026), with the
yield of each roof face from PVGIS. Tracked in the cost-lowering issue #26.

## 1. Get the data (needs your Lantmäteriet login)

Lantmäteriet's data is open, but downloads need a logged-in Geotorget account
with access to each product. Open each link in a browser, log in when asked,
and save the files in `C:\projects\Emmaboda GK\gis\` (outside the repository;
the files are large and the data is Lantmäteriet's).

**With *Laserdata Nedladdning, skog* and *Byggnad Nedladdning, vektor*** (the
club's account has these):

| File | What |
|---|---|
| [y26a018-62650_5350_25.copc.laz](https://dl1.lantmateriet.se/hojd/data/pointcloud/sls/26a018/y26a018-62650_5350_25.copc.laz) | Laser scan, April 2026 (0.5 points/m²) |
| [y19a018-62650_5350_25.copc.laz](https://dl1.lantmateriet.se/hojd/data/pointcloud/sls/19a018/y19a018-62650_5350_25.copc.laz) | Laser scan, April 2019 (0.67 points/m²): merged with 2026 for a denser cloud |
| [byggnad_kn0862.zip](https://dl1.lantmateriet.se/byggnadsverk/byggnad_kn0862.zip) | Building outlines, Emmaboda municipality: exact roof edges |
| [o62650_5350_25_mr26.tif](https://dl1.lantmateriet.se/bild/data/orto/se0_16m_sweref/2026_B2/o62650_5350_25_mr26.tif) | Orthophoto April 2026, 16 cm (optional, shown under the roofs) |

**With *Ytmodell från flygbilder*** (not ordered yet; free, sharper): the
0.25 m surface model
[y2026_b2-626_53_5050_dsm.tif](https://dl1.lantmateriet.se/hojd/data/grid/yhm/2026_b2/y2026_b2-626_53_5050_dsm.tif)
replaces the two laser files.

## 2. Run the analysis

With QGIS's Python (GDAL, NumPy, SciPy) and QGIS's PDAL for the laser data:

```powershell
$gis = "C:\Projects\Emmaboda GK\gis"
& "C:\Program Files\QGIS 4.2.3\bin\python-qgis.bat" tools\roof-solar\roof_solar.py `
    --laz "$gis\y26a018-62650_5350_25.copc.laz" "$gis\y19a018-62650_5350_25.copc.laz" `
    --buildings "$gis\byggnad_kn0862.zip" --ortho "$gis\o62650_5350_25_mr26.tif"
```

or, with the surface model, `--dsm "$gis\y2026_b2-626_53_5050_dsm.tif"` instead of `--laz`.
The laser files are read only around the club (PDAL reads just that part of
the 2.5 × 2.5 km tile) and turned into a 0.5 m surface model in `out/`.

It writes `tools/roof-solar/out/roofs.json` (git-ignored). The buildings and
their coordinates (SWEREF 99 TM) are at the top of `roof_solar.py`; the
coordinate must be on the roof.

## 3. Look at it

```powershell
node -e "require('http').createServer((q,s)=>require('fs').createReadStream('tools/roof-solar'+(q.url.split('?')[0]==='/'?'/index.html':q.url.split('?')[0])).on('error',()=>{s.statusCode=404;s.end()}).pipe(s)).listen(8765)"
```

Then open <http://127.0.0.1:8765/>.

## How it works

1. **Find the roof.** With building outlines: the outline that contains the
   coordinate. Without: grow from the coordinate across cells raised more than
   1.5 m above the ground that are smooth; tree crowns are rough and stop it.
   With outlines, every cell inside the outline is given to its nearest roof
   face, so sparse laser data does not shrink the roof.
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
(gable roofs at 27° and 35°, a flat roof, a tree), and `make_test_laser.py`
turns it into a sparse laser cloud (1.2 points/m², 5 cm noise) with building
outlines, for testing without Lantmäteriet's data. On that test the tool finds
the tilts within 1.3°, the roof areas within 5 % and 56 of the 57 panels that
fit on the 27° south face by hand calculation.
