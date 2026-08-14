# agent civilisation

Agents inherit a real place and rebuild it. The diff between reality and the
agent-modified world is the product.

This is an implementation of **build spec v3**. The area is **Schiedam —
Havens**: the historic harbour district around the Lange Haven, 560 m square,
925 real buildings with their real footprints, real heights and real
construction years.

```bash
npm install
npm run dev              # the world           -> http://127.0.0.1:5173/
npm run dev -- --open /preview/   # archetype harness (§16.1)
```

**Shape, plainly: this is a single-process local app.** There is no server, no
Postgres, no WebSocket. The simulation runs in the browser main thread and
`MemoryStore` holds the event log in tab memory until you refresh. `schema.sql`
is a contract nothing connects to. N viewers means N independent worlds, not N
viewers of one world. The seams for changing that are `WorldStore` and
`Simulation.runToThroughput`; everything else in the client assumes it owns the
world.

The world seed is committed, so nothing is fetched at runtime. To rebuild it
from source data:

```bash
npm run import                                  # 3DBAG + Overpass -> seed + SQL
node --no-warnings packages/sim/test/tune.ts    # 20 seeds, §18 assertions
node --no-warnings packages/sim/test/calibrate.ts   # budget provenance (§20.9)
npm test
```

---

## What is here

| Stage | | Where |
|---|---|---|
| 1 | import one real area | `packages/importer` |
| 2 | archetype generator + preview harness | `packages/core/src/archetype`, `packages/client/preview` |
| 3 | render day 0 | `packages/client/src/render` |
| 4-5 | sim loop and mutation | `packages/sim` |
| 6 | persistence | `packages/persistence` |
| 7 | divergence | `divergence.ts`, `buildingMaterial.ts`, event scrub |
| 8-9 | spectator and inspection | `packages/client/src/main.ts`, `index.html` |
| 10 | substrate | `packages/core/src/world.ts` (contract), `tools/voxcity` |
| 11 | director | `packages/client/src/camera/director.ts` |
| 12 | generations | `packages/sim/src/tick.ts` |

### The two questions §0 says govern everything

**Can a spectator see how far the agent world has drifted from the real one?**
Yes, three ways: the divergence overlay as a per-building lerp (§16.4), the
event scrub restoring snapshots at the same viewpoint, and the divergence index.
Across 20 seeds at the frozen decision budget the index runs **median 35.2%,
p10 34.0%, stdev/median 0.028**, with a peak district around 56%.

**Does it look like a handcrafted miniature world rather than a GIS viewport?**
That was the harder half. See "Visual decisions" below.

---

## No calendar (§20)

The world has history; the simulation has no calendar. A building's real
construction year is a fact about it, in the same way its footprint is — it
drives archetype selection and stock quality, and the inspector shows it.
Everything measuring *elapsed* time is gone: there is no date formatter left in
the codebase, and no year, day or tick is rendered anywhere.

| was | is |
|---|---|
| tick = 1 simulated day | internal monotonic ordering key, never rendered |
| speed = sim time per second | agent decision throughput — how fast the civilization thinks |
| year scrub | event scrub by log ordinal, labelled by generation |
| lifespan in years | a finite effort budget: passing is cheap, acting is dear |
| "nineteen years passed" | "four generations have lived and died here" |

Readouts are divergence index primary, generation secondary, and nothing third.
Rates are quoted over `RATE_WINDOW_TICKS`, an internal normalisation window that
is not a year and is never converted to one. Agent-built structures carry no
construction year — they are new, and the inspector says so rather than
inventing a date.

## Validation (§18)

`tune.ts` runs 20 seeds in parallel to a frozen decision budget and asserts on
the distribution, because §14's targets passing once is not evidence. The budget
was calibrated once by `calibrate.ts` — the decision count at which this build
first reaches the end state it already had (34.6% index, 135 agent-built, 85
cleared, all three together): 39,050, frozen at 39,000. It is not adjusted to
make assertions pass.

Structural canaries run over the seed itself before any simulation. Four of them
caught real faults on first run — see the commit history; each produced output
that looked entirely plausible.

### One check reports KNOWN rather than passing

Every utility building, every industrial one and every civic one is untouched in
all 20 runs — 83% of the residue is identical across seeds. That is structural
exclusion, not economics: utility rent barely clears its own maintenance, so its
cap rate is ~0, and acquisition scores on income yield alone. No agent has ever
considered a garage under any seed.

The fix — valuing a building at the better of its income and its site, which is
what acquisition actually is — was implemented and measured. It moves the median
index from 35.9% to 54.9% and the touched share from 58% to 91%, because it
unlocks roughly 40% of the stock. That is a decision about the model rather than
a bug fix, and it collides with a budget that is deliberately frozen, so it is
left for §18.4's yield rework on the second chunk. `tune.ts` prints it on every
run instead of hiding it behind a green suite.

## Data

| Layer | Source | Licence |
|---|---|---|
| Building footprints, heights, levels, roof type, **construction year** | [3DBAG](https://3dbag.nl) v2023.10.08 | CC BY 4.0 |
| Building purpose tags, road graph, water, landcover | OpenStreetMap via Overpass | ODbL 1.0 |
| Blocks, parcels | derived from the road graph (§6) | follows ODbL |

§2 names the Netherlands as the strongest prototype target and that is exactly
why: 3DBAG gives **100% height and 100% construction-year coverage**. The median
building here was built in **1909**, and that number does real work — it drives
the archetype selector, the roof tones, and the rule that pre-war stock cannot
simply grow floors.

**Licence, before it is load bearing (§2):** the road graph, the tags and
therefore the derived parcels are ODbL. Share-alike bites derived databases you
publish. 3DBAG is CC BY 4.0 and is the geometry spine. Each layer's provenance
travels in the seed and is shown in the app.

### The area was chosen by measurement, not by postcard value

Dutch historic fabric runs about **3,400 buildings per km²**, so §2's "0.5 to 1
km²" would land at 1,700–3,400 baseline buildings — above the 400–1,500 band
where divergence can saturate. The area is sized by measured building count:
a 560 m square gives 925. `packages/importer/src/probe.ts` is the instrument.

Against §2's list: low/mid rise throughout, 100% height coverage, canals and a
post-industrial harbour edge for water character, developable vacant parcels as
development inventory, and a genuinely mixed fabric — distillery warehouses,
rowhouses, a church, industrial sheds.

It wins every §2 criterion except one: Schiedam is polder flat, so it has no
relief, and relief is exactly what makes the stage 10 substrate swap worth
doing. That is the criterion traded away for data coverage, and it is why the
voxcity run below is plumbing rather than a visual result.

---

## Architecture

```
packages/core         shared vocabulary, geometry, archetypes, palette, thresholds
packages/importer     build-time only: 3DBAG + Overpass -> seed + SQL
packages/sim          tick loop, agents, property economy, decision engines
packages/persistence  schema.sql (canonical) + WorldStore + in-memory impl
packages/client       three.js renderer, spectator UI, camera director
tools/voxcity         build-time substrate pipeline (§10)
```

Neither the importer nor the voxcity pipeline ships in the runtime image, per §1.

### §16's correction, which is the one that matters

Real footprints are arbitrary polygons, so **every building is unique geometry
and `InstancedMesh` is the wrong tool**. Instead:

- archetype geometry is **generated** at load, never authored, never imported
- all of a chunk's buildings merge into **one batched mesh**
- every vertex carries its **building index**
- all mutable per-building state lives in a **data texture** at that index

One draw call for 925 buildings. A building changing state is one texel write.
Construction, demolition, conversion recolour, divergence overlay and the year
scrub all animate with zero mesh churn. Only geometric mutation — expand,
develop, replace — moves a building into a second, dynamic batch.

Instancing *is* used where it genuinely applies: agent markers, scaffolding
cages and site decals all share one mesh.

---

## Visual decisions

§15 says the visual identity is part of the product, not a polish layer, so
these are recorded rather than left implicit.

**The palette is authored in sRGB and converted once, at the GLSL boundary.**
Handing sRGB values to a linear renderer makes every colour render lighter and
flatter than it was picked, and no amount of colour-picking recovers it.

**No filmic tone mapping.** ACES rolls off exactly the midtones a restrained
palette lives in. Lights are balanced instead so a sunlit up-facing surface
lands near its authored albedo.

**Near and far track the camera.** A 15° lens framing a 560 m chunk sits ~2.1 km
back; with a 1 m near plane the depth buffer resolves about a third of a metre
there, which silently collapses canals, roads and every ground layer into the
base plate. This looks like an art-direction problem and is not one.

**The ground plate is bounded just past the chunk.** A plane running to the
horizon reads as a map viewport; a plate that ends reads as an object sitting in
space, which is most of what makes the world feel handmade.

**Tilt-shift is depth-based, not a screen-space gradient**, so the focal band
tracks what the camera is looking at. It fades out approaching street level,
where a miniature read is simply out of focus.

**Divergence is one palette plus a lerp** (§16.4), not two colour schemes.
Untouched stock desaturates toward neutral as agent work saturates — the "grey
reality being overtaken" effect — and the mode transition animates.

---

## Tuning

§4 is explicit that if divergence does not reach 30% in 20 years, *the constants
are wrong rather than the code*. `packages/sim/test/tune.ts` measures it:

```
year  divergence  touched  peak district  agent-built  cleared
2046      34.6%    56.4%          55.6%          135       85
```

All six §14 first-run targets pass. Four tuning rounds each produced a
plausible-looking number while being wrong; the failures are recorded in the
commit history because they are the actual content of the tuning work:

1. **Parcels pointed at buildings but buildings did not point back.** Every
   land-based action was silently unreachable. The run looked healthy at 11.8%
   divergence made entirely of acquisitions.
2. **No resale cooling-off** meant the population traded the same stock forever
   — a sale funds the seller's next purchase — producing 28,000 acquisitions
   that changed nothing.
3. **Uncapped expansion.** Adding floors is always cheaper per m² than replacing
   a building, so 81% of a district with a median construction year of 1909
   quietly grew a storey. Expansion is now gated to post-war stock.
4. **No demand saturation.** Retail rent is well above residential, so two
   thirds of the centre converted to shops. Demand now divides by the local
   share of floor area already in that purpose.

---

## Deliberate deviations from the spec

**The simulation runs in the main thread, not a worker.** The renderer owns the
building-index space (a building can occupy several indices over its life as its
geometry mutates), and a worker would need that mapping mirrored across a
boundary for no gain at this scale. Stepping is time-budgeted per frame so a
fast speed never starves rendering. `Simulation.runBudgeted` is the seam.

**Persistence runs in memory.** `schema.sql` is the canonical contract — with
triggers that genuinely refuse baseline mutation and event updates — and the
importer emits baseline rows against it. The runtime implements the same shapes
behind `WorldStore`. Swapping in a Postgres implementation is one class.

**voxcity runs; its output is not adopted.** The pipeline executes end to end
and the swap works in both directions. Two findings came out of running it (full
account in `tools/voxcity/README.md`): the Netherlands DEM is AHN4 via Google
Earth Engine and returns an all-zero grid without credentials *while reporting
success*, and its OSM land cover yields no water at all — swapping it in loses
every canal in a canal district. The importer now refuses a zero-relief
substrate by name and warns about lost water. The committed seed stays
`flat-datum`; stage 10 is worth doing on a chunk with real relief.

**Parcels are seeded on open ground as well as on buildings.** §6's recipe
seeds Voronoi cells on building centroids alone, which gives every cell a
building and therefore no development inventory at all. Open ground is seeded on
a jittered lattice, kept only where genuinely clear of existing stock.

**Generations landed early.** §12 puts them last; estate transfer was nearly
free once ownership existed, so it is in. Careers run 13–21 years so the
2026–2045 window actually contains a handover.

## Not built

- **no server.** See the top of this file. A spectator platform needs a
  server-authoritative sim, Postgres and a WebSocket fan-out; none of that
  exists yet
- acquisition ignores site value, so non-earning stock is invisible — measured,
  reported by `tune.ts` as KNOWN, deferred to §18.4
- one chunk. §10's composition is architecture, not a tested claim, and §18.5's
  cross-area validation is unexercised
- `before_after` camera intent is defined and queued but composes as a single
  pullback rather than a true A/B cut
- multi-chunk worlds — the registry and local frames are in place, one chunk is
  loaded
- `LLMDecisionEngine` is a throwing stub, as §9 specifies. `Observation` is the
  contract: serialise it, ask for one action plus a rationale, validate against
  `AgentAction`
