# Spec v3 → implementation map

The source is annotated against build spec v3 by section number throughout.
This is the index: what each section asks for, and where it lives.

| § | Asks for | Implemented in |
|---|---|---|
| **0** | Thesis lock; the two governing questions | README "the two questions"; the divergence overlay and event scrub answer the first |
| **1** | Split the import by mutability; substrate is build-time only | `packages/importer` (buildings/roads/parcels as discrete rows), `tools/ahn` and `tools/voxcity` (substrate only, build-time) |
| **2** | The ratio problem; 400–1,500 baseline buildings; NL/3DBAG | `packages/importer/src/areas.ts`, `probe.ts`; ratio check printed by `main.ts` |
| **3** | Tick granularity; speed control; agent motion threshold | superseded by §20: `core/src/types.ts` (`THROUGHPUT`, `AGENT_MOTION_MAX_THROUGHPUT`) |
| **4** | Property economy; nine actions; four gradients; tune to >30% | `packages/sim/src/economy.ts`, `actions.ts`; measured by `packages/sim/test/tune.ts` |
| **5** | Three tables, three lifecycles; append-only events; snapshots | `packages/persistence/schema.sql`, `src/store.ts`, `src/memory.ts`, `src/durable.ts` |
| **6** | Parcels derived from block faces + Voronoi | `packages/importer/src/build/blocks.ts`, `build/parcels.ts` |
| **7** | Roads as a graph, never geometry | `packages/core/src/types.ts` (`RoadNode`/`RoadEdge`), `packages/client/src/render/roadMesh.ts` |
| **8** | Divergence classes, three surfaces, divergence index | `packages/core/src/types.ts` (`DIVERGENCE`), `packages/sim/src/divergence.ts`, event scrub in `main.ts` |
| **9** | Async decision engine; `Observation`; LLM stub | `packages/sim/src/engine.ts` |
| **10** | Chunk origins and local ENU frames | `packages/core/src/geo/frame.ts`, `types.ts` (`ChunkMeta`) |
| **12** | Build order | commit history, one commit per stage group |
| **13** | Cut list | nothing here gathers, eats or walks as a mechanic |
| **14** | First-run targets | rewritten by §20.8 in terms of generations; distribution asserted by `test/tune.ts` |
| **15** | Visual direction | README "Visual decisions"; `palette.ts`, `environment.ts`, `tiltShift.ts` |
| **16.1** | Archetype generator; agent vocabulary; preview harness | `packages/core/src/archetype/`, `packages/client/preview/` |
| **16.2** | Batched geometry + data texture; two batches | `packages/client/src/render/batch.ts`, `buildingData.ts`, `buildingRenderer.ts` |
| **16.3** | Long-lens camera; tilt-shift; AO; explicit fog | `packages/client/src/camera/rig.ts`, `postfx/tiltShift.ts`, `render/environment.ts` |
| **16.4** | Divergence as a lerp, one palette | `packages/core/src/palette.ts`, `render/buildingMaterial.ts` |
| **16.5** | Construction stages on one `progress` float | `packages/core/src/construction.ts`, `render/scaffold.ts`, the reveal in `buildingMaterial.ts` |
| **16.6** | Road growth animation; instanced agents | `render/roadMesh.ts` (`updateAgentRoads`), `render/agents.ts` |
| **17** | Cinematic director driven by event weight | `packages/client/src/camera/director.ts`, `cinematicWeight` written in `packages/sim/src/actions.ts` |
| **18.1** | Seed variance over N seeds, assert the distribution | `packages/sim/test/tune.ts`, `test/run-seed.ts` |
| **18.2** | The untouched set as a diagnostic | `test/lib/summarise.ts` (correlations, purpose mix, Jaccard) |
| **18.3** | Canaries for the silent-wrongness class | `test/lib/summarise.ts` structural report, asserted in `tune.ts` |
| **19** | Known gaps after build 1 | README "Not built"; voxcity account in `tools/voxcity/README.md` |
| **20** | Remove calendar time | `core/src/types.ts` (`THROUGHPUT`, `RATE_WINDOW_TICKS`), `sim/src/tick.ts`, `client/src/main.ts` |
| **20.5** | Lifespan as an action budget | `sim/src/state.ts` (`EFFORT_COST`), `tick.ts` `retire()` |
| **20.9** | Frozen action budget, calibrated once | `test/lib/summarise.ts` `DECISION_BUDGET`, provenance in `test/calibrate.ts` |
| **21.1** | Site value + a capital constraint, shipped together | `sim/src/engine.ts` (`siteValue`, acquire branch), `sim/src/economy.ts` (credit) |
| **21.2** | One recalibration, then refrozen | `test/calibrate.ts` rule, `DECISION_BUDGET` = 65,000 |
| **21.3** | Divergence-class entropy across seeds | `test/tune.ts` §21.3 sections |
| **21.4** | Validators read the emitter's output | `core/src/validate.ts`, `importer/src/emit.ts` (`emitSeed` returns the re-read file, `checkSql`), `importer/test/artifacts.test.ts` |
| **21.5** | AHN direct, voxcity retired, seam kept | `tools/ahn/`, `importer/src/main.ts` substrate swap, `client/src/render/substrateMesh.ts` |
| **21.6** | One world, many viewers | `packages/server` (tick loop, rng, broadcast), `packages/protocol` (the wire), `persistence/src/durable.ts` (Postgres), `client/src/world/{connection,observer}.ts` |

## Where the spec was not followed literally

Each of these is argued in the README and in the commit that introduced it.

- **§2's area size.** The spec says 0.5–1 km²; measured density here would put
  that at 1,700–3,400 buildings, above the band the same section defines. The
  count won; the area is 0.31 km².
- **§6's parcel seeding.** Seeding Voronoi cells on building centroids alone
  gives every cell a building and no development inventory. Open ground is
  seeded too.
- **§12's ordering.** Generations (stage 12) landed with the simulation because
  estate transfer was nearly free once ownership existed.
- **§16.1's minimum archetype set** is implemented as specified; no extra real
  archetypes were added, though Schiedam's windmills would have justified one.

## Where the seam exists but the output is not adopted

- **§9's `LLMDecisionEngine`** is a throwing stub satisfying the interface, as
  the spec asks.

## Known, measured, and deliberately unfixed

- **Era gating** remains a proxy for a mispriced yield model, per §18.4. §21.1
  removed the other half of that argument — acquisition is priced on site value
  now — but a floor added to a 1909 building is still 1909-quality space on a
  1909 decay curve, and nothing prices that yet. Revisit on chunk two.
- Nothing is reported as KNOWN by `tune.ts` any more. The one entry — acquisition
  ignoring site value — was fixed by §21.1 and both of its checks are assertions.
