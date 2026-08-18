/**
 * §51.3 evidence (+ wishlist agent log and identity colour). Live local
 * supervisor, because a roster with statuses needs a running world:
 *
 *   a — the status bar's `agents N`, clicked, opening the full crew roster
 *   b — a floating marker hovered: the mini-card without committing to follow
 *   c — following: <name>.log in pane grammar, world.log still the world's
 *
 * Also asserts the identity colour is one value across marker glyph, crew
 * chip, log line and sheet.
 *
 *   node tools/watch/evidence-51-3.mjs <out-dir> [ws-url]
 */
import { chromium } from 'playwright'
import { mkdir } from 'node:fs/promises'

const OUT = process.argv[2] ?? 'tools/watch/evidence/51-3'
const WS = process.argv[3] ?? 'ws://127.0.0.1:8820/ws/schiedam-havens'
await mkdir(OUT, { recursive: true })

const browser = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox'],
})
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } })
page.on('pageerror', (e) => console.log('PAGE EXCEPTION', e.message))
await page.goto(`http://127.0.0.1:5173/?chunk=schiedam-havens&server=${encodeURIComponent(WS)}`, {
  waitUntil: 'domcontentloaded',
})
await page.waitForFunction(() => window.civ != null, null, { timeout: 120000 })
await page.evaluate(() => document.getElementById('watchBtn')?.click())
await page.waitForTimeout(6000)

// a: the status bar affordance opens the full roster
const btn = await page.textContent('#agentsBtn')
await page.click('#agentsBtn')
await page.waitForTimeout(500)
const crew = await page.evaluate(() => ({
  rows: document.querySelectorAll('#crew .a').length,
  bands: [...document.querySelectorAll('#crew .grp')].map((g) => g.textContent),
  meta: document.getElementById('crewMeta').textContent,
  firstBand: document.querySelector('#crew .grp')?.textContent,
  rosterSize: window.civ.roster.size,
}))
console.log('agents button:', JSON.stringify(btn), 'crew:', JSON.stringify(crew))
await page.screenshot({ path: `${OUT}/a-crew-roster.png` })

// b: hover a floating marker -> mini-card, no follow committed
const mark = await page.evaluate(() => {
  const { rig } = window.civ
  const marks = window.civ.floatMarks()
  if (!marks.length) return null
  const v = marks[0].position.clone().project(rig.camera)
  return {
    id: marks[0].id,
    x: ((v.x + 1) / 2) * innerWidth,
    y: (1 - (v.y + 1) / 2) * innerHeight,
  }
})
console.log('mark:', JSON.stringify(mark))
if (mark) {
  await page.mouse.move(mark.x, mark.y)
  await page.waitForTimeout(1400)
  await page.mouse.move(mark.x + 1, mark.y)
  await page.waitForTimeout(900)
  const mini = await page.evaluate(() => ({
    on: document.getElementById('miniCard').classList.contains('on'),
    text: document.getElementById('miniCard').textContent,
    following: !!window.civ.followedId(),
  }))
  console.log('mini-card:', JSON.stringify(mini))
  await page.screenshot({ path: `${OUT}/b-mini-card.png` })
}

// c: follow the busiest agent -> <name>.log, world.log unfiltered
const followed = await page.evaluate(() => {
  const rows = [...document.querySelectorAll('#crew .a')]
  const row = rows.find((r) => r.classList.contains('working')) ?? rows[0]
  row?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  return row?.querySelector('.nm')?.textContent ?? null
})
await page.waitForTimeout(9000)
const logs = await page.evaluate(() => ({
  paneName: document.getElementById('agentLogName').textContent,
  paneMeta: document.getElementById('agentLogMeta').textContent,
  agentRows: document.querySelectorAll('#agentFeed .e').length,
  paneVisible: getComputedStyle(document.getElementById('agentLog')).display !== 'none',
  worldRows: document.querySelectorAll('#feedList .e:not(.roll):not(.count)').length,
  worldAgents: new Set(
    [...document.querySelectorAll('#feedList .e .t b')].map((b) => b.textContent),
  ).size,
}))
console.log('followed:', followed, 'logs:', JSON.stringify(logs))
await page.screenshot({ path: `${OUT}/c-agent-log.png` })

// identity colour: one value everywhere it appears
const colours = await page.evaluate(() => {
  const id = window.civ.followedId()
  const who = window.civ.roster.get(id)
  if (!who) return null
  const want = window.civ.colourOf(who.strategy, who.colourIndex)
  const chip = document.querySelector(`#crew .a[data-id="${id}"] .chip`)
  const nm = document.querySelector(`#crew .a[data-id="${id}"] .nm`)
  const paneName = document.getElementById('agentLogName')
  const sheet = document.getElementById('insName')
  const hex = (c) => {
    const m = c.match(/\d+/g)
    return m ? '#' + m.slice(0, 3).map((n) => (+n).toString(16).padStart(2, '0')).join('') : c
  }
  return {
    want,
    chip: chip ? hex(getComputedStyle(chip).backgroundColor) : null,
    crewName: nm ? hex(getComputedStyle(nm).color) : null,
    paneName: hex(getComputedStyle(paneName).color),
    sheetName: hex(getComputedStyle(sheet).color),
  }
})
console.log('identity colour:', JSON.stringify(colours))

console.log(`§51.3 evidence -> ${OUT}`)
await browser.close()
