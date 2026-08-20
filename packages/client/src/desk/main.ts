/**
 * §79: the desk. The worlds index and the token page in one screen.
 *
 * Every figure here is REAL. The prototype faked all of it on a 640ms/2600ms
 * interval pair; the server's `/summary` already carries, per chunk, the
 * divergence index, the agent count, how many are working, standing buildings,
 * the event count, the generation, a recent-activity weight and the last
 * high-weight event with its author. So the whole page runs off one existing
 * endpoint and nothing needed adding to the server.
 *
 * What that costs, stated rather than hidden: the wire is a POLL, not a
 * stream. `/summary` reports each world's most recent high-weight event, so a
 * row appears when a world's headline event changes — real events, real
 * authors, at the poll's cadence rather than the world's. The viewer at /w/
 * is where the live socket is. Calling this a stream in the copy would be
 * claiming a fidelity it does not have.
 */
import { DESK, UNSET, bound, unboundFields } from './config.ts'

const SERVER = new URLSearchParams(location.search).get('server') ?? inferServer()
const POLL_MS = 2000
const WIRE_CAP = 9

function inferServer(): string {
  // same default the viewer uses: the deployed server, or the local one in dev
  const local = location.hostname === '127.0.0.1' || location.hostname === 'localhost'
  return local ? 'http://127.0.0.1:8820' : 'https://agent-civilisation-production.up.railway.app'
}

const $ = <T extends Element>(s: string, r: ParentNode = document) => r.querySelector(s) as T | null
const $$ = <T extends Element>(s: string, r: ParentNode = document) => [
  ...r.querySelectorAll(s),
] as T[]

const num = (n: number): string => n.toLocaleString('en-us')
const pad = (n: number): string => String(n).padStart(2, '0')
const clockNow = (): string => {
  const d = new Date()
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}
const esc = (s: string): string =>
  s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!)

// ---------------------------------------------------------------------------
// naming
// ---------------------------------------------------------------------------

/**
 * The same judgement the viewer makes in `settlementLabel`, and for the same
 * reason: "deptford" and "red hook" are places, while "dorp" and "haven" are
 * Dutch for village and harbour, so those chunks are called by their town.
 * A stated list rather than a rule, because there is no rule — it is a
 * judgement about eight names.
 */
const GENERIC = new Set(['dorp', 'haven', 'havens', 'centrum', 'west', 'oost', 'noord', 'zuid'])

interface Roster {
  chunks: Array<{ id: string; name: string }>
}
let roster: Roster = { chunks: [] }

function label(id: string): string {
  const c = roster.chunks.find((x) => x.id === id)
  if (!c) return id.replace(/-/g, ' ')
  const parts = c.name.split(/\s+—\s+/)
  const city = parts[0].trim().toLowerCase()
  const district = (parts[1] ?? parts[0]).split('/')[0].trim().toLowerCase()
  return GENERIC.has(district) ? `${district}, ${city}` : `${district}, ${city}`
}

// ---------------------------------------------------------------------------
// state
// ---------------------------------------------------------------------------

interface Summary {
  id: string
  generation: number
  divergenceIndex: number
  eventCount: number
  buildings: number
  agentCount: number
  working: number
  heat: number
  lastEvent?: { text: string; weight: number }
}

interface WireRow {
  t: string
  place: string
  text: string
}

let worlds: Summary[] = []
let selected = 0
let wire: WireRow[] = []
let tick = 0
/** the previous poll's headline per world, so only CHANGES enter the wire */
const lastSeen = new Map<string, string>()
/** for the per-second rate: the last total and when it was read */
let prevTotal = 0
let prevAt = 0
let ratePerSec = 0

// ---------------------------------------------------------------------------
// config binding
// ---------------------------------------------------------------------------

function bindConfig(): void {
  const missing = unboundFields()
  if (missing.length) {
    console.warn(
      `[desk] ${missing.length} unbound field(s): ${missing.join(', ')}. ` +
        `The page renders an explicit unset state for these. See src/desk/config.ts.`,
    )
  }

  const ca = $<HTMLElement>('#ca')!
  if (bound(DESK.tokenMint)) {
    ca.textContent = DESK.tokenMint
    ca.removeAttribute('data-unset')
  } else {
    ca.textContent = UNSET
    ca.setAttribute('data-unset', 'true')
  }

  // a button with nowhere to go is disabled rather than dressed as an action
  for (const el of $$<HTMLElement>('.btn-copy')) {
    el.setAttribute('aria-disabled', String(!bound(DESK.tokenMint)))
  }
  for (const [sel, url] of [
    ['#pumpfun', DESK.pumpfunUrl],
    ['#chan-x', DESK.xUrl],
    ['#chan-site', DESK.siteUrl],
  ] as const) {
    const el = $<HTMLAnchorElement>(sel)
    if (!el) continue
    if (bound(url)) {
      el.href = url
      el.rel = 'noopener'
      el.target = '_blank'
      el.removeAttribute('aria-disabled')
    } else {
      el.removeAttribute('href')
      el.setAttribute('aria-disabled', 'true')
    }
  }
  const pair = $<HTMLElement>('[data-ph="pair"]')
  if (pair) pair.textContent = bound(DESK.pair) ? ` · ${DESK.pair}` : ''
  const listing = $<HTMLElement>('[data-ph="listing_line"]')
  if (listing && bound(DESK.pumpfunUrl)) listing.textContent = '$fork listed on pump.fun'
}

// ---------------------------------------------------------------------------
// worlds table
// ---------------------------------------------------------------------------

function rowHtml(w: Summary): string {
  const diff = `${(w.divergenceIndex * 100).toFixed(1)}%`
  const work = w.working > 0 ? `${w.working} working` : 'idle'
  return (
    `<span class="wrow__name">${esc(label(w.id))}</span>` +
    `<span class="wrow__diff">${diff}</span>` +
    `<span class="meter" data-live="meter">${'<i></i>'.repeat(12)}</span>` +
    `<span class="wrow__work" data-working="${w.working > 0}">${work}</span>`
  )
}

function paintWorlds(): void {
  const body = $<HTMLElement>('#worlds-body')!
  if (body.childElementCount !== worlds.length) {
    body.innerHTML = ''
    worlds.forEach((w, i) => {
      const a = document.createElement('a')
      a.className = 'wrow'
      a.setAttribute('role', 'option')
      a.href = `/w/${w.id}`
      a.addEventListener('click', (e) => {
        e.preventDefault()
        select(i)
        dive()
      })
      body.appendChild(a)
    })
  }
  const rows = $$<HTMLElement>('.wrow', body)
  worlds.forEach((w, i) => {
    rows[i].innerHTML = rowHtml(w)
    rows[i].setAttribute('aria-selected', String(i === selected))
    ;(rows[i] as HTMLAnchorElement).href = `/w/${w.id}`
  })
  paintMeters()
  const meta = $<HTMLElement>('#worlds-meta')!
  const gen = Math.max(0, ...worlds.map((w) => w.generation))
  meta.textContent = `${worlds.length} live · gen ${gen} · arrows select, enter dives`
}

/**
 * §67's rule, carried over: the meter is scaled against the BUSIEST world on
 * the board, not against each row's own maximum. Self-normalising makes a dead
 * world's noise floor look like a working city's peak, and the column has to
 * be readable across rows or it says nothing.
 */
function paintMeters(): void {
  const peak = Math.max(1, ...worlds.map((w) => w.heat))
  $$<HTMLElement>('.wrow').forEach((row, i) => {
    const w = worlds[i]
    if (!w) return
    const filled = Math.max(1, Math.min(12, Math.round((w.heat / peak) * 12)))
    const lead = w.working > 0 ? (tick + i) % filled : -1
    $$<HTMLElement>('i', row).forEach((cell, c) => {
      if (c < filled) cell.setAttribute('data-meter-fill', '')
      else cell.removeAttribute('data-meter-fill')
      if (c === lead) cell.setAttribute('data-meter-lead', '')
      else cell.removeAttribute('data-meter-lead')
    })
  })
}

function select(i: number): void {
  selected = Math.max(0, Math.min(worlds.length - 1, i))
  $$<HTMLElement>('.wrow').forEach((r, n) =>
    r.setAttribute('aria-selected', String(n === selected)),
  )
}

function dive(): void {
  const w = worlds[selected]
  if (w) location.href = `/w/${w.id}`
}

// ---------------------------------------------------------------------------
// wire
// ---------------------------------------------------------------------------

function paintWire(): void {
  const el = $<HTMLElement>('#wire')!
  if (!wire.length) return
  el.setAttribute('data-state', 'live')
  el.innerHTML = wire
    .map(
      (e) =>
        `<div class="wire__row"><div class="wire__head"><time>${e.t}</time><span>${esc(
          e.place,
        )}</span></div>` +
        `<div class="wire__line"><b class="wire__txt">${esc(e.text)}</b></div></div>`,
    )
    .join('')
}

// ---------------------------------------------------------------------------
// numbers and tape
// ---------------------------------------------------------------------------

function paintNumbers(): void {
  const events = worlds.reduce((n, w) => n + w.eventCount, 0)
  const buildings = worlds.reduce((n, w) => n + w.buildings, 0)
  const agents = worlds.reduce((n, w) => n + w.agentCount, 0)
  const gens = worlds.reduce((n, w) => n + w.generation, 0)

  for (const el of $$<HTMLElement>('[data-live="events"]')) el.textContent = num(events)
  const set = (f: string, v: string) => {
    const el = $<HTMLElement>(`[data-field="${f}"]`)
    if (el) el.textContent = v
  }
  set('buildings', num(buildings))
  set('agents', num(agents))
  set('generations', num(gens))

  const now = performance.now()
  if (prevAt && events > prevTotal) {
    const dt = (now - prevAt) / 1000
    if (dt > 0.5) ratePerSec = (events - prevTotal) / dt
  }
  if (!prevAt || events !== prevTotal) {
    prevTotal = events
    prevAt = now
  }
  const rate = $<HTMLElement>('[data-live="events-rate"]')
  if (rate) rate.textContent = `+${ratePerSec.toFixed(0)} events/sec`

  // boot-log figures are copy, but the numbers inside them are real
  const bind = (f: string, v: string) => {
    const el = $<HTMLElement>(`[data-ph="${f}"]`)
    if (el) el.textContent = v
  }
  bind('buildings_total', num(buildings))
  bind('agents_seeded', num(agents))
  bind('agents_alive', num(agents))
  bind('generation', num(Math.max(0, ...worlds.map((w) => w.generation))))

  paintStandings()
  paintTape(num(events), num(buildings), num(agents))
}

/**
 * §79.3: the spread, which the stat strip cannot show because it sums.
 * Reads the same `worlds` the table does — no extra fetch, no second source.
 */
function paintStandings(): void {
  if (!worlds.length) return
  const by = (f: (w: Summary) => number) => worlds.slice().sort((a, b) => f(b) - f(a))
  const most = by((w) => w.divergenceIndex)[0]
  const busy = by((w) => w.working)[0]
  const least = by((w) => -w.divergenceIndex)[0]
  const set = (k: string, v: string) => {
    const el = $<HTMLElement>(`[data-stand="${k}"]`)
    if (el) el.innerHTML = v
  }
  set('most', `${esc(label(most.id))} <b>${(most.divergenceIndex * 100).toFixed(1)}%</b>`)
  set(
    'busy',
    busy.working > 0
      ? `${esc(label(busy.id))} <b>${busy.working}</b> working`
      : `<b>nobody</b> is building`,
  )
  set('least', `${esc(label(least.id))} <b>${(least.divergenceIndex * 100).toFixed(1)}%</b>`)
}

function paintTape(events: string, buildings: string, agents: string): void {
  const gen = Math.max(0, ...worlds.map((w) => w.generation))
  const items: Array<[string, string, boolean?]> = [
    ['gen', `${gen} sealed`],
    ['agents', `${agents} alive`],
    ['buildings', `${buildings} standing`],
    ['events', events],
    ['worlds', `${worlds.length} running unattended`],
    ['nothing', 'is scripted'],
  ]
  const set =
    '<div class="tape__set">' +
    items
      .map(
        (it) =>
          `<span><b class="${it[2] ? 'hot' : ''}">${esc(it[0])}</b> ${esc(it[1])} <i>/</i></span>`,
      )
      .join('') +
    '</div>'
  const tape = $<HTMLElement>('#tape')
  if (tape) tape.innerHTML = set + set
}

// ---------------------------------------------------------------------------
// polling
// ---------------------------------------------------------------------------

async function poll(): Promise<void> {
  try {
    const res = await fetch(`${SERVER}/summary`, { cache: 'no-store' })
    if (!res.ok) throw new Error(`summary ${res.status}`)
    const next = (await res.json()) as Summary[]
    if (!Array.isArray(next) || !next.length) return

    // busiest first, so the column the meter draws is also the sort
    worlds = next.slice().sort((a, b) => b.heat - a.heat)
    tick++

    for (const w of worlds) {
      const head = w.lastEvent?.text
      if (!head) continue
      if (lastSeen.get(w.id) === head) continue
      lastSeen.set(w.id, head)
      // the first poll seeds the buffer without pretending each line is new
      wire.unshift({ t: clockNow(), place: label(w.id), text: head })
    }
    wire = wire.slice(0, WIRE_CAP)

    paintWorlds()
    paintNumbers()
    paintWire()
  } catch (err) {
    const meta = $<HTMLElement>('#worlds-meta')
    if (meta && !worlds.length) meta.textContent = 'server unreachable'
    console.warn('[desk] poll failed', err)
  }
}

// ---------------------------------------------------------------------------
// interactions
// ---------------------------------------------------------------------------

function wireInteractions(): void {
  const body = $<HTMLElement>('#worlds-body')!
  body.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown' || e.key === 'j') {
      e.preventDefault()
      select(selected + 1)
    } else if (e.key === 'ArrowUp' || e.key === 'k') {
      e.preventDefault()
      select(selected - 1)
    } else if (e.key === 'Enter') {
      e.preventDefault()
      dive()
    }
  })

  for (const btn of $$<HTMLElement>('[data-copy]')) {
    btn.addEventListener('click', () => {
      if (!bound(DESK.tokenMint)) return
      navigator.clipboard?.writeText(DESK.tokenMint).catch(() => {})
      btn.classList.add('is-done')
      btn.textContent = 'copied'
      setTimeout(() => {
        btn.classList.remove('is-done')
        btn.textContent = 'copy ca'
      }, 1400)
    })
  }
}

// ---------------------------------------------------------------------------
// boot
// ---------------------------------------------------------------------------

function runBoot(): void {
  const boot = $<HTMLElement>('#boot')!
  const desk = $<HTMLElement>('#desk')!
  const enter = (): void => {
    boot.classList.add('is-out')
    setTimeout(() => {
      boot.hidden = true
    }, 280)
    desk.classList.remove('is-booting')
    desk.classList.add('is-entering')
    try {
      sessionStorage.setItem('tf.booted', '1')
    } catch {
      /* private mode: show it again, which is the harmless direction */
    }
  }
  let seen = false
  try {
    seen = sessionStorage.getItem('tf.booted') === '1'
  } catch {
    seen = false
  }
  if (seen || matchMedia('(prefers-reduced-motion: reduce)').matches) {
    boot.hidden = true
    desk.classList.remove('is-booting')
    return
  }
  setTimeout(enter, 2100)
  addEventListener('keydown', enter, { once: true })
  boot.addEventListener('click', enter, { once: true })
}

// ---------------------------------------------------------------------------

async function start(): Promise<void> {
  bindConfig()
  wireInteractions()
  runBoot()
  try {
    const res = await fetch('/world/index.json', { cache: 'force-cache' })
    if (res.ok) roster = (await res.json()) as Roster
  } catch {
    /* names fall back to the slug; the page still works */
  }
  await poll()
  setInterval(poll, POLL_MS)
}

void start()
