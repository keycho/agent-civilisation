/**
 * Production connection check. NOTE: in the sandboxed build environment
 * Chromium cannot reach external hosts through the egress proxy
 * (ERR_CONNECTION_RESET) even though curl and node can, so this script is for
 * running where the browser has real egress. The headless-free equivalent —
 * resolve the ws url the deployed bundle would, then open it and read the
 * hello — is what was used to verify the production fix.
 */
import { chromium } from 'playwright'
const URL = process.argv[2] ?? 'https://terrafork-brown.vercel.app/'
const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox', '--ignore-certificate-errors', '--disable-features=NetworkServiceSandbox'],
  proxy: process.env.HTTPS_PROXY ? { server: process.env.HTTPS_PROXY } : undefined })
const page = await browser.newPage({ viewport: { width: 1280, height: 720 }, ignoreHTTPSErrors: true })
const sockets = []
page.on('websocket', (ws) => { sockets.push(ws.url()); ws.on('socketerror', (e) => console.log('   WS ERROR', e)) })
page.on('pageerror', (e) => console.log('PAGE EXCEPTION', e.message))
await page.goto(URL, { waitUntil: 'domcontentloaded' })
await page.waitForFunction(() => window.civ != null, null, { timeout: 120000 })
await page.waitForTimeout(9000)
console.log('ws urls opened:', sockets.length ? sockets.join(', ') : '(none)')
console.log('link state   :', await page.evaluate(() => document.getElementById('link')?.textContent))
console.log('readouts     :', await page.evaluate(() => { const r = window.civ.readouts; return r ? `gen ${r.generation} · ${(r.divergenceIndex*100).toFixed(1)}% diff · ${r.viewers} watching · season ${r.season}` : 'none' }))
await page.screenshot({ path: 'tools/watch/ab/production.png' })
await browser.close()
