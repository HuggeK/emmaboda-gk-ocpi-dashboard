"""Synthetic laser data and building outlines from the synthetic surface model,
to test roof_solar.py's --laz and --buildings paths without Lantmäteriet's data:
about 1.2 points per m² (like the 2019 and 2026 flights over the club together)
with 5 cm height noise, and outlines for the office and the old office (not
the studio, which then falls back to growing from the point).

    python-qgis.bat tools\\roof-solar\\make_test_laser.py out\\test_dsm.tif out
"""
import os
import subprocess
import sys
import zipfile

import numpy as np
from osgeo import gdal, ogr, osr

gdal.UseExceptions()
dsm_path, out = sys.argv[1], sys.argv[2]
ds = gdal.Open(dsm_path)
gt = ds.GetGeoTransform()
z = ds.GetRasterBand(1).ReadAsArray()
rng = np.random.default_rng(7)
area = z.shape[0] * z.shape[1] * gt[1] * gt[1]
count = int(area * 1.2)
rows = rng.integers(0, z.shape[0], count)
cols = rng.integers(0, z.shape[1], count)
x = gt[0] + (cols + rng.random(count)) * gt[1]
y = gt[3] - (rows + rng.random(count)) * gt[1]
h = z[rows, cols] + rng.normal(0, 0.05, count)
csv = os.path.join(out, "test_points.csv")
np.savetxt(csv, np.column_stack([x, y, h, np.ones(count)]), delimiter=",", header="X,Y,Z,Classification", comments="", fmt="%.3f")
pdal = os.path.join(os.path.dirname(sys.executable), "pdal.exe")
laz = os.path.join(out, "test_points.laz")
subprocess.run([pdal if os.path.exists(pdal) else "pdal", "translate", csv, laz, "--writers.las.compression=true", "--writers.las.a_srs=EPSG:3006"], check=True)
os.unlink(csv)

# Building outlines as a GeoPackage in a zip, like Lantmäteriet's byggnad_knXXXX.zip.
gpkg = os.path.join(out, "byggnad_test.gpkg")
if os.path.exists(gpkg):
    os.unlink(gpkg)
src = ogr.GetDriverByName("GPKG").CreateDataSource(gpkg)
srs = osr.SpatialReference()
srs.ImportFromEPSG(3006)
layer = src.CreateLayer("byggnad", srs, ogr.wkbPolygon)
for ce, cn, w, h2 in ((536483, 6265521, 24, 12), (536501, 6265557, 10, 16)):
    ring = ogr.Geometry(ogr.wkbLinearRing)
    for dx, dy in ((-w / 2, -h2 / 2), (w / 2, -h2 / 2), (w / 2, h2 / 2), (-w / 2, h2 / 2), (-w / 2, -h2 / 2)):
        ring.AddPoint_2D(ce + dx, cn + dy)
    poly = ogr.Geometry(ogr.wkbPolygon)
    poly.AddGeometry(ring)
    feat = ogr.Feature(layer.GetLayerDefn())
    feat.SetGeometry(poly)
    layer.CreateFeature(feat)
src = None
with zipfile.ZipFile(os.path.join(out, "byggnad_test.zip"), "w") as zf:
    zf.write(gpkg, "byggnad_test.gpkg")
print(f"wrote {laz} ({count} points) and byggnad_test.zip")
