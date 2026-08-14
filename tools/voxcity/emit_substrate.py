#!/usr/bin/env python3
"""
Stage 10 (spec v3 §1, §10, §12): the voxcity substrate pipeline.

§1: "voxcity stays a build-time python pipeline that runs once and emits
terrain. The building/road/parcel importer is a separate step ... Neither ships
in the runtime image."

§12: "stage 10 is still a swap. Define the substrate contract at stage 1 and
hold to it."

So this script does exactly one thing: run voxcity over the chunk's bounding box
and emit the Substrate struct that packages/core/src/world.ts already defines
and that packages/client/src/render/substrateMesh.ts already draws. Nothing
downstream changes when the provider flips from "flat-datum" to "voxcity" —
that is the entire point of having written the contract at stage 1.

    pip install voxcity
    python tools/voxcity/emit_substrate.py \
        --chunk packages/client/public/world/schiedam-havens.json \
        --out   packages/client/public/world/schiedam-havens.substrate.json

Then re-run the importer with --substrate to fold it into the seed:

    npm run import -w @civ/importer -- schiedam-havens \
        --substrate packages/client/public/world/schiedam-havens.substrate.json

What voxcity contributes that the flat datum cannot: real terrain relief, tree
canopy, and a coastline/water mask derived from the same source as the terrain
rather than from OSM polygons. §2 warns that without terrain character "the
voxcity substrate swap is invisible and the work looks like it did nothing" —
in Schiedam the relief is genuinely small, so canopy and water are what will
actually read.
"""

from __future__ import annotations

import argparse
import json
import math
import sys
from pathlib import Path

# The Substrate contract (packages/core/src/world.ts). Kept here as a literal
# rather than imported, because this script must run without the JS toolchain.
SURFACE_KINDS = {
    "water",
    "park",
    "grass",
    "wood",
    "parking",
    "paving",
    "farmland",
    "rail",
}

# voxcity's land-cover classes -> our surface kinds. voxcity fuses several
# sources; the class names below follow its OpenEarthMap/ESA WorldCover output.
LANDCOVER_TO_KIND = {
    "water": "water",
    "sea": "water",
    "river": "water",
    "wetland": "grass",
    "tree": "wood",
    "trees": "wood",
    "forest": "wood",
    "grass": "grass",
    "rangeland": "grass",
    "shrub": "grass",
    "bareland": "paving",
    "cropland": "farmland",
    "agriculture": "farmland",
    "developed_space": "paving",
    "road": "paving",
    "building": None,  # buildings are not the substrate's business (§1)
}


def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--chunk", required=True, type=Path, help="emitted world seed JSON")
    p.add_argument("--out", required=True, type=Path, help="where to write the substrate JSON")
    p.add_argument("--cell", type=float, default=10.0, help="elevation sample spacing, metres")
    p.add_argument(
        "--dry-run",
        action="store_true",
        help="report what would be fetched without importing voxcity",
    )
    return p.parse_args()


def main() -> int:
    args = parse_args()
    chunk = json.loads(args.chunk.read_text())
    meta = chunk["chunk"]
    south, west, north, east = meta["bbox"]
    bounds = meta["localBounds"]

    cols = max(2, math.ceil((bounds["maxX"] - bounds["minX"]) / args.cell) + 1)
    rows = max(2, math.ceil((bounds["maxY"] - bounds["minY"]) / args.cell) + 1)

    print(f"chunk   {meta['id']} ({meta['name']})", file=sys.stderr)
    print(f"bbox    {south:.5f},{west:.5f} .. {north:.5f},{east:.5f}", file=sys.stderr)
    print(f"grid    {cols} x {rows} at {args.cell} m", file=sys.stderr)

    if args.dry_run:
        print("dry run: not importing voxcity", file=sys.stderr)
        return 0

    try:
        from voxcity.generator import get_voxcity  # type: ignore
    except ImportError:
        print(
            "voxcity is not installed. `pip install voxcity`, or re-run with --dry-run.\n"
            "The runtime does not need this: the committed seed already carries a\n"
            "flat-datum substrate and the renderer reads the contract, not the provider.",
            file=sys.stderr,
        )
        return 2

    # voxcity wants (lon, lat) corners. It returns a fused semantic voxel grid
    # plus the component rasters; we take only the rasters — §1 is explicit that
    # voxcity provides the substrate and NOT the mutable entities, and a fused
    # grid cannot express "agent 41 acquires building 4821" anyway.
    rectangle = [(west, south), (east, south), (east, north), (west, north)]
    voxcity_grid, building_height, canopy_height, land_cover, dem, *_ = get_voxcity(
        rectangle,
        building_source="OpenStreetMap",
        land_cover_source="OpenEarthMapJapan",
        canopy_height_source="High Resolution 1m Global Canopy Height Maps",
        dem_source="DeltaDTM",
        meshsize=args.cell,
    )
    del voxcity_grid, building_height  # explicitly discarded, see above

    elevation = resample(dem, cols, rows)
    surfaces = surfaces_from_landcover(land_cover, canopy_height, bounds, args.cell)

    substrate = {
        "cellSizeM": args.cell,
        "elevation": [round(v, 3) for v in elevation],
        "cols": cols,
        "rows": rows,
        "originX": bounds["minX"],
        "originY": bounds["minY"],
        "surfaces": surfaces,
        "provider": "voxcity",
    }
    args.out.write_text(json.dumps(substrate))
    print(f"wrote {args.out} ({len(surfaces)} surfaces)", file=sys.stderr)
    return 0


def resample(dem, cols: int, rows: int) -> list[float]:
    """Nearest-neighbour resample of voxcity's DEM onto the contract's grid."""
    src_rows = len(dem)
    src_cols = len(dem[0]) if src_rows else 0
    out: list[float] = []
    for j in range(rows):
        sj = min(src_rows - 1, int(j * src_rows / rows)) if src_rows else 0
        for i in range(cols):
            si = min(src_cols - 1, int(i * src_cols / cols)) if src_cols else 0
            out.append(float(dem[sj][si]) if src_rows else 0.0)
    return out


def surfaces_from_landcover(land_cover, canopy_height, bounds, cell: float) -> list[dict]:
    """
    Trace the land-cover raster into polygons at the contract's resolution.

    Deliberately blocky: §15 wants faceted, simplified ground rather than a
    photographic mask, and one quad per cell run reads as a stylized world where
    a marching-squares contour would read as GIS.
    """
    rows = len(land_cover)
    cols = len(land_cover[0]) if rows else 0
    surfaces: list[dict] = []

    for j in range(rows):
        run_kind = None
        run_start = 0
        for i in range(cols + 1):
            kind = None
            if i < cols:
                raw = land_cover[j][i]
                name = raw if isinstance(raw, str) else str(raw)
                kind = LANDCOVER_TO_KIND.get(name.lower())
                # canopy overrides low vegetation where trees actually stand
                if kind in ("grass", "farmland") and canopy_height is not None:
                    try:
                        if float(canopy_height[j][i]) > 3.0:
                            kind = "wood"
                    except (IndexError, TypeError, ValueError):
                        pass
            if kind != run_kind:
                if run_kind in SURFACE_KINDS and i > run_start:
                    x0 = bounds["minX"] + run_start * cell
                    x1 = bounds["minX"] + i * cell
                    y0 = bounds["minY"] + j * cell
                    y1 = y0 + cell
                    surfaces.append(
                        {
                            "kind": run_kind,
                            "polygon": [[x0, y0], [x1, y0], [x1, y1], [x0, y1]],
                        }
                    )
                run_kind = kind
                run_start = i
    return surfaces


if __name__ == "__main__":
    raise SystemExit(main())
