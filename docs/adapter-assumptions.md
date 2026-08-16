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

§37.2 composition run (gated, 8 paired seeds, instrument committed with its
pre-registration ahead of the measurement): absolute completed chains fell 18
-> 10 median (7 of 8 seeds down, one up +9), so the fall is real and not the
denominator artifact half of the prediction. The pre-registered ground split
is structurally uninformative on the control: a completed chain requires
standing stock by definition (assemble -> demolish -> develop), 82% of
parcels carry stock the §34 formula marks conversion-preferred at day 0, and
both cells that should discriminate are empty in both arms. What the numbers
do show: the entire decline sits on ground where conversion is strictly the
better project by the artifact's own formula, conversions rose 790 -> 1103
per run where chains fell 8.5, and under the gated ruler chain sites were
already high-value before the third use (1.16x median, 1.13x after) — the
ungated smoke had shown the 0.69 -> 1.07 migration, meaning the boundary gate
had been carrying the low-value chain population. Mechanism evidence is
substitution along the price, consistent with honest price; the clean
signature §37.2 asked for cannot be produced on this fabric. Verdict:
UNDERDETERMINED by the pre-registered split; the call stays with the
operator. London's vacant-superblock fabric would not populate the empty
cell either — the chain definition itself binds completions to standing
ground. The KNOWN stays loud in tune.ts until the call is made.

## 2d. London's admission FINDING named: capital-scale dark plus stochastic churn

The §37.3 suite flagged london (measured dark 20.0% vs predicted 0%, gap
20 pts; schiedam admitted at 13.1). dark-rank.ts read the offered surface on
the stable-dark set with a pre-registered prediction — bottom rank quartile,
split pieces overrepresented 1.5x — and falsified both: london's stable dark
sits mid-rank (median cap percentile 0.46 vs touched 0.56, only 28% in the
bottom quartile) and split pieces underrepresent at 0.16x. The signature is
size: stable-dark median 328 m2 against touched 49 m2.

The schiedam calibration run reframes the finding. Stable dark is 9.1% on
BOTH chunks — the permanent dark class is the same size as the control's,
skews large on both (168 vs 67 m2 there), and london's is genuinely mid-rank
big stock: rate-viable, rank-competitive, enumerated at 127% of touched,
never affordable — project capital beyond any agent's reach. The 7-point
admission excess over the control is almost entirely stochastic: which
mid-size stock rotates dark varies by seed (schiedam ~4 pts of per-seed dark
above its stable core, london ~11).

Answer to the question as posed: new dark stock the predictor cannot see —
a capital-ceiling class plus a stochastic budget-allocation band, both
invisible to a feasibility test by construction, not a uk-miscalibrated
predictor. Consequence for §37.3: the predicted/measured gap conflates a
constant structural class with a fabric-dependent stochastic band; whether
predicted dark should be re-specified against stable dark only is an
operator re-registration decision. London holds at the gate until that call.

Brooklyn is the third data point and the sharpest: admission FINDING at
23.9 pts, and dark-rank names it the same way, stronger — stable dark 12.7%
sits ABOVE touched stock in day-0 cap rank (median percentile 0.60 vs 0.47,
only 12% in the bottom quartile), zero split pieces ever stably dark against
36.2% of stock, median 136 m2 vs touched 48, and access correlates negative
(-0.145): high-rate big waterfront assets a rate-ranked score loves and no
agent can capitalise. Across three fabrics the structural dark class is
never the rank tail — the §37.3 gap metric is measuring the capital ceiling
plus the budget floor, and both chunks hold at the gate on one decision.

## 2f. Paris: the capital ceiling at its deepest, and 71 refused relations

The §41.2 admission flagged paris at 15.6 pts stable dark (94 buildings,
6/6 seeds) — the only chunk whose stable core alone exceeds the threshold.
dark-rank names the same mechanism as london and brooklyn, at its strongest:
stable dark sits at median cap percentile 0.64 against touched 0.44 (the
sharpest rank inversion of the four chunks), 12% in the bottom quartile,
split pieces underrepresenting at 0.55x, median area 245 m2 vs touched 41.
The fabric explanation: the radial cut's atomic unit is a 15 m slice of a
six-storey mansard block — even split pieces are institutional-scale
capital, so the capital-ceiling class is structurally larger here. The
ceiling-watch evidence (dynasties reach the class by gen 4-5 at 3x budget on
brooklyn) says the class trades in longer runs. Paris holds at the gate on
the operator's accept, mechanism named; enum ratio 216% — the most
enumerated-never-chosen stock of any chunk.

Also recorded: 71 multipolygon relations refused at ring stitching (counted,
never silent). Expected causes: outer ways clipped by the fetch bbox at the
chunk edge, and multi-part buildings. These buildings never enter the
ownable denominator — the §33.1 silent-shrinkage caveat applies, so the
count stays in the import log and here. The 32 perimeter blocks that did
split radially conserved area within the asserted ±4%.

## 2g. Tokyo: both predictions land, and the ceiling inverts with the grain

The strangest-parcels prediction confirmed measurably at both sizes: 70% of
parcels vacant, 288 self-intersecting candidates dropped, one block per
building at the first radius — the alley grain defeats face derivation, and
the orphan-synthesis fallback carries the fabric. The §2 ratio check failed
at 300 m (253 buildings) and its instruction was followed before anything
was tuned: 400 m gives 446, in band. The axis prediction confirmed too:
peak share 4.5% against the 6% bar, the top four directions within half a
point of each other — genuinely axis-less fabric, north cut final. Both
§31.6 axis predictions therefore landed as registered (brooklyn cleared at
21.4%, tokyo failed at 4.5%).

jp osm carries essentially no height signal here (tag match 1 of 409);
heightSource is estimated chunk-wide and the manifest says so. Income-only
viability 35.4% — the deepest conversion dependence of the five.

Admission under §41.2: ADMITTED, stable dark 2.9% (11 buildings). The
capital-ceiling reading completes a five-chunk arc: fine-grain fabric has
almost no ceiling class (4 buildings — but median 2,501 m2, enumerated at
323% of touched, the most extreme enumerated-never-chosen anywhere), while
the perimeter-block fabric (paris) has the deepest. The ceiling is a
property of the fabric's atomic capital unit, exactly as §41.3 framed it.

## 2e. US data carries no construction years (§18.4 note, recorded at import)

What the year signal feeds: startingCondition (flattens to 0.7 without it),
fabricQuality (flattens to 0.78), and the pre-war demolition cinematic bonus
(+12, never fires). Brooklyn's measured behaviour without it: the action mix
holds against the control — renovate 25.4% vs 24.1%, convert 21.4% vs 23.8%,
expand 25.2% vs 25.3% — because decay dynamics regenerate the condition
gradient in-run; the §18.4-rework pricing carries the asymmetry without the
year. What is actually lost: day-0 condition uniformity (no worst-stock-first
targeting in the first generation) and the old-fabric demolition drama class.
Assemble runs 8.9% vs 3.5%, fabric-explained the london way: vacant
waterfront superblocks. heightsReal 0.989 — the nyc doitt osm import carries
measured heights, so the planned microsoft heights source is redundant for
this area and stays unbuilt until a us area without that import shows up.

## 2h. §42.2 landmarks: what the five extents actually carry, and the cost

The classifier found churches and historic stock only: no gasholder, crane
or station is mapped inside any of the five extents, and kyojima's pocket
shrines carry no osm tags at all — the bespoke silhouettes (gasholder drum
in its guide frame, tank on shaft, mast and jib, glazed-ridge shed) are
wired and harness-proven but wait for fabric that carries them. Linear
landmarks landed where promised: 38 rail lines on deptford, the petite
ceinture (16) and the ourcq basin (2) on paris, 8 canal lines on schiedam.

Untouchable lists: one principal anchor per chunk, hand-picked from the
flag logs and verified in the artifacts — Sint-Jan-de-Doperkerk, St Luke's,
Red Hook's tall church mass, Saint-Jacques Saint-Christophe. Tokyo's list
is empty because nothing is flagged.

The control suite passes after the economics change, with the cost stated:
completed chains per run moved 8 -> 7, landing exactly on the §41.1 floor
(five schiedam churches now price at 2.2x and one parcel left the market),
and agent-built-on-consolidated-ground slipped to 7% against its 10% KNOWN
bar. Neither is retuned here; the bar sitting at its floor is worth the
operator's eye before anything else leans on the chain economy.

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
