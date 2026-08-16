# What the pipeline assumed was universal, and wasn't (§31.6-2)

The London adapter's purpose, beyond London: produce the list of Dutch
assumptions the next three adapters consume (§25.3 predicted most of these).
Each entry says what broke or bent, what was done, and what Brooklyn, Paris
and Tokyo should expect. The prediction on record — "the london import fails
at least two canaries on first run for osm-convention reasons" — resolved at
one hard failure plus two soft findings that matter more than the failure.

## 1. "Carriageways do not run through plots" is Dutch fabric, not geometry

The footprint-parcel carriageway canary was bounded at 1% because OSM rarely
draws a road through a building in the Netherlands (gatehouses, arcades — 3 of
936 in Schiedam). Deptford's first import tripped it at 8%: 19 plain
`highway=service` ways through post-industrial wharf sheds, no covering, no
tunnels, both geometries ground truth. Diagnosed before touching the bound —
the covered/building-passage hypothesis died on the tag data.

Restated, not widened: a footprint parcel IS the building's own footprint, so
the derivation fault the canary hunts cannot occur there by construction. The
hard zero stays on derived parcels; the footprint bound is now a layer-offset
tripwire at 15%.

**Expect**: Brooklyn (loading docks through warehouses) and Tokyo (private
alleys) sit in the same class.

## 2. One OSM way is not one building

UK convention maps whole terrace rows as single ways (some tagged
`building=terrace`, most not). 473 "buildings" in 0.64 km² of inner London is
partly real vacancy (Convoys Wharf) and partly rows counted as one. Economics
run per row: a terrace of eight trades, renovates and demolishes as one asset.

Accepted for this block, recorded here rather than papered over with a
splitter. **Expect**: Paris maps whole perimeter blocks as single relations in
places; Tokyo splits fine. A party-wall splitter is future craft work.

## 3. Block derivation starves in superblock fabric

Schiedam: 9% of buildings fell outside every block face. London: 48% (227 of
473) — fewer residential through-streets, a footpath-heavy graph, and vast
post-industrial parcels. The orphan fallback (footprint parcels) kept every
building ownable, so the world works, but orphan parcels have no yard, which
depresses expand/develop on exactly the stock that has the most room.

**Expect**: Tokyo worst of the four (the §31.6 prediction says its parcel
derivation produces the strangest output — shitamachi superblocks with
internal alleys are this failure mode squared). Brooklyn's grid should be
kindest.

## 4. Heights are a minority signal outside NL

London: 21% of buildings carry `height` or `building:levels`; the rest are
estimated from purpose and footprint area and say so (`heightSource:
'estimated'`, rolled up in the manifest's `importHealth.heightsReal`).
Estimation is deliberately dumb (terraces 2, sheds 1, flats scale with
footprint) — a wrong flat estimate is visible and correctable, a clever one
calcifies.

**Expect**: Paris better (BDTOPO could restore tier-1 heights later), US
patchy, Tokyo poor.

## 5. Years are absent, so the era gate could not survive

`importHealth.yearsPresent` = 0.00 for London against NL's 1.00. The era gate
(§18.4's acknowledged proxy: pre-1945 stock cannot expand) had nothing to
read, so the rework it was always a placeholder for landed: everything is
expandable and added floors on inherited stock earn at the structure's fabric
quality — year-sharpened where years exist (1909 shells discount deeper than
1975 ones), generic old-fabric discount where they don't, par for agent-built.
The gate is gone from the engine.

## 6. Provenance must be assembled, not assumed

The first London render carried a panel claiming 3DBAG and AHN over a chunk
built from neither — the provenance block was written once against the NL
sources. §21.4 applies to provenance too: it is now assembled from what the
import actually used, and the substrate line says "flat datum (no national DTM
wired for this country yet)" in so many words.

## 7. Recurring characters follow the fabric

Sietse and Roosmarijn redeveloping Deptford broke the fiction §15's recurring
characters exist to carry. Name pools are per-country on the chunk now (NL
fallback). Brooklyn, Paris and Tokyo need pools before import — one list each,
minutes of work, but it has to be on the checklist or Margriet buys the
Marais.

## Carried, not fixed

- Terrace-row splitting (entry 2) — party-wall geometry, real craft work.
- UK tier-1 valuations (Land Registry price paid) — would raise London from
  `gdp-proxy` to `national-valuation` in the coarse layer, which §32.2 makes
  the emergence-grade bar.
- DEFRA lidar for a real London DTM — the probed WCS endpoint 404s; Thames-side
  is near-flat so the flat datum is tolerable, and the seam takes a DTM without
  code changes when one is reachable.
