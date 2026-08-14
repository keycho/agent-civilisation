-- Spec v3 §5. Three tables, three lifecycles. Conflating them destroys the
-- comparison feature, which is the product.
--
-- This is the canonical persistence contract. The runtime prototype implements
-- the same shapes in memory behind the WorldStore interface (src/store.ts); the
-- importer emits baseline rows against this schema directly.

create extension if not exists postgis;
create extension if not exists "pgcrypto";

-- ---------------------------------------------------------------------------
-- chunks (§10) — every chunk is anchored to an origin and worked in a local
-- ENU metre frame. No global projection is attempted anywhere.
-- ---------------------------------------------------------------------------

create table if not exists chunks (
  id          text primary key,
  name        text not null,
  origin_lat  double precision not null,
  origin_lon  double precision not null,
  bbox        geometry(polygon, 4326) not null,
  created_at  timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- baseline — written once at import, never updated
-- The "reality" side of the comparison. Nothing in the simulation may write
-- to it, ever. Enforced below, not just documented.
-- ---------------------------------------------------------------------------

create table if not exists buildings_baseline (
  id                text primary key,
  chunk_id          text not null references chunks(id),
  osm_id            text,
  bag_id            text,
  footprint         geometry(polygon, 4326) not null,
  height_m          real,
  levels            int,
  construction_year int,
  purpose           text,
  archetype         text,
  ground_m          real,
  name              text,
  imported_at       timestamptz not null default now()
);

create index if not exists buildings_baseline_chunk_idx on buildings_baseline (chunk_id);
create index if not exists buildings_baseline_geom_idx on buildings_baseline using gist (footprint);

create or replace function refuse_baseline_mutation() returns trigger as $$
begin
  raise exception 'buildings_baseline is immutable (spec v3 §5): the baseline is the reality side of the comparison';
end;
$$ language plpgsql;

drop trigger if exists baseline_is_immutable on buildings_baseline;
create trigger baseline_is_immutable
  before update or delete on buildings_baseline
  for each row execute function refuse_baseline_mutation();

-- ---------------------------------------------------------------------------
-- agents
-- ---------------------------------------------------------------------------

create table if not exists agents (
  id            uuid primary key default gen_random_uuid(),
  name          text not null,
  chunk_id      text not null references chunks(id),
  capital       double precision not null,
  strategy      text not null,
  born_tick     bigint not null,
  died_tick     bigint,
  heir_id       uuid references agents(id),
  generation    int not null default 1,
  colour_index  int not null default 0
);

-- ---------------------------------------------------------------------------
-- parcels (§6) — derived, not imported; open cadastral data mostly does not
-- exist. Blocks are planar faces of the road graph; parcels are a Voronoi
-- partition inside them.
-- ---------------------------------------------------------------------------

create table if not exists parcels (
  id              text primary key,
  chunk_id        text not null references chunks(id),
  block_id        text not null,
  polygon         geometry(polygon, 4326) not null,
  area_m2         real not null,
  building_id     uuid,
  owner_id        uuid references agents(id),
  access_score    real not null,
  road_distance_m real not null,
  land_value      double precision not null default 0,
  developable     boolean not null default true
);

create index if not exists parcels_chunk_idx on parcels (chunk_id);
create index if not exists parcels_geom_idx on parcels using gist (polygon);
create index if not exists parcels_owner_idx on parcels (owner_id);

-- ---------------------------------------------------------------------------
-- current state — mutable
-- Never hard delete. Demolition sets state and demolished_tick; a demolished
-- building stays inspectable, because "there used to be a 1907 warehouse here"
-- is a large part of what makes the change land.
-- ---------------------------------------------------------------------------

create table if not exists buildings (
  id              uuid primary key default gen_random_uuid(),
  baseline_id     text references buildings_baseline(id),   -- null = agent built
  source          text not null check (source in ('real_world', 'agent_built')),
  chunk_id        text not null references chunks(id),
  parcel_id       text references parcels(id),
  footprint       geometry(polygon, 4326) not null,
  height_m        real not null,
  levels          int not null,
  purpose         text not null,
  archetype       text not null,
  ground_m        real not null default 0,
  condition       real not null default 1.0,
  owner_id        uuid references agents(id),                -- null = unowned
  state           text not null check (state in ('standing', 'under_construction', 'under_demolition', 'demolished')),
  progress        real not null default 1.0,
  divergence      smallint not null default 0,               -- §8
  replaces        uuid references buildings(id),             -- redevelopment chain
  created_tick    bigint not null,
  demolished_tick bigint
);

create index if not exists buildings_chunk_idx on buildings (chunk_id);
create index if not exists buildings_owner_idx on buildings (owner_id);
create index if not exists buildings_state_idx on buildings (state);
create index if not exists buildings_baseline_ref_idx on buildings (baseline_id);
create index if not exists buildings_geom_idx on buildings using gist (footprint);

-- ---------------------------------------------------------------------------
-- roads (§7) — the graph, not geometry. Agent-built edges insert into the same
-- structure, so they appear in the divergence overlay for free.
-- ---------------------------------------------------------------------------

create table if not exists road_nodes (
  id       text primary key,
  chunk_id text not null references chunks(id),
  point    geometry(point, 4326) not null,
  x        real not null,
  y        real not null
);

create table if not exists road_edges (
  id          text primary key,
  chunk_id    text not null references chunks(id),
  node_a      text not null references road_nodes(id),
  node_b      text not null references road_nodes(id),
  class       text not null,
  agent_built boolean not null default false,
  built_tick  bigint,
  length_m    real not null
);

create index if not exists road_edges_chunk_idx on road_edges (chunk_id);

-- ---------------------------------------------------------------------------
-- events — append only. Movement is NOT an event (§5): it is mutable state
-- broadcast in the frame and discarded.
-- ---------------------------------------------------------------------------

create table if not exists events (
  id                bigserial primary key,
  chunk_id          text not null references chunks(id),
  tick              bigint not null,
  type              text not null,
  agent_id          uuid references agents(id),
  building_id       uuid references buildings(id),
  parcel_id         text references parcels(id),
  edge_id           text references road_edges(id),
  -- §17: the cinematic director selects from recent events ranked by this.
  -- It goes in the schema now rather than being retrofitted.
  cinematic_weight  smallint not null default 0,
  rationale         text,
  payload           jsonb not null default '{}'::jsonb
);

create index if not exists events_tick_idx on events (chunk_id, tick);
create index if not exists events_weight_idx on events (chunk_id, cinematic_weight desc, tick desc);
create index if not exists events_building_idx on events (building_id);

create or replace function refuse_event_mutation() returns trigger as $$
begin
  raise exception 'events is append-only (spec v3 §5)';
end;
$$ language plpgsql;

drop trigger if exists events_are_append_only on events;
create trigger events_are_append_only
  before update or delete on events
  for each row execute function refuse_event_mutation();

-- ---------------------------------------------------------------------------
-- snapshots — §20.4: keyed on event ordinal, not on a year. The event log was
-- already the source of truth; year boundaries were an arbitrary overlay on it.
-- The comparison view asks "show me generation 3", and replaying the whole log
-- per query is not viable.
-- ---------------------------------------------------------------------------

create table if not exists snapshots (
  chunk_id         text not null references chunks(id),
  event_ordinal    bigint not null,
  generation       int not null,
  tick             bigint not null,
  -- one RGBA texel per building, exactly the §16.2 data texture, so the year
  -- scrub is a texture upload rather than a query
  building_data    bytea not null,
  divergence_index real not null,
  stats            jsonb not null default '{}'::jsonb,
  primary key (chunk_id, event_ordinal)
);

-- ---------------------------------------------------------------------------
-- districts — emergent, named when a cluster of agent work coheres (§4)
-- ---------------------------------------------------------------------------

create table if not exists districts (
  id           text primary key,
  chunk_id     text not null references chunks(id),
  name         text not null,
  hull         geometry(polygon, 4326),
  formed_tick  bigint not null
);
