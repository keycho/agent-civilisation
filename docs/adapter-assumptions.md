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

## 2. One OSM way is not one building — DECIDED: split (§33.2)

UK convention maps whole terrace rows as single ways. Inherited, that
pre-assembles the street: an agent buys 30 dwellings as one asset, one
conversion recolours 100 m, and §22.1's grain metrics measure the dataset's
habit instead of the world.

Decision (build 10): rows are split at estimated party-wall intervals — 5.2 m
typology frontage along the OBB long axis, exact clip against the real
footprint, whole-row fallback if any piece degenerates, area conservation
asserted ±4%. London went 473 -> 791 buildings; the pieces flow through every
geometry canary. "Assembly of a terrace should be work, not a data gift."

**Expect**: Brooklyn brownstone rows get the same treatment. Paris perimeter
blocks mapped as single relations are a harder version of the same problem —
the splitter's slab approach does not generalise to courtyard rings and Paris
may need its own cut.

## 2b. Orphan synthesis is the answer to the orphan question (§33.1)

What does the sim do with a building whose parcel derivation failed? It
synthesises a fallback parcel around the building's own footprint (1.2 m
outset, footprint-exact where the outset would cross a carriageway). Nothing
is excluded: London's ownable/imported is 791/791 = 100%.

Canaried at the artifact (§21.4): synthesised parcels stay building-sized
(worst 3.31x against a 3.5x bound) and must contain their building — probed by
vertex containment with 0.5 m boundary tolerance, after the first probe
(centroid) fired on a concave wharf shed whose centroid lies outside its own
footprint. The manifest carries `ownableShare` with a 97% floor asserted at
import, mirrored in REGION_RULES.minOwnableShare: a chunk below it does not
join the region world.

## 2c. The dark mass: measured, adjacency ruled out, cause open (§33.1)

The §18.2 instrument on London, six seeds at the frozen budget: 44% of the
chunk is untouched in EVERY seed (Schiedam: 3%), pairwise Jaccard 0.75
against Schiedam's 0.58-0.67, and the always-dark set is 79% orphan-parcel
against a 60% base rate — with access correlation r = 0. Under §18.2's own
rubric that is a reachability gap, not periphery: London's offered surface is
computed over roughly half a market that LOOKS whole (ownable/imported =
100%).

The first hypothesis — the adjacency builder's same-block gate making
synthesised parcels invisible to relational scoring — was repaired and
A/B-measured: untouched orphan share moved 86.0% -> 85.8%. Falsified. The
repair stays (a synthesised parcel should neighbour what it touches, and the
control is unaffected), but the cause is still open. Remaining suspects, in
order: candidate enumeration (how for-sale stock surfaces in observations),
and small-asset economics (median split piece is 54 m² — it may never win a
rank against any alternative under Schiedam-tuned constants).

RESOLVED (build 11, §34): the mechanism is named and priced. The dark stock's
net yield was negative in its current use — maintenance beats rent at this
granularity — and its best use was a different purpose, which the acquisition
score could not see: §21.1's max() expressed income and clearance but not
conversion. The third use now enters the max (conversion rate over price plus
conversion cost), and the dark mass collapsed 44% -> 8% with the same
instrument; the 20-seed control suite is green under the new score. The §34
step-2 prediction (terrace split manufactured it; min-piece fix) was
falsified by the unsplit counterfactual (42% dark) before the mechanism was
found. The manifest now predicts this class at import: `viableIncomeOnly`
49.8% for London — the number that would have flagged the half-dark market
before any seed ran. London's region-world seat is unblocked from this gate;
it still requires its own full suite pass like any chunk.

Trade-off flagged for the operator, caught by the pre-registered §30.2 bar:
pricing conversion into acquisition reallocated the decision budget — chain
completion flow fell 5.3 -> 2.4 per 10k on the control while conversions
boomed. Whether that is crowding-out to correct or the honest price of a
fuller market is a design decision, held as a loud KNOWN until made.

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

## 8. "Cut along the fabric" was a single-axis assumption (§33.3)

Schiedam's 45.4° axis carries 8.7% of road length; Deptford's best (86.6°)
carries 3.5% against a uniform 1.1% — riverside curve plus three grids. A
forced rotation to a weak axis is noise presented as intention, so the rule
now has a threshold: rotate only when the peak bin carries >= 6%
(CUT_PEAK_SHARE_MIN); below it, cut north-aligned and let §24.1's width
framing absorb the shape. London is north-cut with the measurement kept as
the record.

**Expect**: Brooklyn has a real grid (likely above threshold); Tokyo
shitamachi is likely multi-axial like Deptford.

## Carried, not fixed

- ~~UK tier-1 valuations~~ — done (build 10, §33.4): HM Land Registry UK HPI
  average prices, OGL v3, joined by exact local-authority name. London 1.508
  on reals against Burnley 0.323; 128 GB candidates at tier-1. France's DVF is
  the same move for Paris.
- DEFRA lidar for a real London DTM — the probed WCS endpoint 404s; Thames-side
  is near-flat so the flat datum is tolerable, and the seam takes a DTM without
  code changes when one is reachable.
