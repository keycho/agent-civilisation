# voxcity substrate pipeline (§1, §10, §19)

Build-time only. Nothing here ships in the runtime image, and the committed seed
carries `provider: "flat-datum"`.

```bash
python3 -m venv .venv-voxcity
.venv-voxcity/bin/pip install --upgrade pip setuptools wheel
.venv-voxcity/bin/pip install voxcity

.venv-voxcity/bin/python tools/voxcity/emit_substrate.py \
  --chunk packages/client/public/world/schiedam-havens.json \
  --out   /tmp/schiedam.substrate.json

npm run import -w @civ/importer -- schiedam-havens \
  --substrate /tmp/schiedam.substrate.json
```

`pip install voxcity` fails against Debian's patched setuptools —
`reverse_geocoder` and `py-vox-io` both hit `AttributeError: install_layout`
building their wheels. A clean venv with current setuptools builds both.

## What running it actually established

The seam works. voxcity executes end to end, the emitter produces a
contract-valid `Substrate`, and the importer validates and swaps it in with no
change anywhere downstream — which is what §12 means by "stage 10 is still a
swap".

Two things it also established, neither of which is visible from the code:

**The result object is not a tuple.** voxcity ≥ 1.6 returns a `VoxCity`
dataclass — `.dem.elevation`, `.land_cover.classes`, `.tree_canopy.top` — where
older examples unpack five arrays. Land cover comes back as 1-based integer
class codes, not names. The emitter was written against the older shape and had
to be corrected against the real API.

**The DEM is null, and voxcity says it succeeded.** The Netherlands source is
AHN4 served through Google Earth Engine, which needs credentials this
environment does not have. The run prints `✓ Dem complete` and returns an
all-zero elevation grid: 3,660 samples, one distinct value, 0.00 m relief.

That is not flat terrain. Real polder still varies by tens of centimetres, so a
grid with *exactly* zero relief is a failed fetch wearing a success message —
the same silent-plausible-output shape every §18.3 canary exists for. The
importer now refuses such a substrate by name and requires `--allow-flat` to
proceed.

**For this chunk the voxcity substrate is worse than the one already committed.**
Its OSM land cover yields 298 paving, 205 wood, 1 grass and **no water at all**,
against the 12 water bodies the importer derives directly. Swapping it in loses
every canal in a canal district and takes `undevelopable` parcels from 140 to 0,
because water is what makes a parcel undevelopable. The importer warns about
exactly this before proceeding.

So: plumbing proven, output not adopted. The committed seed stays `flat-datum`.
Stage 10 becomes worth doing on a chunk with real relief and with Earth Engine
credentials available — which is the same second chunk §18.5 wants for
cross-area validation.
