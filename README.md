# agent civilisation

Agents inherit a real place and rebuild it. The diff between reality and the
agent-modified world is the product.

This is an implementation of **build spec v3**. The area is **Schiedam —
Havens**: the historic harbour district around the Lange Haven, 560 m square,
925 real buildings with their real footprints, real heights and real
construction years.

```bash
npm install
npm run server           # the world           -> ws://127.0.0.1:8787
npm run dev              # a window onto it    -> http://127.0.0.1:5173/
npm run dev -- --open /preview/   # archetype harness (§16.1)
```

**Shape, plainly: one world, many viewers.** §21.6 moved the simulation out of
the browser. A server process owns the tick loop, the rng and the store; the
client is a pure observer that receives deltas over a WebSocket at 10 Hz and
interpolates between them. `@civ/sim` is not a dependency of `@civ/client` and
does not appear in the Vercel bundle — the client cannot run a simulation
because it cannot reach one.

```
railway    the sim server, authoritative, single writer
supabase   DATABASE_URL — events append-only, snapshots on event ordinal
vercel     the client, no simulation code
transport  websocket, frames at ~10 Hz, client interpolates
```

**The world runs in seasons (§22.3).** It has a horizon, not a budget: when the
reachable stock saturates the season ends, the log stays queryable as history,
and a new one begins on the same baseline with a new rng seed. `tune.ts`'s
65,000-decision budget is a measurement device and does not govern the live
world — `packages/server/test/boundaries.test.ts` asserts it cannot.

Verified with two browsers on one server: identical tick, identical decision
count, frames ~60 ms apart. Full account in `packages/server/README.md`.

Build 2 was the opposite of this and the README said so: a single-process
browser app where N viewers meant N private worlds, which is worse for a
spectator product than divergent copies because there is nothing shared to
witness together.

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
| 10 | substrate | `packages/core/src/world.ts` (contract), `tools/ahn`, `tools/voxcity` |
| 11 | director | `packages/client/src/camera/director.ts` |
| 12 | generations | `packages/sim/src/tick.ts` |

### The two questions §0 says govern everything

**Can a spectator see how far the agent world has drifted from the real one?**
Yes, three ways: the divergence overlay as a per-building lerp (§16.4), the
event scrub restoring snapshots at the same viewpoint, and the divergence index.
Across 20 seeds at the frozen decision budget the index runs **median 49.3%,
p10 47.1%, stdev/median 0.030**, with a peak district around 67%.

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
is calibrated by `calibrate.ts` and frozen; it has been set twice, and the rule
for reading it was written before the number in both cases.

| | budget | rule |
|---|---|---|
| build 2 | 39,000 | the decision count at which the build first reached the end state it had before the calendar came out |
| build 3 | 65,000 | the plateau: index gains under 1pp and both agent-built and cleared growing under 5% per 5,000 decisions |

Build 3's recalibration is the one §21.2 permits — site value and capital are a
mechanism the model lacked, not constants tuned against an outcome. The larger
number is not the model running slower; it is ~40% more stock being reachable
and every purchase competing for finite credit.

Structural canaries run over the seed itself before any simulation. Four of them
caught real faults on first run — see the commit history; each produced output
that looked entirely plausible.

### Harness convention (§74.2): a harness that only photographs is not enough

**Every visual a/b carries a state assertion alongside the image.**

An a/b of a live simulation is not a controlled experiment. The world differs
between arms whether or not the change did anything, so images alone can confirm
any hypothesis — including one that is false.

§73.2 is the case that produced the rule. The first void fade wrote into
`shader.uniforms` before `onBeforeCompile` had run, so every write was skipped
and the half-extent stayed at its `1e9` default: a fade that never faded. The
before/after frames still looked plausibly improved, because the world had moved
on between the two captures. What caught it was the readout printed beside them,
`fabric half [1000000000, 1000000000]`. Nothing in the frames could have.

So a visual harness needs either a frozen world or a printed state that says the
change is actually in effect — the uniform, the bound, the count, the flag. The
same rule is why `tools/watch/inset-audit.mjs` steps the rig and prints metres,
and why `tools/watch/director-sheet.mjs` prints the intent and framing under
every tile.

**Freeze the world, then diff pixels.** §75 pushed the rule further by applying
it to its own block, and everything it caught it caught in the same place.
`tools/watch/lighting-ab.mjs` closes the wire, pins the animation clock, snaps
the camera once, and pins the state under test — so the arms differ by the light
and nothing else — and then adds a CONTROL arm that re-measures the same pinned
state one interval later. That control is the part worth copying: it is the
harness's own noise floor, and without it "the wire close worked" is an
assumption of exactly the kind that produced this rule. On its first run the
control read a per-pixel drift of zero while the two band arms reported
*identical lighting state with different pixels* — which is how the missing
frame step was found rather than argued about.

Once the arms are genuinely controlled, **the per-pixel difference between them
is a better instrument than any summary of either one**. Three assertions in
that block failed on their statistic rather than on the mechanism, all the same
species: a percentile taken over a heterogeneous frame. The worst compared the
median of "every non-warm pixel" between two lighting states and reported almost
no change on Red Hook — whose frame is mostly near-black asphalt and water, so
the median sits in that population and cannot move however much the buildings
light up. Same world, same camera, same clock means pixel (x, y) is the same
surface in both arms, so subtracting them classifies nothing and needs no
threshold. Prefer that to inventing a cutoff, and when a bar does have to be
restated, record what it read before and after so the restatement can be checked
rather than trusted.

A second one worth keeping from the same block: adjacent surfaces meeting at a
boundary need MATCHING values, not merely similar ones. `VOID.fog` sat at
`#131110` against a `#0d0c0a` horizon — six values apart, invisible as a colour,
and a visible seam exactly where the plate ended.

### What §22 measured, and what it found

§21.1 asked for the action mix to be judged. §22.1 answered that the mix is
weighted toward what a spectator cannot see, and asked for two measurements
using the precedent already set for demolish and develop: **decision share is
not physical consequence**.

**Grain (§22.1).** Medians across 20 seeds:

```
assemblies                                    45, median 2 parcels each
  followed by develop on the same holding     14  (31%)
  followed by demolish                         0
  full chain assemble -> demolish -> develop   0
  never acted on                              28
agent-built standing on multi-parcel sites   7 of 248  (3%)
footprint vs baseline on the same ground     1.55x all, 1.84x consolidated
```

The chain is 0 and it is **structurally impossible, not rare**: `assemble`
filters its candidates on `!p.hasBuilding`, so it can only ever gather vacant
land, and there is nothing standing on assembled ground to demolish. §4 defines
assemble as "consolidate adjacent lots and redevelop at higher intensity", and
consolidating *occupied* lots is the half the model cannot express.

So the grain is largely frozen. 3% of agent-built structures stand on
consolidated ground; the rest replace one building on one lot. That 3% is the
generous reading — it counts any structure standing on more than one parcel,
whether the parcels were gathered by `assemble` or one at a time by
`acquire_parcel` — and it still fails.

The 1.55x footprint ratio is real grain change at the building scale: new
structures cover half again as much of their lot as what they replaced. But the
1909 lot pattern survives, which is the thing §22.1 says decides whether the
district thesis holds.

**Churn (§22.1).** Also medians across 20 seeds:

```
6,662 acquisitions across 936 buildings; worst-traded changed hands 15x
per building ever altered (divergence >= 2)      6.77
per building whose silhouette changed (>= 4)    11.50
acquisitions landing on stock nobody ever alters    0%
```

By §22.1's own number — "if a building changes hands four times and is altered
once, that is a property market" — this is a property market. Nearly seven
trades per alteration, and a trade is invisible from the city camera.

Both are `KNOWN` in `tune.ts` rather than silently passing or quietly retuned.
Neither threshold was moved: both were written before the run.

### Is the engine deciding, or sorting? (§22.2)

The caveat raised in build 3 was that a scoring function with a random
tie-break produces the same 80/20 local-substitution signature as genuine
strategic variation, and that entropy alone cannot tell them apart. §22.2's
discriminator is to correlate per-building entropy against the score margin at
the moment of the decision — the gap between the top-scored action and the
runner-up — and to run it **before** the §9 swap.

```
781 buildings with both an entropy and a recorded margin
correlation  entropy ~ margin          r = +0.111
             entropy ~ parcel area     r = +0.106
             entropy ~ adjacency degree r = +0.035

margin <= 0.05 (a tie)        1 building   100% carry entropy
margin 0.05 - 0.25          130 buildings   82% carry entropy, median 0.61 bits
margin > 0.25 (clear-cut)   650 buildings   75% carry entropy, median 0.61 bits
```

**It is not tie-break noise.** Entropy does not track margin downward; if
anything it rises slightly with it. The near-tie band is almost empty — one
building in 781 — so the failure mode §22.2 named is not what is happening.
Three quarters of clear-cut decisions still vary across seeds.

There is a second reading that matters more than the first, and it is not the
one anyone was looking for. The engine samples uniformly from its top three
options, so at a margin above 0.25 it is discarding a materially better move two
times in three. The variation is real — different things happen — but it is
produced by agents being deliberately suboptimal rather than by agents reasoning
differently.

That inverts the risk. An LLM engine choosing deliberately among the same
options would produce **less** spread, not more, because it would keep picking
the reasoned option. So the swap is unlikely to scramble the calibration; it is
more likely to tighten it. The open question is no longer "will the engine
survive the swap" but "how much of the current variety is an artifact of the
tie-break, and is uniform-over-top-3 the right sampler at all".

### The build-3 KNOWN entry is gone

Build 2 carried one check that printed KNOWN rather than passing: every utility,
industrial and civic building was untouched in all 20 runs. That was structural
exclusion rather than economics — utility rent barely clears its own
maintenance, so its cap rate is ~0, and acquisition scored on income yield
alone. No agent had ever considered a garage under any seed.

§21.1 put site value in, and both of those are assertions now. The residue is
periphery again: untouched correlates with land value at **r = -0.458**, which
is §18.2's healthy reading, and the classes that were entirely excluded now run
22% (industrial) and 69% (utility) untouched — half of that utility residue
sitting on parcels under 60 m², which physically cannot carry a redevelopment.

### What is judged (§21.1)

Not the headline index. "That number came from an incomplete model and has no
claim on the new one." The action mix, at the median across seeds:

```
acquire_building  45.7%     demolish   1.5%     assemble    0.3%
renovate          23.0%     develop    1.8%     build_road  0.1%
convert           18.8%     acquire_parcel 3.3%     expand   5.7%
```

Which reads as a property market: mostly trades and improvements, teardowns rare
and expensive. 21% of the baseline is cleared and 29% of standing stock is agent
built by the end. Capital binds — **95% of agents borrow at some point**, median
peak debt 8,346 against a starting balance around 2,800.

One assertion here was written as "demolish and develop are each ≥2% of applied
actions" and failed at 1.5% and 1.8%. The threshold was not moved. It measured
the wrong thing: decision share is not physical consequence, and redevelopment
is the expensive rare action — 1.5% of decisions is 190 buildings cleared. What
is asserted is what "vestigial" actually means, the share of the stock reshaped.

### Where the §21.3 prediction landed

Build 3 predicted that unlocking ~40% more reachable stock would loosen the
spread. It did not: stdev/median went 0.028 -> 0.030, and the prediction was
withdrawn. The entropy diagnostic added alongside it survives and is still run
every pass; §22.2 above is what settled the caveat it left open.

```
spread along the run     25% of budget  0.023      75%  0.023
                         50% of budget  0.021     100%  0.030
```

The spread is flat through the run and widens slightly at the end, so the
tightness is not an artifact of stopping at the plateau.

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

## Deploying it

Manual, from the consoles — no CLI or token is needed. The full walkthrough
with health checks is [docs/deploy.md](docs/deploy.md); the short form:

1. **Supabase**: create a project, take the *transaction pooler* string (6543).
2. **Railway**: deploy this repo. Set `DATABASE_URL` (the pooler string),
   `CHUNK=schiedam-havens`, `THROUGHPUT=2`, `RETAIN_SEASONS=4`. Railway sets
   `PORT`. Confirm `curl https://<app>.railway.app/health` reads
   `"durability":"postgres"`.
3. **Vercel**: deploy the same repo (`vercel.json` carries the build). Set
   `VITE_SERVER_URL=wss://<app>.railway.app` — `wss://`, not `ws://`, or the
   browser refuses the mixed connection. `?server=wss://…` overrides at
   runtime.

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

§4 is explicit that if divergence does not reach 30%, *the constants are wrong
rather than the code*. `packages/sim/test/tune.ts` measures it, at the median of
20 seeds run to the frozen budget:

```
divergence  touched  peak district  agent-built  cleared  generations completed
     49.3%      77%            67%          260      190                    203
```

All five §20.8 targets pass. Five rounds each produced a plausible-looking
number while being wrong; the failures are recorded in the commit history
because they are the actual content of the tuning work:

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
5. **Acquisition priced on income alone.** A garage earns nothing, so no agent
   ever considered one — every utility, industrial and civic building survived
   every seed. It read as 35% divergence and was 35% of a subset. §21.1's
   `max(income value, site value − demolition − risk)` is what a purchase
   actually is; the capital constraint shipped with it is what stops the fix
   overshooting to 91% of stock redeveloped.

---

## Deliberate deviations from the spec

**The simulation runs in one server process, not a worker and not the browser.**
§21.6. The renderer owns the building-index space (a building can occupy several
indices over its life as its geometry mutates), so what crosses the wire is a
texel delta rather than a world. Stepping is wall-clock budgeted, and the client
never steps at all.

**Persistence is write-behind.** `WorldStore` is synchronous and stays that way:
the tick loop calls `appendEvent` tens of thousands of times a run, and awaiting
a database inside it would put network latency in the middle of the simulation.
`DurableStore` writes to memory at memory speed and drains the tail to Postgres
on an interval. The simulation reads its own recent history from memory; a
*spectator* reading history reads the database, because that is the read that
has to survive the process and be the same for everyone watching.

**voxcity is retired for this chunk; the seam stays (§21.5).** The pipeline was
run end to end and the swap works in both directions, which is what stage 10
asked for. Two findings came out of running it (full account in
`tools/voxcity/README.md`): the Netherlands DEM is AHN4 via Google Earth Engine
and returns an all-zero grid without credentials *while reporting success*, and
its OSM land cover yields no water at all — swapping it in loses every canal in
a canal district.

For a Dutch chunk the direct path is better in every respect, so terrain now
comes from AHN as GeoTIFF (`tools/ahn`), through the same `--substrate` seam,
and the surfaces keep coming from the importer:

```
                 voxcity     AHN via PDOK
relief            0.00 m     3.54 m  (-0.43 to 3.10 m NAP)
water bodies           0     12
undevelopable          0     140 parcels
credentials      Earth Engine   none
```

The committed seed carries `provider: "ahn"`. voxcity is worth revisiting on a
chunk in a country with no national lidar product — fusing many global sources
behind one API is its actual value, and for the Netherlands it is strictly worse
than a URL.

**Parcels are seeded on open ground as well as on buildings.** §6's recipe
seeds Voronoi cells on building centroids alone, which gives every cell a
building and therefore no development inventory at all. Open ground is seeded on
a jittered lattice, kept only where genuinely clear of existing stock.

**Generations landed early.** §12 puts them last; estate transfer was nearly
free once ownership existed, so it is in. §20.5 then made a career a finite
effort budget rather than a span, so a busy district cycles through owners while
a quiet one does not.

## Not built

- **not deployed.** The server runs, has been verified against a live Postgres
  and against two browsers on one world, carries Railway and Vercel configs, and
  §22.4's three exposures are closed. It has not been put on the internet
- **no resume.** The durable log is a record, not a restore point: a snapshot is
  the §16.2 data texture, not ownership, capital or parcels. A restart begins a
  new season rather than continuing the old one, which is coherent with seasons
  and is a deliberate limit rather than an oversight
- **the grain is largely frozen and the market churns**, both measured, both
  `KNOWN` in `tune.ts`, both waiting on a model decision — see §22 above
- one chunk. §10's composition is architecture, not a tested claim, and §18.5's
  cross-area validation is unexercised — and it is the first thing to do, because
  every constant in the economy has only ever seen this fabric
- the ~10 Hz frame is JSON with base64 blobs. Fine at a couple of kilobytes a
  frame and the obvious thing to change first if it stops being
- `before_after` camera intent is defined and queued but composes as a single
  pullback rather than a true A/B cut
- multi-chunk worlds — the registry and local frames are in place, one chunk is
  loaded
- `LLMDecisionEngine` is a throwing stub, as §9 specifies. `Observation` is the
  contract: serialise it, ask for one action plus a rationale, validate against
  `AgentAction`
