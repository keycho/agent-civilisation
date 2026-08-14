# AHN terrain (§10, §21.5)

Build-time only. Nothing here ships in the runtime image; it emits a `Substrate`
to the same `--substrate` seam stage 10 defined.

```bash
node --no-warnings tools/ahn/emit_substrate.ts \
  --chunk packages/client/public/world/schiedam-havens.json \
  --out   /tmp/schiedam.substrate.json

npm run import -w @civ/importer -- schiedam-havens \
  --substrate /tmp/schiedam.substrate.json
```

No credentials, no venv, no Python. PDOK serves AHN over WCS 2.0.1 as GeoTIFF:

```
https://service.pdok.nl/rws/ahn/wcs/v1_0
  coverageId=dtm_05m          the terrain model — buildings and vegetation removed
  subset=x(...) subset=y(...) RD New / EPSG:28992 metres, the frame the chunk already works in
```

## Why this replaced voxcity here

§21.5, and the measurement is in `../voxcity/README.md`. voxcity reaches the
same AHN data through Google Earth Engine, which needs credentials this
environment does not have, and without them it returns an all-zero elevation
grid **while printing `✓ Dem complete`**. Its OSM land cover also carries no
water, so adopting it deleted every canal in a canal town.

Straight from PDOK, the same chunk:

```
                    voxcity        AHN via PDOK
elevation range     0.00 m         -0.43 to 3.10 m NAP
relief              0.00 m         3.54 m
water bodies        0              12 (kept from the importer, see below)
undevelopable       0 parcels      140 parcels
```

**Elevation only.** AHN is a terrain model, not a land-cover product, so a
substrate with `provider: "ahn"` carries an empty `surfaces` array and the
importer keeps its own OSM-derived ones. That is deliberate and it is the
direct fix for the finding that retired voxcity: the thing that deletes canals
is adopting a land cover that has none.

## Two things that produced plausible-looking garbage

**The floating-point predictor.** PDOK's GeoTIFF is deflate-compressed with
TIFF predictor 3, which horizontally differences the bytes and then splits them
into planes, most significant byte first. Decoding without undoing it does not
error — it returns finite floats. The first read gave a relief of
1.7 × 10³⁸ metres. `geotiff.ts` undoes it, and the emitter's own relief check is
what caught it.

**NODATA is `3.4028234663852886e+38`**, declared in tag 42113 as a string.
A DTM over dense urban fabric is mostly holes: 54% of pixels here carry no data
at all, because everything under a building footprint and over water is removed.
The emitter averages the valid pixels in each 20 m cell, then dilates from
neighbours to fill cells that have none — 22 of 961 in this chunk.

The zero-relief canary stays in the importer regardless of provider. It was
written for voxcity but it is not about voxcity: a DEM fetch that fails while
reporting success is a shape, not an instance.

## When voxcity is worth revisiting

A chunk in a country with no national lidar product. voxcity's value is fusing
many global sources behind one API, and that is worth real money somewhere the
direct path does not exist. For a Dutch chunk it is strictly worse than a URL.
