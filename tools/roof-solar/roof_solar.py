"""How many solar panels fit on the club's roofs, from Lantmäteriet's surface
model (Ytmodell från flygbilder, 0.25 m, SWEREF 99 TM + RH 2000).

Run with QGIS's Python (it has GDAL, NumPy and SciPy):

    "C:\\Program Files\\QGIS 4.2.3\\bin\\python-qgis.bat" tools\\roof-solar\\roof_solar.py ^
        --dsm "C:\\projects\\Emmaboda GK\\gis\\y2026_b2-626_53_5050_dsm.tif"

For each building it starts at the given coordinate, grows across the
smooth raised surface (the roof; trees are rough and stop it), splits the roof
into faces by tilt and direction, lays out panels 0.5 m in from the edges,
asks PVGIS for the yield of each face's tilt and direction, and writes
tools/roof-solar/out/roofs.json for the viewer (index.html).
"""
import argparse
import base64
import json
import math
import os
import sys
import urllib.request
from collections import deque

import numpy as np
from osgeo import gdal
from scipy import ndimage

gdal.UseExceptions()

# The club's buildings (SWEREF 99 TM). The coordinate must be on the roof.
# "obstacles": things on the roof too small for the laser data (a chimney is
# under 1 m² at about 1.2 points/m²), placed from the aerial photo: no panel
# comes within r_m of the point.
BUILDINGS = [
    {"key": "kansli", "name": "Office building (kanslibyggnaden)", "e": 536483, "n": 6265521, "roof": "Sheet metal, unusual shape; a chimney on the west roof",
     "obstacles": [{"e": 536482.0, "n": 6265524.3, "r_m": 0.7, "what": "chimney on the west roof (from the aerial photo, about ±1 m)"}]},
    {"key": "studio", "name": "Studio", "e": 536475, "n": 6265508, "roof": "Sloping, not flat: about 13° to the north (laser data)"},
    # The old office has a lower-pitched lean-to (the golf carts' extension)
    # along its north side, against the steeper main roof. The laser data is
    # too sparse to separate the two, so the lean-to is described: its depth
    # from the aerial photo, its pitch assumed until measured on site.
    {"key": "gamla", "name": "Old office (gamla kansliet)", "e": 536501, "n": 6265557, "roof": "Split roof: the ridge beam and the roof must be fixed before any panels; the golf carts' lean-to along the north side",
     "lean_tos": [{"side": "N", "depth_m": 2.5, "tilt": 15, "what": "the golf carts' lean-to (depth from the aerial photo, 15° pitch assumed)"}]},
    {"key": "ladan", "name": "Barn (ladan)", "e": 536482, "n": 6265589, "roof": "Eternit with asbestos: the roof must be replaced (asbestos removal, new roof) before any panels"},
    {"key": "restaurang", "name": "Restaurant", "e": 536516, "n": 6265488, "roof": "Kitchen, cold rooms and heat pump underneath: high daytime use"},
    # The camping, about 800 m south, on its own feeder (N1XV 4×240, ~800 m to
    # the meter cabinet): laser tile 62625_5350 besides 62650_5350.
    {"key": "scout", "name": "Scout cabin (scoutstugan)", "e": 536280, "n": 6264722, "roof": "Sheet metal: panels clamp straight on. In a forest clearing (shade); behind the camping feeder"},
    {"key": "cabin1", "name": "Cabin, north (stuga)", "e": 536316, "n": 6264791, "roof": "Tiles, built 2010: hooks through the tiles; behind the camping feeder"},
    {"key": "cabin2", "name": "Cabin, middle (stuga)", "e": 536315, "n": 6264775, "roof": "Tiles, built 2010: hooks through the tiles; behind the camping feeder"},
    {"key": "cabin3", "name": "Cabin, south (stuga)", "e": 536315, "n": 6264757, "roof": "Tiles, built 2010: hooks through the tiles; behind the camping feeder"},
]

PANEL_W = 1.134  # m, along the roof's contour (portrait)
PANEL_H = 1.762  # m, up the slope
PANEL_WP = 430  # W per panel
SETBACK = 0.5  # m from roof edges
BUMP_TOL = 0.5  # m off the roof face's plane: a dormer, bulge or chimney there gets no panels
BUMP_MIN_M2 = 2.0  # ...when the cells off the plane form a patch at least this big (smaller ones are laser noise)
# Tuned on the club's roofs (about 1.2 laser points/m²): 0.5 m / 2 m² finds the
# bulge on the office building's east roof and nothing else; 0.3 m also marks
# laser noise on the barn and the office building.
FLAT_TILT = 10  # deg, east–west racks on flat roofs
FLAT_LIMIT = 8  # deg: flatter than this is a flat roof
MIN_YIELD = 650  # kWh per kWp and year: below this (north faces) no panels are placed
WINDOW = 80.0  # m, square analysed around each building
LAT, LON = 56.53, 15.58  # Vissefjärda, for PVGIS


def read_window(ds, e, n, size):
    gt = ds.GetGeoTransform()
    px = gt[1]
    x0 = int((e - size / 2 - gt[0]) / px)
    y0 = int((gt[3] - (n + size / 2)) / px)
    w = h = int(size / px)
    x0 = max(0, min(x0, ds.RasterXSize - w))
    y0 = max(0, min(y0, ds.RasterYSize - h))
    band = ds.GetRasterBand(1)
    z = band.ReadAsArray(x0, y0, w, h).astype("float64")
    nodata = band.GetNoDataValue()
    if nodata is not None:
        z[z == nodata] = np.nan
    origin = (gt[0] + x0 * px, gt[3] - y0 * px)  # top-left corner, SWEREF
    return z, px, origin


def laser_to_dsm(laz_files, out_tif, bounds, px=0.5):
    """A surface model from Lantmäteriet's laser point clouds (COPC/LAZ) with
    QGIS's PDAL: the highest point per cell, gaps filled from neighbours, noise
    (class 7) left out. Several flights are merged for a denser cloud."""
    import subprocess
    import tempfile
    xmin, xmax, ymin, ymax = bounds
    region = f"([{xmin},{xmax}],[{ymin},{ymax}])"
    stages = [{"type": "readers.copc" if f.lower().endswith(".copc.laz") else "readers.las", "filename": f, **({"bounds": region} if f.lower().endswith(".copc.laz") else {})} for f in laz_files]
    if len(laz_files) > 1:
        stages.append({"type": "filters.merge"})
    stages += [
        {"type": "filters.crop", "bounds": region},
        {"type": "filters.range", "limits": "Classification![7:7]"},
        {"type": "writers.gdal", "filename": out_tif, "resolution": px, "output_type": "max", "window_size": 3,
         "data_type": "float32", "nodata": -9999, "bounds": region, "gdaldriver": "GTiff"},
    ]
    pdal = os.path.join(os.path.dirname(sys.executable), "pdal.exe")
    if not os.path.exists(pdal):
        pdal = "pdal"
    with tempfile.NamedTemporaryFile("w", suffix=".json", delete=False) as fh:
        json.dump({"pipeline": stages}, fh)
        pipeline = fh.name
    subprocess.run([pdal, "pipeline", pipeline], check=True)
    os.unlink(pipeline)
    return out_tif


def footprint_mask(buildings_path, e, n, origin, px, shape):
    """The building outline from Lantmäteriet's Byggnad data that contains the
    point, rasterised onto the window; None if no outline contains it."""
    from osgeo import ogr
    path = buildings_path
    if path.lower().endswith(".zip"):
        inner = [f for f in gdal.ReadDir(f"/vsizip/{path}") or [] if f.lower().endswith(".gpkg")]
        if not inner:
            return None
        path = f"/vsizip/{path}/{inner[0]}"
    ds = ogr.Open(path)
    point = ogr.CreateGeometryFromWkt(f"POINT ({e} {n})")
    for i in range(ds.GetLayerCount()):
        layer = ds.GetLayerByIndex(i)
        if layer.GetGeomType() not in (ogr.wkbPolygon, ogr.wkbMultiPolygon, ogr.wkbPolygon25D, ogr.wkbMultiPolygon25D, ogr.wkbMultiSurface, ogr.wkbCurvePolygon):
            continue
        layer.SetSpatialFilterRect(e - 1, n - 1, e + 1, n + 1)
        for feat in layer:
            geom = feat.GetGeometryRef()
            if geom is not None and geom.Contains(point):
                mem = gdal.GetDriverByName("MEM").Create("", shape[1], shape[0], 1, gdal.GDT_Byte)
                mem.SetGeoTransform((origin[0], px, 0, origin[1], 0, -px))
                drv = ogr.GetDriverByName("MEM") or ogr.GetDriverByName("Memory")
                mds = drv.CreateDataSource("m")  # keep a reference: the layer dies with it
                mlayer = mds.CreateLayer("b")
                f2 = ogr.Feature(mlayer.GetLayerDefn())
                f2.SetGeometry(geom.Clone())
                mlayer.CreateFeature(f2)
                gdal.RasterizeLayer(mem, [1], mlayer, burn_values=[1])
                return mem.GetRasterBand(1).ReadAsArray().astype(bool)
    return None


def ortho_png(ortho_path, origin, px, shape, scale=2):
    """The aerial photo under the window, as a PNG data URL."""
    xmin, ymax = origin
    xmax, ymin = xmin + shape[1] * px, ymax - shape[0] * px
    out = gdal.Translate("/vsimem/ortho.tif", ortho_path, projWin=[xmin, ymax, xmax, ymin], width=shape[1] * scale, height=shape[0] * scale, bandList=[1, 2, 3])
    rgb = np.dstack([out.GetRasterBand(i).ReadAsArray() for i in (1, 2, 3)]).astype(np.uint8)
    out = None
    gdal.Unlink("/vsimem/ortho.tif")
    return png_b64(rgb)


def grow_roof(z, px, seed_rc, min_above=1.5, max_step=None):
    """Cells connected to the seed over a smooth surface raised above the ground."""
    max_step = max_step or max(0.6, 1.2 * px)  # coarser cells allow bigger steps on steep roofs
    ground = np.nanpercentile(z, 5)
    above = z - ground
    rows, cols = z.shape
    r0, c0 = seed_rc
    if not (above[r0, c0] > min_above):
        # The point missed the roof slightly: take the nearest raised cell within 5 m.
        rad = int(5 / px)
        best = None
        for r in range(max(0, r0 - rad), min(rows, r0 + rad + 1)):
            for c in range(max(0, c0 - rad), min(cols, c0 + rad + 1)):
                if above[r, c] > min_above + 1:
                    d = (r - r0) ** 2 + (c - c0) ** 2
                    if best is None or d < best[0]:
                        best = (d, r, c)
        if best is None:
            return None, ground
        r0, c0 = best[1], best[2]
    # Roughness: residual of a local plane, high in tree crowns, low on roofs.
    zf = np.nan_to_num(z, nan=ground)
    smooth = ndimage.uniform_filter(zf, 3)
    rough = np.abs(zf - smooth)
    mask = np.zeros(z.shape, bool)
    mask[r0, c0] = True
    queue = deque([(r0, c0)])
    while queue:
        r, c = queue.popleft()
        for dr, dc in ((1, 0), (-1, 0), (0, 1), (0, -1)):
            rr, cc = r + dr, c + dc
            if 0 <= rr < rows and 0 <= cc < cols and not mask[rr, cc]:
                if above[rr, cc] > min_above and abs(zf[rr, cc] - zf[r, c]) < max_step and rough[rr, cc] < (0.25 if px < 0.4 else 0.4):
                    mask[rr, cc] = True
                    queue.append((rr, cc))
    mask = ndimage.binary_closing(mask, iterations=2) & (above > min_above)
    mask = ndimage.binary_fill_holes(mask)
    return mask, ground


def main_axis(mask):
    """The building's main direction (compass degrees, 0–180) from its outline."""
    rr, cc = np.nonzero(mask)
    if len(rr) < 3:
        return 0.0
    cov = np.cov(np.vstack([cc - cc.mean(), -(rr - rr.mean())]))  # x east, y north
    vals, vecs = np.linalg.eigh(cov)
    ex, ny = vecs[:, np.argmax(vals)]
    return float(np.degrees(np.arctan2(ex, ny)) % 180)


def faces_of(z, px, mask, axis=None):
    """Roof faces: cells grouped by the direction they face. With a known
    building axis, directions are sorted into the building's four sides (most
    roofs are gables or hips along the walls); otherwise into 8 compass
    sectors. Tilt and direction are measured inside each face, away from the
    edges where walls and sparse points distort them."""
    zs = ndimage.gaussian_filter(np.nan_to_num(z, nan=0.0), 1.0)
    dzdy, dzdx = np.gradient(zs, px)  # rows go south
    slope = np.degrees(np.arctan(np.hypot(dzdx, dzdy)))
    # Compass direction the face points to (downhill): 0 = N, 90 = E, 180 = S.
    aspect = (np.degrees(np.arctan2(-dzdx, dzdy)) + 360) % 360
    flat = slope < FLAT_LIMIT
    if axis is not None:
        sector = np.where(flat, -1, np.round(((aspect - axis) % 360) / 90).astype(int) % 4)
        sectors = range(-1, 4)
    else:
        sector = np.where(flat, -1, np.round(aspect / 45).astype(int) % 8)
        sectors = range(-1, 8)
    faces = []
    for s in sectors:
        part = mask & (sector == s)
        part = ndimage.binary_opening(part, iterations=1)
        labels, count = ndimage.label(part)
        for i in range(1, count + 1):
            m = labels == i
            if m.sum() * px * px < 4.0:  # ignore patches under 4 m²
                continue
            core = ndimage.binary_erosion(m, iterations=max(1, int(round(0.75 / px))))
            sample = core if core.sum() >= 8 else m
            tilt = float(np.median(slope[sample]))
            az = float(np.degrees(np.arctan2(np.mean(np.sin(np.radians(aspect[sample]))), np.mean(np.cos(np.radians(aspect[sample]))))) % 360)
            is_flat = s == -1 or tilt < FLAT_LIMIT
            faces.append({"mask": m, "flat": is_flat, "tilt": FLAT_TILT if is_flat else tilt, "roof_tilt": tilt, "azimuth": 90.0 if is_flat else az})
    return faces


def obstacles(z, px, mask, tol=BUMP_TOL):
    """Cells of a roof face that stand out from its plane: dormers, bulges,
    chimneys, vents. A plane is fitted to the face's heights (twice, the
    second time without the cells the first fit left more than `tol` off), and
    cells more than `tol` above or below it are candidates. Only connected
    patches of at least BUMP_MIN_M2 count (sparse laser points leave scattered
    single cells off the plane; a real bulge is a block); they get a margin of
    one cell."""
    rr, cc = np.nonzero(mask & np.isfinite(z))
    if len(rr) < 12:
        return np.zeros_like(mask)
    zz = z[rr, cc]
    keep = np.ones(len(rr), bool)
    for _ in range(3):
        a = np.column_stack([cc[keep] * px, rr[keep] * px, np.ones(keep.sum())])
        coef, *_ = np.linalg.lstsq(a, zz[keep], rcond=None)
        res = zz - (cc * px * coef[0] + rr * px * coef[1] + coef[2])
        keep = np.abs(res) <= tol
    off = np.zeros_like(mask)
    off[rr[~keep], cc[~keep]] = True
    labels, count = ndimage.label(off)  # edge neighbours only: diagonal noise does not join up
    if count:
        sizes = ndimage.sum(off, labels, range(1, count + 1))
        big = np.isin(labels, 1 + np.nonzero(sizes * px * px >= BUMP_MIN_M2)[0])
    else:
        big = off
    return big & mask  # every cell under a panel is checked, so no extra margin is needed


def layout(face, px):
    """Panel rectangles (corner cells) inside the face, 0.5 m from its edges
    and clear of anything standing out of the roof plane. Sloping faces try
    portrait and landscape panels and keep whichever fits more (a narrow
    lean-to only takes them landscape)."""
    if face.get("described"):
        return _row_along(face, px)
    best_usable, best = None, []
    for landscape in ((False, True) if not face["flat"] else (False,)):
        usable, panels = _layout(face, px, landscape)
        if best_usable is None or len(panels) > len(best):
            best_usable, best = usable, panels
    return best_usable, best


def _row_along(face, px):
    """A described lean-to (a plain strip along the building): one row of
    landscape panels along its whole length, centred across its depth, the
    face's margin from each end. The 0.5 m grid is too coarse to test a
    narrow diagonal strip cell by cell, so only each panel's centre and the
    middle of its ends must lie on the strip."""
    m = face["mask"]
    margin = face.get("setback_m", SETBACK)
    az = math.radians(face["azimuth"])
    down = (-math.cos(az), math.sin(az))
    up = (-down[0], -down[1])
    across = (-down[1], down[0])
    rows, cols = np.nonzero(m)
    ys, xs = rows * px, cols * px
    u = ys * across[0] + xs * across[1]
    v = ys * up[0] + xs * up[1]
    w, h = PANEL_H, PANEL_W * math.cos(math.radians(face["tilt"]))
    vv = (v.min() + v.max()) / 2 - h / 2
    on = lambda cu, cv: (lambda r, c: 0 <= r < m.shape[0] and 0 <= c < m.shape[1] and m[r, c])(
        int(round((cu * across[0] + cv * up[0]) / px)), int(round((cu * across[1] + cv * up[1]) / px)))
    panels = []
    uu = u.min() - px / 2 + margin
    while uu + w <= u.max() + px / 2 - margin + 1e-6:
        if all(on(cu, vv + h / 2) for cu in (uu + 0.1, uu + w / 2, uu + w - 0.1)):
            panels.append([((cu * across[1] + cv * up[1]) / px, (cu * across[0] + cv * up[0]) / px)
                           for cu, cv in ((uu, vv), (uu + w, vv), (uu + w, vv + h), (uu, vv + h))])
        uu += w + 0.02
    return m, panels


def _layout(face, px, landscape=False):
    usable = ndimage.binary_erosion(face["mask"], iterations=max(1, int(round(face.get("setback_m", SETBACK) / px))))
    if face.get("obstacles") is not None:
        usable &= ~face["obstacles"]
    if not usable.any():
        return usable, []
    rows, cols = np.nonzero(usable)
    if face["flat"]:
        # East–west racks: panels side by side along N–S rows, row pitch for 10° pairs.
        across = (0.0, 1.0)  # east
        up = (-1.0, 0.0)  # north
        w, h = PANEL_H * math.cos(math.radians(FLAT_TILT)), PANEL_W
        gap_w, gap_h = 0.25, 0.05
    else:
        az = math.radians(face["azimuth"])
        # Downhill direction in (row, col) axes; rows run south, cols run east,
        # and compass 0° (north) is towards smaller rows.
        down = (-math.cos(az), math.sin(az))
        up = (-down[0], -down[1])
        across = (-down[1], down[0])
        along, upslope = (PANEL_H, PANEL_W) if landscape else (PANEL_W, PANEL_H)
        w, h = along, upslope * math.cos(math.radians(face["tilt"]))
        gap_w, gap_h = 0.02, 0.02
    # Project the usable cells onto the (across, up) axes, in metres.
    ys, xs = rows * px, cols * px
    u = ys * across[0] + xs * across[1]
    v = ys * up[0] + xs * up[1]

    # Cell centres lie half a cell inside the roof's real edges; extend the range
    # to the edges (the test points below keep every panel on usable cells).
    umin, umax = u.min() - px / 2, u.max() + px / 2
    vmin, vmax = v.min() - px / 2, v.max() + px / 2

    def fill(du, dv):
        panels = []
        vv = vmin + dv
        while vv + h <= vmax + 1e-6:
            uu = umin + du
            while uu + w <= umax + 1e-6:
                # Test points 10 cm inside the corners: a corner exactly on a cell
                # border would otherwise round to the wrong side.
                e = 0.1
                corners = [(uu + e, vv + e), (uu + w - e, vv + e), (uu + e, vv + h - e), (uu + w - e, vv + h - e), (uu + w / 2, vv + h / 2)]
                # Every cell under the panel, not only its corners: an obstacle
                # can sit between them.
                nu, nv = max(2, int(math.ceil(w / (px / 2)))), max(2, int(math.ceil(h / (px / 2))))
                corners += [(uu + e + (w - 2 * e) * i / nu, vv + e + (h - 2 * e) * j / nv) for i in range(nu + 1) for j in range(nv + 1)]
                pts = []
                for cu, cv in corners:
                    y = cu * across[0] + cv * up[0]
                    x = cu * across[1] + cv * up[1]
                    r, c = int(round(y / px)), int(round(x / px))
                    if not (0 <= r < usable.shape[0] and 0 <= c < usable.shape[1] and usable[r, c]):
                        break
                    pts.append((x / px, y / px))
                if len(pts) == len(corners):
                    true = []
                    for cu, cv in ((uu, vv), (uu + w, vv), (uu + w, vv + h), (uu, vv + h)):
                        true.append(((cu * across[1] + cv * up[1]) / px, (cu * across[0] + cv * up[0]) / px))
                    panels.append(true)
                uu += w + gap_w
            vv += h + gap_h
        return panels

    # The grid's starting point decides how many whole panels fit; try a few.
    steps = 4
    best = []
    for i in range(steps):
        for j in range(steps):
            panels = fill(i * (w + gap_w) / steps, j * (h + gap_h) / steps)
            if len(panels) > len(best):
                best = panels
    return usable, best


_pvgis_cache = {}


def yield_per_kwp(tilt, azimuth, flat):
    """kWh per kWp and year from PVGIS. Flat roofs: half east, half west at 10°."""
    def one(angle, compass):
        key = (round(angle), round(compass / 5) * 5)
        if key not in _pvgis_cache:
            aspect = ((key[1] - 180 + 180) % 360) - 180  # PVGIS: 0 = south, -90 = east, 90 = west
            url = (f"https://re.jrc.ec.europa.eu/api/v5_3/PVcalc?lat={LAT}&lon={LON}&peakpower=1&loss=14"
                   f"&angle={key[0]}&aspect={aspect}&outputformat=json")
            with urllib.request.urlopen(url, timeout=60) as res:
                _pvgis_cache[key] = json.load(res)["outputs"]["totals"]["fixed"]["E_y"]
        return _pvgis_cache[key]
    if flat:
        return (one(FLAT_TILT, 90) + one(FLAT_TILT, 270)) / 2
    return one(tilt, azimuth)


def png_b64(rgb):
    drv = gdal.GetDriverByName("MEM")
    h, w, _ = rgb.shape
    mem = drv.Create("", w, h, 3, gdal.GDT_Byte)
    for i in range(3):
        mem.GetRasterBand(i + 1).WriteArray(rgb[:, :, i])
    path = "/vsimem/roof.png"
    gdal.GetDriverByName("PNG").CreateCopy(path, mem)
    f = gdal.VSIFOpenL(path, "rb")
    gdal.VSIFSeekL(f, 0, 2)
    size = gdal.VSIFTellL(f)
    gdal.VSIFSeekL(f, 0, 0)
    data = gdal.VSIFReadL(1, size, f)
    gdal.VSIFCloseL(f)
    gdal.Unlink(path)
    return "data:image/png;base64," + base64.b64encode(data).decode()


def hillshade(z, px):
    zs = np.nan_to_num(z, nan=np.nanmin(z))
    dzdy, dzdx = np.gradient(zs, px)
    slope = np.arctan(np.hypot(dzdx, dzdy))
    aspect = np.arctan2(-dzdx, dzdy)
    az, alt = math.radians(315), math.radians(45)
    shade = np.sin(alt) * np.cos(slope) + np.cos(alt) * np.sin(slope) * np.cos(az - aspect)
    g = np.clip(shade * 255, 0, 255).astype(np.uint8)
    return np.dstack([g, g, g])


def compass(az):
    return ["N", "NE", "E", "SE", "S", "SW", "W", "NW"][int(round(az / 45)) % 8]


CANOPY_ABOVE_M = 1.5  # roof cells this far above the roof's 90th-percentile height are a tree over the roof


def remove_canopy(z, mask, px):
    """Trees hanging over a roof (the camping's cabins stand in the forest)
    show in the laser data as cells well above the roof: left in, they become
    steep false roof faces. Cells inside the roof more than CANOPY_ABOVE_M
    above its 90th-percentile height take the height of the nearest roof cell
    below that line (for the 3D model), and are left out when the roof faces
    are fitted (the nearest face takes them afterwards). Returns the cleaned
    heights, the canopy cells and their area (m²)."""
    none = np.zeros_like(mask, dtype=bool)
    vals = z[mask & np.isfinite(z)]
    if vals.size < 20:
        return z, none, 0.0
    limit = np.percentile(vals, 90) + CANOPY_ABOVE_M
    tree = mask & np.isfinite(z) & (z > limit)
    if not tree.any():
        return z, none, 0.0
    # Grow by one cell: the canopy's edge pulls the cells around it up too.
    from scipy import ndimage
    tree = ndimage.binary_dilation(tree) & mask
    good = mask & np.isfinite(z) & ~tree
    _, (ri, ci) = ndimage.distance_transform_edt(~good, return_indices=True)
    out = z.copy()
    out[tree] = z[ri[tree], ci[tree]]
    return out, tree, float(tree.sum() * px * px)


def analyse(ds, b, buildings=None, ortho=None):
    z, px, origin = read_window(ds, b["e"], b["n"], WINDOW)
    seed = (int((origin[1] - b["n"]) / px), int((b["e"] - origin[0]) / px))
    outline = footprint_mask(buildings, b["e"], b["n"], origin, px, z.shape) if buildings else None
    if outline is not None:
        ground = np.nanpercentile(z, 5)
        mask = outline & (np.nan_to_num(z, nan=ground) - ground > 1.0)
        source = "building outline (Lantmäteriet)"
    else:
        mask, ground = grow_roof(z, px, seed)
        source = "grown from the point"
    if mask is None or mask.sum() * px * px < 10:
        return {**b, "error": "No roof found at the coordinate."}
    z, tree, canopy_m2 = remove_canopy(z, mask, px)
    rr, cc = np.nonzero(mask)
    pad = int(3 / px)
    r0, r1, c0, c1 = max(0, rr.min() - pad), min(z.shape[0], rr.max() + pad + 1), max(0, cc.min() - pad), min(z.shape[1], cc.max() + pad + 1)
    zc, mc = z[r0:r1, c0:c1], mask[r0:r1, c0:c1]
    crop_origin = (origin[0] + c0 * px, origin[1] - r0 * px)
    faces = faces_of(zc, px, mc & ~tree[r0:r1, c0:c1], main_axis(outline[r0:r1, c0:c1]) if outline is not None else None)
    if outline is not None and faces:
        # The outline is exact while sparse laser points blur the edges: give
        # every cell inside the outline to its nearest roof face.
        inside = outline[r0:r1, c0:c1]
        labels = np.zeros(inside.shape, int)
        for i, f in enumerate(faces):
            labels[f["mask"]] = i + 1
        _, (ir, ic) = ndimage.distance_transform_edt(labels == 0, return_indices=True)
        nearest = labels[ir, ic]
        for i, f in enumerate(faces):
            f["mask"] = inside & (nearest == i + 1)
    # Lean-tos described by hand (see BUILDINGS): the outer depth_m of the roof
    # face on that side becomes a face of its own, with the described pitch.
    for lt in b.get("lean_tos", []):
        if outline is None:
            break
        inside_c = outline[r0:r1, c0:c1]
        # Distance in from the outline edge on that side, column by column (N/S)
        # or row by row (E/W).
        idx = np.indices(inside_c.shape)
        if lt["side"] in ("N", "S"):
            rows_in = np.where(inside_c, idx[0], np.nan)
            edge = np.nanmin(rows_in, axis=0) if lt["side"] == "N" else np.nanmax(rows_in, axis=0)
            depth = np.abs(idx[0] - edge[None, :]) * px
        else:
            cols_in = np.where(inside_c, idx[1], np.nan)
            edge = np.nanmax(cols_in, axis=1) if lt["side"] == "E" else np.nanmin(cols_in, axis=1)
            depth = np.abs(idx[1] - edge[:, None]) * px
        depth = np.nan_to_num(depth, nan=1e9)
        for f in list(faces):
            if f["flat"] or compass(f["azimuth"]) != lt["side"]:
                continue
            strip = f["mask"] & (depth < lt["depth_m"])
            if strip.sum() * px * px < 4:
                continue
            f["mask"] = f["mask"] & ~strip
            # The lean-to faces square to the building's long axis, so its
            # panel rows run along it; 0.3 m margin: the edge against the main
            # roof is no roof edge, and 0.3 m is a usual clearance at an eave.
            axis = main_axis(inside_c)
            normals = [(axis + 90) % 360, (axis + 270) % 360]
            az = min(normals, key=lambda a: abs(((a - f["azimuth"] + 180) % 360) - 180))
            faces.append({"mask": strip, "flat": False, "tilt": float(lt["tilt"]), "roof_tilt": float(lt["tilt"]), "azimuth": az, "described": lt["what"], "setback_m": 0.3})
            break

    # Obstacles placed by hand (see BUILDINGS): a disc of r_m around each point.
    manual = np.zeros(mc.shape, bool)
    yy, xx = np.mgrid[0:mc.shape[0], 0:mc.shape[1]]
    for ob in b.get("obstacles", []):
        r, c = (crop_origin[1] - ob["n"]) / px - 0.5, (ob["e"] - crop_origin[0]) / px - 0.5
        manual |= np.hypot(yy - r, xx - c) * px <= ob["r_m"] + px / 2
    # Trees hanging over the roof (remove_canopy) shade what is under them: no panels there.
    manual |= tree[r0:r1, c0:c1]
    out_faces = []
    for i, f in enumerate(faces):
        f["obstacles"] = obstacles(zc, px, f["mask"]) | (manual & f["mask"])
        usable, panels = layout(f, px)
        y = yield_per_kwp(f["tilt"], f["azimuth"], f["flat"]) if panels else 0
        worth = y >= MIN_YIELD
        if not worth:
            panels = []  # too little sun (north-facing): reported, not used
        n = len(panels)
        kwp = n * PANEL_WP / 1000
        out_faces.append({
            "worth_it": worth,
            "id": i + 1,
            "flat": f["flat"],
            "roof_tilt": round(f["roof_tilt"], 1),
            "panel_tilt": round(f["tilt"], 1),
            "azimuth": round(f["azimuth"]),
            "direction": "flat (east–west racks)" if f["flat"] else compass(f["azimuth"]),
            "area_m2": round(float(f["mask"].sum() * px * px / (1 if f["flat"] else math.cos(math.radians(f["roof_tilt"])))), 1),
            "usable_m2": round(float(usable.sum() * px * px / (1 if f["flat"] else math.cos(math.radians(f["roof_tilt"])))), 1),
            "obstacle_m2": round(float(f["obstacles"].sum() * px * px), 1),
            **({"described": f["described"]} if f.get("described") else {}),
            "panels": n,
            "kwp": round(kwp, 2),
            "kwh_per_kwp": round(y),
            "kwh_year": round(kwp * y),
            "mask": base64.b64encode(np.packbits(f["mask"]).tobytes()).decode(),
            "panel_polygons": [[[round(x, 2), round(yy, 2)] for x, yy in p] for p in panels],
        })
    return {
        **b,
        "px": px,
        "width": int(zc.shape[1]),
        "height": int(zc.shape[0]),
        "roof_height_m": round(float(np.nanmedian(zc[mc]) - ground), 1),
        "roof_from": source,
        **({"canopy_m2": round(canopy_m2, 1)} if canopy_m2 else {}),
        "image": png_b64(hillshade(zc, px)),
        "photo": ortho_png(ortho, crop_origin, px, zc.shape) if ortho else None,
        "faces": out_faces,
        "panels": sum(f["panels"] for f in out_faces),
        "kwp": round(sum(f["kwp"] for f in out_faces), 2),
        "kwh_year": sum(f["kwh_year"] for f in out_faces),
        # For the 3D model: SWEREF 99 TM of the grid's top-left corner, and
        # the roof's height above the ground in decimetres (0 outside the
        # roof, so trees and the surroundings drop out).
        "origin": [round(crop_origin[0], 2), round(crop_origin[1], 2)],
        "heights_dm": base64.b64encode(np.where(mc, np.clip(np.nan_to_num(zc - ground, nan=0.0), 0, 60) * 10, 0).round().astype("<i2").tobytes()).decode(),
    }


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--dsm", help="Lantmäteriet surface model GeoTIFF (SWEREF 99 TM)")
    ap.add_argument("--laz", nargs="+", help="Lantmäteriet laser point clouds (.copc.laz); several flights are merged")
    ap.add_argument("--buildings", help="Lantmäteriet Byggnad download (byggnad_knXXXX.zip or .gpkg) for exact roof outlines")
    ap.add_argument("--ortho", help="Lantmäteriet orthophoto GeoTIFF, shown under the roofs in the viewer")
    ap.add_argument("--px", type=float, default=0.5, help="cell size when building a surface model from laser data (m)")
    ap.add_argument("--out", default=os.path.join(os.path.dirname(__file__), "out", "roofs.json"))
    ap.add_argument("--source", help="text describing the height data, shown in the viewer")
    ap.add_argument("--publish", help="also write a compact copy without images for the dashboard's Solar tab (e.g. public/data/solar-roofs.json)")
    args = ap.parse_args()
    if not args.dsm and not args.laz:
        ap.error("give --dsm or --laz")
    if args.laz:
        es = [b["e"] for b in BUILDINGS]
        ns = [b["n"] for b in BUILDINGS]
        bounds = (min(es) - WINDOW, max(es) + WINDOW, min(ns) - WINDOW, max(ns) + WINDOW)
        os.makedirs(os.path.dirname(args.out), exist_ok=True)
        args.dsm = laser_to_dsm(args.laz, os.path.join(os.path.dirname(args.out), "laser_dsm.tif"), bounds, args.px)
        args.source = args.source or f"Lantmäteriet, Laserdata Skog ({len(args.laz)} flight{'s' if len(args.laz) > 1 else ''}), surface model {args.px} m"
    args.source = args.source or "Lantmäteriet, Ytmodell från flygbilder 2026 (0.25 m)"
    ds = gdal.Open(args.dsm)
    result = {
        "source": args.source,
        "panel": {"w": PANEL_W, "h": PANEL_H, "wp": PANEL_WP, "setback_m": SETBACK},
        "buildings": [],
    }
    for b in BUILDINGS:
        r = analyse(ds, b, args.buildings, args.ortho)
        result["buildings"].append(r)
        if r.get("error"):
            print(f"{b['name']}: {r['error']}")
        else:
            print(f"{b['name']}: {len(r['faces'])} faces, {r['panels']} panels, {r['kwp']} kWp, {r['kwh_year']} kWh/yr")
        for f in r.get("faces", []):
            print(f"   face {f['id']}: {f['direction']:>22} roof {f['roof_tilt']:>4}°, {f['area_m2']:>6} m², usable {f['usable_m2']:>6} m², {f['panels']:>3} panels, {f['kwh_per_kwp']} kWh/kWp")
    os.makedirs(os.path.dirname(args.out), exist_ok=True)
    with open(args.out, "w", encoding="utf-8") as fh:
        json.dump(result, fh)
    print("wrote", args.out)
    if args.publish:
        # The dashboard is public: geometry and results only, no aerial photo.
        public = {**result, "buildings": [{k: v for k, v in b.items() if k not in ("image", "photo")} for b in result["buildings"]]}
        os.makedirs(os.path.dirname(os.path.abspath(args.publish)), exist_ok=True)
        with open(args.publish, "w", encoding="utf-8") as fh:
            json.dump(public, fh, separators=(",", ":"))
        print("wrote", args.publish, os.path.getsize(args.publish) // 1024, "kB")


if __name__ == "__main__":
    sys.exit(main())
