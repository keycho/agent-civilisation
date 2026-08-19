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

## 9. The region's constants come from the economy's own scales (§31.6-5)

Three dimensional faults were caught by measurement before the first region
run, none of them visible in the code alone:

- **The §28.1 estimate was anchored on day-0 stock yield** (~0.02/yr), which
  sits 8x below what a live market realises (~0.15/yr at the frozen budget,
  measured across the five adapters). Every gap read negative and migration
  was structurally impossible — not lossy, wrong in scale. The advertisement
  now anchors on the mature market's achievable (ESTIMATE_REF_YIELD 0.15,
  provenance in region.ts); the §28.1 loss stays in the value-index
  distortion, the blindness to fine reality, and the lag blend.
- **Liquid capital cannot fund anything here.** Mid-run capital median is 0
  and the bottom third is in debt — wealth is holdings; cash is a
  through-flow. So "the bottom third of local realised yield" selects
  holdings-empty agents (own realised yield exactly 0), and the move is paid
  through the economy's own affordability primitive: availableFunds admits
  it, spend() draws cash then credit, and the loan rides the migrant's own
  ledger to the destination. seedCredit (1200) is what makes an NL hop
  (~510 with the gate) affordable and Tokyo (~22k) prohibitive — §28.3's
  cheap-inside-the-constellation, expensive-intercontinentally, priced by
  the facility rather than asserted.
- **An annual rate and a one-off cost are incommensurable without a
  horizon.** The test is now est x HORIZON_YEARS x funds >= cost x margin,
  with the horizon (10y) read off the measured run: 34k decisions span ~22
  years and ~2 generations, so a life is ~10-11 years.

Also §28.3's warm slot: warming CONSTRUCTS the sim and nothing more — a
warmed chunk does not tick, its residents are frozen, and only a migrant
paying the gate opens the world. The first draft woke 58 native agents off
a cache hint; the contract's own wording ("materialised, ticking") is what
caught it.

**Pre-registered for the first region suite** (alongside the contract's
schiedam-first-origin and winner-not-leader bets): the warm slot goes to
maasland-dorp in most seeds (highest NL valueIndex, 1.244 via the
Midden-Delfland WOZ join); migrations stay intra-European with
schiedam->london the modal long hop; reversals land above zero through the
fresh-chunk disappointment path (day-0 realised undershoots the
advertisement until a gated chunk matures). Honest doubt, stated: the
within-country activity winner rides CUMULATIVE applied actions, which
favours the mature control — if no NL challenger ever out-activates
schiedam in 2 of 8 seeds, that assert fails and the finding is that the
§43.2 world needs activity RATE, not that the bar was wrong.

## 10. The NL constellation through §41.2 — and the ceiling's deepest fabric

All three joined at 100% ownable. maasland-dorp ADMITTED (stable dark 5.1%,
gap 5.1 pts); maassluis-haven ADMITTED (5.0%, gap 5.0). vlaardingen-westwijk
is a FINDING: stable dark 25.7% against predicted-unviable 0.0% — a 25.7 pt
gap, deeper than paris's 15.6. Dark-rank names it the KNOWN capital-ceiling
mechanism, sixth fabric: dark stock sits mid-rank (cap percentile 0.54 vs
touched 0.49, 22% in the bottom quartile — not rank-tail), dark median area
311 m2 against touched 48 m2, zero split pieces. Postwar slab modernism is
the ceiling maximised — the fabric is MADE of large-area stock that is
rate-viable and never affordable within a life. The arc now reads: fine
grain (tokyo) no ceiling, perimeter blocks (paris) deep, slabs
(vlaardingen) deepest. Per §41.3 the ceiling stays logged, not built;
the finding holds for operator accept, as paris's did.

## 11. The first region run (§31.6-5, 8 seeds, contract as registered)

10 of 11 asserts green; every statistic reproduced exactly across two runs
(seed-determinism held through the instrument correction). The record,
against the pre-registered predictions:

- **First migration origin: schiedam, 7/8 seeds** (london once) — §31.6's
  prediction confirmed, but only after an instrument fault was fixed: the
  report sorted by chunk-LOCAL ticks, and a late-gated village's tick 300
  outsorted schiedam's tick 2000. Cross-chunk clocks are not comparable;
  the region's own event order is. (Re-registered, instrument only.)
- **Warm slot -> maasland in 8/8** (highest NL valueIndex via the WOZ
  join); gated by real migrants in all 8. maassluis gates in 4/8, so the
  materialised set varies. vlaardingen — the slab chunk, third-best
  estimate — is never reached at migration's §30.5 cadence.
- **Winner-not-leader (§28.5): landed 5/8.** The village of Maasland
  out-activates the mature control on cumulative applied actions in five
  seeds — the ledgered doubt (maturity favours schiedam) was wrong; the
  migration-fed frontier is simply that active.
- **All 34 migrations intra-European, national-valuation destinations** —
  brooklyn and tokyo priced out by the facility exactly as the transit
  anchoring intended. Emergence-grade under §32.2: every one.
- **Reversals: 0 across 8 seeds.** The §28.1 report line says it plainly:
  0 means the estimate reads too accurate. Mechanism look: destinations
  DELIVERED — migrants plant within the grace window (holdings non-empty
  = reversal-ineligible) because village stock is affordable on arrival
  funds. A watch item, not a pass: if reversal never fires across future
  suites, the estimate's stated loss is not binding and §28.1 wants a
  look.
- **Region Moran 0.1868 vs control 0.1453 (1.29x)** — clears the 1.25
  spectacle margin, same instrument same run. Chain flow region-wide
  13.5/10k vs the single-chunk ~2.1: the region multiplied chain flow
  ~6x. No chunk drained; abandonment stays untested and unbuilt (§30.5).

**The one failure, escalated as registered: §43.2.** The most-contested
chunk's chain rate medians 5.5/34k against the floor of 7. Two findings
under it, both for operator decision:

1. The chain economy is emphatically NOT structurally marginal — it is
   ravenous exactly where migration concentrates capital: maasland runs
   58-188 completions/34k, maassluis 148-293, london 17-34, all far above
   the floor. Schiedam — mature, compressed, chain-exhausted across six
   prior builds' equivalents — runs 1-22. Capital concentration and
   bidding pressure point at DIFFERENT chunks: migration flows toward
   affordable supply, which is by construction where per-cell competition
   is low.
2. The ranking instrument cannot see this: contest (competitionMedian)
   reads 1.00 in every materialised chunk at end-of-run — terminal
   saturation, the same effect §29.1 documented for pricing, which is why
   offered orderings are measured at half budget. "Most-contested" at
   end-of-run is an argmax over ties resolved by insertion order. If
   §43.2 is to be measurable, contest must be sampled mid-run like the
   §29.1 pricing read — that is a re-registration only the operator
   makes; until then the failure stands as recorded.

## 12. The §44 re-registered run: contract green, the zero sharpened

Same 8 seeds under the §44.2/§44.3 contract — every prior statistic
reproduced exactly, and the re-registered assertions passed with room:
migration-destination chunks' chain rate medians 75.0/34k against the
floor of 7, and concentration is 75.0 vs 11.4 for the rest of the region.
The §43.2 question is closed in both directions: the chain economy is not
structurally marginal, and it concentrates precisely where migration
delivers capital.

**§44.3 answered: the zero is honest.** The would-have-reversed set is
nonempty in every seed (4,1,2,3,1,1,2,2 — 16 of 34 migrants sat below
their origin's realised yield at grace-window end and stayed because they
planted). The commitment device is doing real work; §28.1's estimate is
lossy enough for failure to be visible, and reversal-zero can be trusted.

One instrument note, escalated not patched: contest sampled at the
half-budget point still reads 1.00 in all 64 chunk-samples. The live-cell
competition MEDIAN is structurally pinned — §27.5's own print shows the
distribution bimodal (p10 0.00, p90 1.00) — so the kept rate-vs-rank
report cannot rank at any sampling time. A discriminating version needs
the live-cell MEAN (the 0/1 mix share); that is a further re-registration
for the operator. The §44.2 assertions themselves no longer depend on
contest, so nothing asserted rides on this.

**§44.4's extreme fixture, baselined.** Ceiling-watch on vlaardingen at
3x budget: seeds touch 4/43 and 2/43 ceiling candidates (5-9%), against
brooklyn's 38/51 and 45/51 (75-88%) at the same setting. Slab fabric
does not self-solve at this horizon — dynastic capital reaches the class
almost nowhere — which is precisely why it holds the §41.3 longitudinal
watch: if accumulation ever reaches vlaardingen's slabs, the ceiling has
closed everywhere free; until then syndication stays a live later
mechanism decision, still unbuilt.

## §13 — §57.1 pace, measured on production before setting it

The block premise: "a demolition that takes 200 ticks completes in under a
second of wall time... measure first, then set it. If it is under ~20 seconds,
the pace is the product bug."

Measured against live production (`tools/watch/pace-measure.mjs`, THROUGHPUT
index 2 = `normal`, 14 decisions/s target), 240 s per chunk and a 90 s repeat:

| chunk    | construction start→complete | demolition start→complete | events/s | notable/s (w>=20) |
|----------|-----------------------------|---------------------------|----------|-------------------|
| tokyo    | n=59 median 40.9s (p10 30.5, p90 55.8) | n=252 median 12.9s | 16.22 | 11.97 |
| schiedam | n=7  median 36.7s (p10 28.7, p90 51.2) | n=42  median 12.1s |  11.85 |  9.37 |
| maasland | —                            | n=7 median 10.6s          |  0.69 |  0.51 |
| brooklyn | —                            | n=2 median 16.0s          |  1.61 |  1.10 |

Against §57.1's four targets:

- construction 30-60 s wall clock — **already in target** (36.7-40.9 s median)
- demolition 10-20 s — **already in target** (10.6-16.0 s median)
- notable events 1-3/s chunk-wide — **3.5-5x over** in the two busy chunks
- a generation in minutes — generations 1-3 after 6.5 h uptime, so in *hours*

So the premise is not what the world is doing. The visual events a human is
meant to watch are already paced for watching; a demolition takes twelve to
sixteen seconds, not under one. **THROUGHPUT is not changed.**

The finding that matters is that the four targets are **jointly unsatisfiable
by THROUGHPUT alone**, and the arithmetic says so directly: bringing 10.4
notable/s down to 3/s is a 3.5x slowdown, which drags the 39 s construction to
~136 s — more than double the 60 s ceiling the same section sets. One dial
cannot land both. Pace governs how long an event takes; it cannot govern what
fraction of events are worth showing.

That second quantity is measurable too, and it is the actual defect. Weight
distribution over 1166 tokyo events:

    >=10  100%    >=20  80%    >=30  43%    >=50  26%    >=70  18%    >=90  8%    max 96

"Notable at weight >= 20" therefore selects **80% of all traffic**, which is not
a selection. The mix explains it: building_expanded 28%, building_converted
22%, parcels_assembled 11%, building_renovated 9%, district_formed 8%. Six in
ten events are the routine tidying §60(d) names.

§60(d)'s own list — assemblies, demolitions, developments, landmark actions,
deaths, migrations, ignitions — is about 22-25% of this mix, which puts the
default feed at **~3.1 notable/s**, landing on the 1-3/s target almost exactly.
The spec already contains the correct mechanism for the one target that is
missed; it is a selection change, not a pace change.

Caveats stated: this is a 6.5-hour-old world at generations 1-3, and the pace
varies 23x across chunks (tokyo 16.2 events/s against maasland 0.69), so some
chunks have gone quiet while others churn. The construction estimate rests on
n=59 for tokyo; the schiedam construction sample is thin (n=7) and agrees.

## §14 — §58 escalation, and the axis it was first keyed on

Three findings, in the order they came back.

**1. The generation axis has a range of about four, and a season resets it.**

§58's first implementation gated ambition on dynasty depth: 8 levels at
generations 1-2, 14 at 3-5, 28 at 6+, which is the natural reading of "ground
a dynasty spent generations gathering". It fired the ambitious option 197
times in a full schiedam run and won zero of them, and the untouched share
came back bit-identical to the pre-escalation control (21.3%), which is what
a mechanism that never executes looks like.

The reason is structural rather than a constant being wrong. A season turn
constructs a **new `WorldService` from the same seed** (`server/main.ts`
`newSeason`), so every lineage resets to generation 1 with the buildings.
Within one season the median living lineage reaches **generation 2** and the
deepest single lineage reaches **4-5**; at 3x budget the deepest reaches 5.
Production agrees and is the stronger evidence — every live chunk reports
generation 1 or 2 while sitting at seasons 31 to 121, so tokyo has reset 120
times without a dynasty ever getting past its second heir.

So the third tier was unreachable, the second covered 13% of develop
decisions, and 94% of the time the branch was reached the agent was in the
tier where §58 deliberately changes nothing. **`gen 8` is not a horizon this
world has.** The generation key was removed; it is recorded here rather than
quietly dropped.

**2. Slenderness, measured, replaces the tier table.**

What survives is the branch itself: `chooseLevels` only ever asks what the
next floor is worth, and a scoring function restricted to that question can
never decide to build a tower. The ceiling on the ambitious option is now the
site, and the site's limit came off the imported fabric — height over the
square root of footprint, across all 5,458 buildings in the eight chunks:

    p50 0.99    p90 1.63    p99 3.13    p99.9 9.46    max 10.46

`SLENDERNESS = 3.0` is that p99: an agent may build as slender as the top one
percent of what actually stands in these cities and no slenderer. The tail
above it is spires and one 81 m London point block on a 74 m2 base.

The consequence is the part worth having. A 76 m2 schiedam lot carries seven
levels however rich its owner; 200 m2 carries twelve; 600 m2 of assembled
ground carries twenty-one. **Height needs ground**, and it falls out of the
measurement instead of being asserted. Capital is still the harder gate — a
21-level building on 600 m2 costs about 22,000 against a measured end-of-run
`availableFunds` of median 269 and max 2,672.

**3. The delta §58 is answerable for: -1.1pp of untouched grey.**

The §58.6 guard was pre-registered at a 25% floor before the mechanism
existed, and **it failed at 21.3% with escalation absent** — across five seeds
15.5/19.7/19.9/21.3/21.3, median 19.9%, none reaching the floor. The absolute
level is therefore a pre-existing property of the economics and not
attributable to §58. Only the delta is, and `escalation-watch.ts` measures it
paired, both arms in one process against identical seeds via the §37.2 toggle
idiom (`ESCALATION.on`):

| seed | off | on | delta |
|------|-----|----|-------|
| seed-escalation-guard | 21.3% | 18.9% | -2.4pp |
| spread-0 | 15.5% | 15.7% | +0.2pp |
| spread-1 | 21.3% | 20.9% | -0.3pp |
| spread-2 | 19.7% | 16.3% | -3.3pp |
| spread-3 | 19.9% | 18.8% | -1.1pp |
| **median** | **19.9%** | **18.8%** | **-1.1pp** |

Escalation costs about one percentage point of grey and buys 5 of 72 agent
builds above the marginal cap, topping out at 11 levels on 136-269 m2 sites.
The guard stays red and stays at 25%; moving it to fit is the hill-climb §18
exists to catch, and the number it would have to move to is set by economics
§58 did not introduce.

**§58.4, verified: the setback tower is selectable in every chunk.** One seed
each, counting `agent_tower` selections at §16.1's 26 m threshold —
schiedam 68/81, vlaardingen 20/39, maassluis 68/106, maasland 67/118,
london 29/62, paris 45/61, brooklyn 24/55, tokyo 26/63. Tallest 42 m
(london), 35-39 m elsewhere.

**§58.2's capital-ceiling question, answered: the ceiling does not open, and
syndication stays a live mechanism decision.** Ceiling watch on vlaardingen
(the deepest ceiling of the five fabrics) at 3x budget with escalation live
touches 3/43 and 1/43 across two seeds, inside — at the low end of — the
4/43 and 2/43 the same instrument recorded before escalation existed. Both
seeds reach generation 5. §41.3 asked whether the assets start trading by
gen 8-10 in longer runs; finding 1 says that horizon does not exist, so the
question cannot resolve the way §41.3 hoped. Unbuilt, as it was.

## §15 — §65, where the city is, and one wrong measurement on the way

The operator's hypothesis was that the camera targets the chunk's local-frame
origin while the plate's geometry is not centred on it — origin at a corner,
or at a bounding-box min — so every reset aims correctly at the wrong point.

**The hypothesis is false, and the data says so precisely.** `chunk.localBounds`
IS the building footprints' bounding box, to the metre, in every chunk:

| chunk | metadata half | footprint half | footprint centre |
|-------|---------------|----------------|------------------|
| schiedam | 299 x 301 | 298 x 301 | (12, -17) |
| london | 416 x 420 | 416 x 419 | (2, 6) |
| brooklyn | 399 x 377 | 399 x 376 | (1, 2) |

The fabric's centre is within 17 m of the origin everywhere. And the symptom
did not reproduce: five cities at six viewports from 1280x800 to 3440x1440, on
an untouched first load with nothing snapped, framed the city centred every
time (`tools/watch/probe-frame.mjs`).

**One measurement of mine was wrong and produced a table that looked like
confirmation.** A first pass measured the SCENE GRAPH's bounding box and
reported the metadata understating the city by 19-146 m. The scene graph
includes the road meshes and the plate itself, so it was measuring the plate,
not the city. Acting on it — deriving the extent from every coordinate in the
seed — blew the plate out to 2247 m across, because the imported road graph
runs far past the chunk: schiedam's nodes span ±1025 x ±987, brooklyn's
±1843 x ±1499 about a centre 818 m away. At that point the camera really was
aimed at empty ground, by my own hand. **Roads are not the city.** The extent
is measured from footprints and parcels, which agree with each other and with
the metadata.

**What the interactive verification did find is real, and it is the operator's
symptom.** §62's target bound was the fabric's footprint, and the §62.2 fuzz
agreed for four seeds. Seed 11 found the hole: at the minimum distance,
near-horizontal, with the target legally parked on the fabric's CORNER, the
frame contains two street trees and a lamp against black. The target was on
the city and the city was still not on screen, because a camera looking
outward from an edge sees what is past the edge.

So the bound is not the fabric — it is the fabric inset by how much ground the
shot can see, `distance * tan(fov/2)`, capped at the half-extent. At street
level that is ~15 m of inset and a viewer may roam almost the whole city; at
the whole-city framing it exceeds the half-extent and the target pins to the
centre, which is what "the plate is always framed whole" means for the city
and is the same rule §57.3 gives the map.

  seed 11, 6 sequences   before: 1/6 sequences violate, worst coverage 3.55%
                         after:  0/6, worst 8.88%

Swept, after the fix — six seeds, 42 randomised drag/scroll/rotate sequences,
about 2,000 frames each asserted for fabric coverage and for target, pitch and
distance inside the rig's own limits:

| seed | sequences | frames | worst coverage | violating |
|------|-----------|--------|----------------|-----------|
| 3  | 8 | 487 | 7.10%  | 0 |
| 5  | 10 | 562 | 11.83% | 0 |
| 11 | 6 | 354 | 8.88%  | 0 |
| 17 | 6 | 270 | 7.10%  | 0 |
| 23 | 6 | 415 | 7.69%  | 0 |
| 29 | 6 | 299 | 13.02% | 0 |

Worst instant across all six is 7.10%, comfortably above the 4% floor, and the
floor itself was set against the older plate-mesh metric — the fabric metric it
now runs against is the stricter one.

The centre and extent now come from the measured fabric anyway, and the
§62 clamp carries a centre rather than assuming the origin. It buys a 12-17 m
correction that nothing visibly depended on — kept because a constant that
happens to agree with a measurement is still a constant that can stop
agreeing when an importer changes.

**§63.4's readouts attach correctly.** Every mark falls inside the fabric box
and the local-to-world transform is exact (`local (192.29, 245.69)` renders at
`world (192.3, -245.7)`). A readout over apparently empty ground is a site
being CLEARED, which is what the feed line beside it says.

## §16 — §66.3, where "framed" was still measuring "not lost"

The §66.3 bars were raised from a 4% free-camera coverage floor to 40%, plus a
60% floor on the home framing and a 5%-of-screen centroid radius. The run passed
at 41.42% worst coverage over ten sequences and 662 asserted frames.

**The contact sheet the operator asked for in the same message falsified it.**
Three of the ten frames were unpostable:

| frame | what it is | coverage said |
|---|---|---|
| seq 2 | bare olive ground, one silo, two dark mounds | ~100% |
| seq 6 | a flat unlit surface, city only at the far edge | above the floor |
| seq 7 | the lens pressed into a window wall, one facade filling two thirds of frame | above the floor |

Both causes are mechanism, not calibration:

**(a) coverage counted ground, not city.** The metric cast rays at the ground
plane and asked whether they landed inside the fabric's bounding BOX. Schiedam's
port district is largely yard and water, so a frame of empty dock scored full
marks. Raising the number from 4% to 40% moved the threshold and never touched
what was being counted.

Corrected to a built-occupancy grid rasterised from the footprints themselves
(6 m cells, interiors by cell-centre point-in-ring plus a walk along every wall
so a 6 m terrace cannot fall between two centres). The built share of each
fabric bbox is a minority everywhere, which is why the count had to change:

| chunk | grid | built cells | share of bbox |
|---|---|---|---|
| schiedam-havens | 102x102 | 5351 | 51.4% |
| brooklyn-redhook | 134x127 | 5817 | 34.2% |
| london-deptford | 140x141 | 4963 | 25.1% |
| tokyo-kyojima | 146x139 | 4789 | 23.6% |

A per-ray built metric would therefore cap a PERFECT london home framing at
25%, under a 60% floor — so the score is by TILE: the viewport is divided into
6x6, and a tile counts when any of its 16 rays finds something standing. That
asks whether the frame is full of city rather than how dense the city is, which
is the question the bar was always trying to ask.

**(b) the rig let the eye enter buildings.** Every camera invariant to this
point bounded the TARGET — where the camera points, what is on screen, how much
of the frame it fills. None of them said anything about where the eye is, and
seq 7 is a legal state with the target on the fabric, the coverage over its
floor, and the lens inside a facade. The rig now keeps the eye 7 m above the
tallest roofline within a distance-scaled neighbourhood (6-40 m), enforced every
frame on both the desired and the damped state, by pitching toward vertical —
which raises the eye and leaves the target exactly where the viewer put it — and
backing the lens off only if a plan view still cannot clear.

**Also found, unrelated and pre-existing:** `panHalfZ` was assigned from the
fabric and then immediately reassigned from the plate half-extent on the next
line, so the north-south pan bound was the plate's and the east-west bound was
the fabric's. Deleted.

## §17 — §66.1, and an instrument that reported a still camera as moving

The first §66.1 acceptance reported the opening dwell broken: "first move at
4.2 s" against a required 8-10 s. Tracing the rig at 10 Hz for twenty seconds
showed target and distance CONSTANT throughout and polar settling by 0.015 rad
— 0.86° — over the first two seconds. The harness had weighted raw polar by 400
to make it commensurate with metres of target travel, and 0.014 x 400 = 5.6
crossed a threshold of 2. The exchange rate was invented and the finding was an
artifact of it. The check now projects the fabric's own corners and measures
their displacement in pixels, which needs no exchange rate.

Two real things came out of the trace anyway:

- the 0.86° settle was the damping walking the pitch in from the rig's
  constructor default, because a plain load flew to the framing with a 0.01 s
  duration rather than snapping to it. A hold that is specified as motionless
  should be motionless; plain loads now `home(..., {snap:true})`.
- §46.4's 2.6 s opening gate and §66.1's 9 s dwell were two mechanisms doing one
  job, and they STACKED — the dwell only counts down while the director is
  enabled, so the first intent landed at 11.6 s, past the 8-10 s asked for.
  §46.4's gate is retired; the dwell is the whole hold, and it drops the
  director's queue on every frame it holds, which is the protection §46.4
  existed to provide.

## §18 — §67, what the migration record did not carry

`world/region/migrations.json` records `agentId`, `fromChunk`, `toSettlement`.
It carries no name, because the map drew migration as an arc between two marks
and an arc needs no subject. The listing writes the move as a sentence, so
`RegionMigration` now records `agentName` — it was already in hand at the
departure (`departed.name`), simply never written down.

Re-recording the artifact against today's sim produced **4 migrations where the
committed file had 6**, same seed and same 90k-decision budget. The committed
file predates §58's escalation, which changes the trajectory; it was a replay of
a run the engine no longer produces. The new file is the current sim's truth and
says so in its own `_` field.

The §49 deviation itself still stands and is now stated on screen rather than
only in a comment: migration is not on the wire, live chunk servers do not move
agents, and the listing's migration line is labelled `replayed region run`.

## §19 — §66.3, three metrics and what the sheet was actually separating on

The operator's rule for §66.3 was "if any of them look like a frame you would
not post, the numbers are still measuring the wrong thing." Applied twice more,
it kept being right, and the third application falsified my own hypothesis
rather than the product.

| metric | what a ray counts as | worst frame | tracked the judgement? |
|---|---|---|---|
| bbox coverage | lands inside the fabric's bounding box | 41.4% | no — bare dock scored 100% |
| built tiles | any ray in a viewport tile finds something standing | 55.6% | partly |
| building area | the ray meets a wall or a roof (heightfield march) | 12.5% | **anti-correlated** |

Building area was built to be the third bar and never became one. Measured
against the sheet it runs the wrong way: the two frames nobody would post — an
empty olive yard with a silo, and a wall of grey planes — score **99% and 76%**,
while the best frame on the sheet scores **21%**. Close to the ground at a
shallow pitch almost every ray eventually passes under some roofline, whatever
the picture looks like. It is reported and not enforced; putting a floor on a
measurement that runs backwards is how a bar starts measuring the harness.

**What the sheet separates on is LIGHT.** Every unpostable frame across both
rounds is the camera close to the ground in an unlit corner of the plate, and
every good one has the night register's windows in it. No measure of the fabric
can tell those apart, because a lit terrace and a dark yard at 40 m are the same
geometry — the difference is where you are standing, not how the camera is
bounded.

That is a scope finding, not a calibration one. A viewer who pans into a dark
dock and stops there has taken the camera and that frame is theirs; §17's rule
is that input wins, and it wins here too. The frames the PRODUCT is answerable
for are the opening, the home framing, and every shot the director composes, and
those are now their own sheet (`tools/watch/director-sheet.mjs`), captured after
each shot settles and labelled with the intent that caused it. The free-camera
fuzz keeps its floor on the tile score, which is what it is good at — proving no
legal state loses the city — and stops pretending to be a judgement of
composition it cannot make.

The director sheet answers the operator's question the way the fuzz sheet could
not, and it does not answer it perfectly. Judged frame by frame on schiedam at
night:

| frame | shot | verdict |
|---|---|---|
| 1 | the opening, whole plate held | post |
| 2 | construction, d=1979 | post |
| 3 | demolition, d=192 | marginal — dim, but the site reads |
| 4 | agent, d=190 | **would not post** — near black, one orange smear |
| 5 | agent, d=150 | marginal — dark, the scaffold carries it |
| 6-10 | agent, d=150 | post — lit fabric, scaffold, kerb lamps |

**One in ten rather than three in ten**, and the one that fails fails for the
reason the fuzz sheet was pointing at all along: the director aimed at an agent
who happened to be standing somewhere unlit. Where something is HAPPENING is
usually lit, which is why the director's frames are mostly good — but "usually"
is doing work there, and the remaining defect is a selection rule, not a camera
bound.

Two findings out of this sheet, both escalated rather than acted on because both
are director-selection changes and §66 is about the camera:

1. **an intent should know whether its subject is lit.** §47.4 already weights
   idle beats toward work in progress; the same weighting applied to agent
   intents — prefer a subject with light on it — is what would remove frame 4.
2. **the director repeats itself.** Seven of ten shots were `agent` at exactly
   d=150 and pitch 0.9. Variety in distance and pitch is most of what makes a
   sequence read as filmed rather than sampled, and the ranking currently has
   nothing that discourages the same composition twice running.

## §20 — §68, the frames of reference agree; the cities have been demolished

A production paris frame showed pixel agents, scaffolds and worksite lights on
bare plate ground with the building geometry off in a corner behind a hard
diagonal edge, read as a coordinate disagreement: agents in one frame of
reference, the batched building geometry in another.

**Measured, it is not.** Four independent checks, none of which reproduces a
displacement:

| check | result |
|---|---|
| rendered batch bounds vs the fabric box the camera derives from (paris) | agree within **1.7 m** |
| same, schiedam | 8.1 m, entirely the fabric box also containing parcels |
| agents on the LOCAL wire standing on a baseline footprint | **78%**, zero offset beating every offset in ±400 m and every mirror |
| agents on the PRODUCTION wire, same test | **79-81%**, zero offset winning again |

The production seed is byte-identical to the committed one (`md5` matches), and
production serves the current client bundle. `mass.ts` already applies the same
`(x, height, -y)` flip that `pointAt` does, so the two paths were never in
different conventions.

**What the frame actually shows is a demolished city.** Reading the §16.2 data
texture out of production's `hello` — one texel per building, progress in `r` —
and laying it back over the seed footprints:

| world | standing / baseline | cleared | agent-built | clear : build |
|---|---|---|---|---|
| maassluis-haven | **184/935 (20%)** | 751 | 130 | 5.8 : 1 |
| maasland-dorp | 404/1050 (38%) | 646 | 121 | 5.3 : 1 |
| brooklyn-redhook | 431/866 (50%) | 435 | 39 | 11.2 : 1 |
| london-deptford | 431/791 (54%) | 360 | 74 | 4.9 : 1 |
| paris-ourcq | 424/765 (55%) | 341 | 52 | 6.6 : 1 |
| schiedam-havens | 515/936 (55%) | 421 | 55 | 7.7 : 1 |
| tokyo-kyojima | 258/446 (58%) | 188 | 55 | 3.4 : 1 |
| vlaardingen-westwijk | 460/690 (67%) | 230 | 58 | 4.0 : 1 |

Every world has lost between a third and four fifths of its building stock and
replaced between a twentieth and a third of what it cleared. Paris's standing
share by cell shows the shape of it — a west-to-east gradient from 28% standing
where the agents have been working to 100% where they have not:

```
100%  50%  65%  71%  96% 100%
 69%  88%  61%  47%  83%  87%
 59%  65% 100%  92%  81% 100%
 50%  28%  67%  62%  86% 100%
 30%  34%  67%  65%  81% 100%
100%  42%  33%  79%  81% 100%
```

The frontier between worked and unworked land follows parcel and block edges,
which on a fabric organised around a canal and a railway is a hard diagonal —
which is the edge in the frame. The buildings "in the corner" are the part of
paris the agents have not reached yet.

**So the escalation is economic, not geometric: clearing runs 3-11x ahead of
building.** The §58 escalation made agents more ambitious about assembly and
demolition; nothing made them correspondingly quick to rebuild, and a viewer
arriving mid-session is looking at a razed site rather than a city being
remade. maassluis-haven at 20% standing is not a city any more.

Two things are worth separating for whoever picks this up:

1. it may be that demolition-then-a-long-gap is what the economics honestly
   produces, in which case the fault is that nothing in the product says
   "this lot is between buildings" — cleared land renders as bare substrate
   and reads as missing geometry.
2. or the rebuild rate is genuinely too low against the clear rate, and the
   §21.1 capital constraint or the §57.1 pace is holding construction back
   while demolition is cheap.

Both are testable and neither is a transform. The §68 canary
(`assertBatchMatchesFabric`, run at boot, reported on `civ.plate.batchFault`)
now refuses to let a real displacement hide behind a passing §65 camera check —
the class the report suspected cannot recur silently even though this instance
was not it.

## Carried, not fixed

- ~~UK tier-1 valuations~~ — done (build 10, §33.4): HM Land Registry UK HPI
  average prices, OGL v3, joined by exact local-authority name. London 1.508
  on reals against Burnley 0.323; 128 GB candidates at tier-1. France's DVF is
  the same move for Paris.
- DEFRA lidar for a real London DTM — the probed WCS endpoint 404s; Thames-side
  is near-flat so the flat datum is tolerable, and the seam takes a DTM without
  code changes when one is reachable.
