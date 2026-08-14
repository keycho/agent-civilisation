# Spec v3 → implementation map

The source is annotated against build spec v3 by section number throughout.
This is the index: what each section asks for, and where it lives.

| § | Asks for | Implemented in |
|---|---|---|
| **0** | Thesis lock; the two governing questions | README "the two questions", and the divergence overlay + year scrub answer the first |
| **1** | Split the import by mutability; voxcity is substrate only | `packages/importer` (buildings/roads/parcels as discrete rows), `tools/voxcity` (substrate only, build-time) |
| **2** | The ratio problem; 400–1,500 baseline buildings; NL/3DBAG | `packages/importer/src/areas.ts`, `probe.ts`; ratio check printed by `main.ts` |
| **3** | Tick = 1 simulated day; six speeds; agent motion threshold | `packages/core/src/types.ts` (`SPEEDS`, `AGENT_MOTION_MAX_TPS`), `packages/sim/src/tick.ts` |
| **4** | Property economy; nine actions; four gradients; tune to >30% | `packages/sim/src/economy.ts`, `actions.ts`; measured by `packages/sim/test/tune.ts` |
| **5** | Three tables, three lifecycles; append-only events; snapshots | `packages/persistence/schema.sql`, `src/store.ts`, `src/memory.ts` |
| **6** | Parcels derived from block faces + Voronoi | `packages/importer/src/build/blocks.ts`, `build/parcels.ts` |
| **7** | Roads as a graph, never geometry | `packages/core/src/types.ts` (`RoadNode`/`RoadEdge`), `packages/client/src/render/roadMesh.ts` |
| **8** | Divergence classes, three surfaces, divergence index | `packages/core/src/types.ts` (`DIVERGENCE`), `packages/sim/src/divergence.ts`, year scrub in `main.ts` |
| **9** | Async decision engine; `Observation`; LLM stub | `packages/sim/src/engine.ts` |
| **10** | Chunk origins and local ENU frames | `packages/core/src/geo/frame.ts`, `types.ts` (`ChunkMeta`) |
| **12** | Build order | commit history, one commit per stage group |
| **13** | Cut list | nothing here gathers, eats or walks as a mechanic |
| **14** | First-run targets | asserted by `packages/sim/test/tune.ts` |
| **15** | Visual direction | README "Visual decisions"; `palette.ts`, `environment.ts`, `tiltShift.ts` |
| **16.1** | Archetype generator; agent vocabulary; preview harness | `packages/core/src/archetype/`, `packages/client/preview/` |
| **16.2** | Batched geometry + data texture; two batches | `packages/client/src/render/batch.ts`, `buildingData.ts`, `buildingRenderer.ts` |
| **16.3** | Long-lens camera; tilt-shift; AO; explicit fog | `packages/client/src/camera/rig.ts`, `postfx/tiltShift.ts`, `render/environment.ts` |
| **16.4** | Divergence as a lerp, one palette | `packages/core/src/palette.ts`, `render/buildingMaterial.ts` |
| **16.5** | Construction stages on one `progress` float | `packages/core/src/construction.ts`, `render/scaffold.ts`, the reveal in `buildingMaterial.ts` |
| **16.6** | Road growth animation; instanced agents | `render/roadMesh.ts` (`updateAgentRoads`), `render/agents.ts` |
| **17** | Cinematic director driven by event weight | `packages/client/src/camera/director.ts`, `cinematicWeight` written in `packages/sim/src/actions.ts` |

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

## Where the seam exists but the far side has not been run

- **§10 / stage 10.** The substrate contract is defined, read by the renderer,
  and swappable via `npm run import -- --substrate <file>` with validation on
  load. `tools/voxcity/emit_substrate.py` emits it. voxcity itself has not been
  executed, so the committed seed carries `provider: "flat-datum"`.
- **§9's `LLMDecisionEngine`** is a throwing stub satisfying the interface, as
  the spec asks.
