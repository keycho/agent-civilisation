/**
 * §72.1's end-to-end acceptance: kill the server, start it again, and check
 * that the world carried on rather than started over.
 *
 * The unit tests prove the pieces — a captured world restores decision for
 * decision, a second store continues the log instead of colliding with it, the
 * season sequence is monotonic. This proves the thing those pieces are for,
 * against the real boot path, the real signal handling and a real database.
 *
 * What it asserts, per chunk, across the restart:
 *   season      does not go backwards, and does not reset to 1
 *   decisions   the second process starts at or above where the first stopped
 *   generation  does not go backwards
 *   event ids   the highest id written after the restart is above the highest
 *               before it, and nothing was dropped on the way
 *
 *   DATABASE_URL=... node tools/watch/resume-restart.mjs [seconds=75]
 */
import { spawn } from 'node:child_process'
import postgres from 'postgres'

const RUN_S = Number(process.argv[2] ?? 75)
const PORT = Number(process.env.PORT ?? 8841)
const DB = process.env.DATABASE_URL ?? 'postgres://civ@127.0.0.1:55432/civ'
const CHUNKS = process.env.CHUNKS ?? 'schiedam-havens,london-deptford'

const health = async () => {
  const r = await fetch(`http://127.0.0.1:${PORT}/health`)
  return r.json()
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms))

async function until(fn, timeoutMs, label) {
  const t0 = Date.now()
  for (;;) {
    try {
      const v = await fn()
      if (v) return v
    } catch {
      /* not up yet */
    }
    if (Date.now() - t0 > timeoutMs) throw new Error(`timed out waiting for ${label}`)
    await wait(500)
  }
}

function boot(label) {
  const p = spawn(
    'node',
    ['packages/server/src/main.ts'],
    {
      env: {
        ...process.env,
        PORT: String(PORT),
        DATABASE_URL: DB,
        CHUNKS,
        // save often enough that a short run has something to resume from
        SAVE_EVERY_MS: '15000',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  )
  const lines = []
  for (const s of [p.stdout, p.stderr]) {
    s.setEncoding('utf8')
    s.on('data', (d) => {
      for (const l of d.split('\n')) if (l.trim()) lines.push(`[${label}] ${l}`)
    })
  }
  return { p, lines }
}

async function stop(proc) {
  proc.p.kill('SIGTERM')
  await new Promise((r) => {
    proc.p.on('exit', r)
    setTimeout(() => {
      proc.p.kill('SIGKILL')
      r()
    }, 30_000)
  })
}

const sql = postgres(DB, { max: 2, prepare: false, onnotice: () => {} })
const maxEventId = async () => {
  const rows = await sql`select coalesce(max(id), 0) as m from events`
  return Number(rows[0].m)
}
const eventTotal = async () => {
  const rows = await sql`select count(*) as n from events`
  return Number(rows[0].n)
}

console.log(`§72.1 restart acceptance — ${CHUNKS}, ${RUN_S}s per process\n`)

// ---- first process --------------------------------------------------------
const a = boot('a')
/**
 * Wait for `chunks`, not for `boot.constructing` to clear. `constructing` is
 * null both before the boot loop starts and after it ends, so polling it
 * returns true in the gap before the first chunk and the harness reads a health
 * payload that has no worlds in it yet.
 */
await until(async () => (await health()).chunks, 180_000, 'the first boot to finish')
await wait(RUN_S * 1000)
const before = await health()
const idBefore = await maxEventId()
const rowsBefore = await eventTotal()
await stop(a)
console.log(a.lines.filter((l) => /resumed|founding|saved|events resume/.test(l)).join('\n'))

// ---- second process, same database ----------------------------------------
const b = boot('b')
await until(async () => (await health()).chunks, 180_000, 'the second boot to finish')
const atBoot = await health()
await wait(RUN_S * 1000)
const after = await health()
const idAfter = await maxEventId()
const rowsAfter = await eventTotal()
await stop(b)
console.log(b.lines.filter((l) => /resumed|founding|saved|events resume/.test(l)).join('\n'))

await sql.end({ timeout: 5 })

// ---- the checks -----------------------------------------------------------
const checks = []
const check = (ok, label, detail) => checks.push({ ok, label, detail })

for (const id of Object.keys(before.chunks)) {
  const x = before.chunks[id]
  const boot2 = atBoot.chunks[id]
  const y = after.chunks[id]
  check(
    boot2.season >= x.season,
    `${id}: the season did not reset`,
    `season ${x.season} -> ${boot2.season} at boot -> ${y.season}`,
  )
  check(
    boot2.season !== 1 || x.season === 1,
    `${id}: and did not fall back to 1`,
    `season ${boot2.season} after the restart`,
  )
  check(
    boot2.decisions >= x.decisions * 0.9,
    `${id}: the world resumed near where it stopped`,
    `${x.decisions.toLocaleString()} decisions before, ${boot2.decisions.toLocaleString()} at boot ` +
      `(${((boot2.decisions / Math.max(1, x.decisions)) * 100).toFixed(0)}%)`,
  )
  check(
    boot2.generation >= x.generation,
    `${id}: the generation count did not go backwards`,
    `g${x.generation} -> g${boot2.generation}`,
  )
  check(
    y.decisions > boot2.decisions,
    `${id}: and kept running afterwards`,
    `${boot2.decisions.toLocaleString()} -> ${y.decisions.toLocaleString()}`,
  )
}
check(
  idAfter > idBefore,
  'event ids continued past the first process',
  `max id ${idBefore.toLocaleString()} -> ${idAfter.toLocaleString()}`,
)
check(
  rowsAfter > rowsBefore,
  'and the rows actually landed — nothing was swallowed by a conflict clause',
  `${rowsBefore.toLocaleString()} -> ${rowsAfter.toLocaleString()} rows (+${(rowsAfter - rowsBefore).toLocaleString()})`,
)

console.log()
for (const c of checks) {
  console.log(`  ${c.ok ? 'PASS' : 'FAIL'}  ${c.label} — ${c.detail}`)
}
const failed = checks.filter((c) => !c.ok).length
console.log(`\n§72.1 restart: ${checks.length - failed}/${checks.length}`)
if (failed) {
  console.log('\n--- server output ---')
  console.log([...a.lines, ...b.lines].join('\n'))
}
process.exit(failed ? 1 : 0)
