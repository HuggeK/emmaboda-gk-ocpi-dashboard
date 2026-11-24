"""A synthetic surface model with roofs of known shape, to test roof_solar.py
without Lantmäteriet's data: a 24 × 12 m gable roof (27°, ridge east–west) at
the office, an 8 × 8 m flat roof at the studio, a 16 × 10 m gable roof (35°,
ridge north–south) at the old office, and a tree crown next to the office.

    python-qgis.bat tools\\roof-solar\\make_test_dsm.py out\\test_dsm.tif
"""
import math
import sys

import numpy as np
from osgeo import gdal, osr

gdal.UseExceptions()
PX = 0.25
E0, N0 = 536400.0, 6265620.0  # top-left
W = H = int(200 / PX)
e = E0 + (np.arange(W) + 0.5) * PX
n = N0 - (np.arange(H) + 0.5) * PX
EE, NN = np.meshgrid(e, n)
rng = np.random.default_rng(1)
z = 100.0 + 0.02 * (EE - E0) + rng.normal(0, 0.03, EE.shape)  # gently sloping ground


def gable(ce, cn, length, width, eave, tilt, ridge_east_west):
    inside = (abs(EE - ce) <= length / 2) & (abs(NN - cn) <= width / 2) if ridge_east_west else (abs(EE - ce) <= width / 2) & (abs(NN - cn) <= length / 2)
    dist = (width / 2 - abs(NN - cn)) if ridge_east_west else (width / 2 - abs(EE - ce))
    roof = 100.0 + eave + np.maximum(dist, 0) * math.tan(math.radians(tilt))
    return np.where(inside, roof, -np.inf)


z = np.maximum(z, gable(536483, 6265521, 24, 12, 3.0, 27, True))
z = np.maximum(z, gable(536501, 6265557, 16, 10, 2.8, 35, False))
studio = (abs(EE - 536475) <= 4) & (abs(NN - 6265508) <= 4)
z = np.where(studio, 103.5 + rng.normal(0, 0.02, EE.shape), z)
tree = np.hypot(EE - 536500, NN - 6265530) < 4
z = np.where(tree, 100 + 9 - np.hypot(EE - 536500, NN - 6265530) + rng.normal(0, 0.6, EE.shape), z)

out = sys.argv[1]
drv = gdal.GetDriverByName("GTiff")
ds = drv.Create(out, W, H, 1, gdal.GDT_Float32, options=["COMPRESS=DEFLATE"])
ds.SetGeoTransform((E0, PX, 0, N0, 0, -PX))
srs = osr.SpatialReference()
srs.ImportFromEPSG(3006)
ds.SetProjection(srs.ExportToWkt())
ds.GetRasterBand(1).WriteArray(z.astype("float32"))
ds = None
print("wrote", out)
