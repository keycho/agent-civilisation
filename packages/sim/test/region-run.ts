/**
 * §31.6-5: the region suite. Runs N region seeds and judges them against the
 * contract pre-registered in contract-region.ts — as written, §43.2 included,
 * with the harness producing the shape the contract demanded rather than the
 * contract bending to what the harness found convenient. Failed asserts are
 * findings to report, never inputs to retune (§18, standing).
 *
 *   node --no-warnings packages/sim/test/region-run.ts [seeds] [regionBudget]
 *
 * Budget: 220k region decisions lands near the single-chunk DECISION_BUDGET
 * per chunk once ~6.5 chunks tick. The §43.2 rate normalises per 34k either
 * way, and a chunk that got fewer decisions than the single-chunk suite
 * biases the floor comparison HARDER (chains in flight at cutoff count as
 * nothing), so the budget cannot soften the bar. The control runs the same
 * frozen 34k as tune.ts (§20.9).
 */
import { execFile } from 'node:child_process'
import { availableParallelism } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import {
  REGION_RULES,
  type RegionRunSummary,
  assertContract,
} from './contract-region.ts'
import { DORMANT_NL, SEEDED_FIVE, loadRoster } from './lib/region-info.ts'
import { DECISION_BUDGET } from './lib/summarise.ts'

const run = promisify(execFile)
const HERE = dirname(fileURLToPath(import.meta.url))

const SEEDS = Number(process.argv[2] ?? 8)
const REGION_BUDGET = Number(process.argv[3] ?? 220_000)

// ---------------------------------------------------------------------------
// §33.1 preflight: a chunk below the ownable floor does not join the region
// world regardless of how good it looks — refused here, loudly, before any
// sim runs, so the contract's importHealth assertion reports on a roster that
// was actually allowed to exist.
// ---------------------------------------------------------------------------
const roster = await loadRoster()
console.log('§31.6-5 region suite — roster')
for (const [id, h] of Object.entries(roster.importHealth)) {
  const share = h.ownableShare ?? 1
  const seededMark = (SEEDED_FIVE as readonly string[]).includes(id) ? 'seeded ' : 'dormant'
  console.log(
    `  ${id.padEnd(22)} ${seededMark}  ownable ${(share * 100).toFixed(1)}%  ` +
      `heights ${(h.heightsReal * 100).toFixed(0)}%  years ${(h.yearsPresent * 100).toFixed(0)}%`,
  )
  if (share < REGION_RULES.minOwnableShare) {
    console.error(
      `\nREFUSED: ${id} ownable share ${share.toFixed(3)} < ${REGION_RULES.minOwnableShare} — ` +
        `not ready to join the region world (§33.1). Fix the import; do not lower the floor.`,
    )
    process.exit(1)
  }
}
console.log(
  `  seeded: ${SEEDED_FIVE.join(', ')}\n  dormant candidates: ${DORMANT_NL.join(', ')}`,
)

// ---------------------------------------------------------------------------
// N region seeds, in parallel — each child holds the whole region plus a
// control sim, so the worker cap is memory-led, tighter than tune.ts's.
// ---------------------------------------------------------------------------
const workers = Math.max(1, Math.min(SEEDS, availableParallelism() - 1, 4))
console.log(
  `\nrunning ${SEEDS} region seeds across ${workers} workers ` +
    `(${REGION_BUDGET.toLocaleString()} region decisions + ${DECISION_BUDGET.toLocaleString()} control each)…`,
)

const t0 = Date.now()
const queue = Array.from({ length: SEEDS }, (_, i) => `region-seed-${i}`)
const runs: RegionRunSummary[] = []

await Promise.all(
  Array.from({ length: workers }, async () => {
    for (;;) {
      const seed = queue.shift()
      if (!seed) return
      const { stdout } = await run(
        process.execPath,
        [
          '--no-warnings',
          join(HERE, 'run-region-seed.ts'),
          seed,
          String(REGION_BUDGET),
          String(DECISION_BUDGET),
        ],
        { maxBuffer: 256 * 1024 * 1024 },
      )
      runs.push(JSON.parse(stdout) as RegionRunSummary)
      process.stderr.write(`  ${runs.length}/${SEEDS}\r`)
    }
  }),
)
runs.sort((a, b) => a.seed.localeCompare(b.seed))
console.log(`done in ${((Date.now() - t0) / 1000).toFixed(0)}s\n`)

// ---------------------------------------------------------------------------
// per-seed digest, before the contract speaks — the raw record the verdicts
// are judged against
// ---------------------------------------------------------------------------
console.log('seed             materialised                       migr rev  flow  hottest')
for (const r of runs) {
  const extra = r.materialised.filter((m) => !r.seeded.includes(m))
  const rev = r.migrations.filter((m) => m.reversed).length
  const hottest = Object.entries(r.contestBySettlement).sort((a, b) => b[1] - a[1])[0]?.[0] ?? '—'
  console.log(
    `${r.seed.padEnd(15)}  ${(extra.length ? `5+${extra.map((x) => x.split('-')[0]).join('+')}` : '5 (none extra)').padEnd(33)} ` +
      `${String(r.migrations.length).padStart(4)} ${String(rev).padStart(3)}  ` +
      `${r.chainCompletionFlow.toFixed(1).padStart(4)}  ${hottest.split('-')[0]}`,
  )
}

// ---------------------------------------------------------------------------
// the contract, as registered
// ---------------------------------------------------------------------------
console.log('\n§30.4/§31.5/§43.2 contract')
const results = assertContract(runs)
let failed = 0
for (const c of results) {
  if (c.kind === 'report') {
    console.log(`  · ${c.label}\n      ${c.detail}`)
  } else {
    if (!c.ok) failed++
    console.log(`  ${c.ok ? '✓' : '✗'} ${c.label}${c.detail ? ` — ${c.detail}` : ''}`)
  }
}

if (failed > 0) {
  console.log(
    `\n${failed} contract assertion(s) failed. These are findings to escalate ` +
      `(§18/§30.4): the mechanism gets a look, the contract does not get retuned.`,
  )
  process.exit(1)
}
console.log('\ncontract green: all pre-registered assertions hold.')
