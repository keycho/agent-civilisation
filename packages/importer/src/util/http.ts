import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
export const CACHE_DIR = join(HERE, '..', '..', '.cache')

/**
 * Node's global `fetch` ignores HTTPS_PROXY unless NODE_USE_ENV_PROXY is set,
 * and the flag is read when the process starts rather than when it is assigned,
 * so setting it here would be too late. Some hosts are reachable direct and
 * some are not — CBS answers curl (which uses the proxy) with 200 and an
 * unproxied fetch with 406 — so a run without it fails in a way that looks like
 * content negotiation rather than like a network policy.
 *
 * Fail loudly at import instead of letting a source half-work.
 */
if (!process.env.NODE_USE_ENV_PROXY && (process.env.HTTPS_PROXY || process.env.https_proxy)) {
  console.warn(
    '  ! HTTPS_PROXY is set but NODE_USE_ENV_PROXY is not, so fetch will bypass the proxy.\n' +
      '    Re-run with NODE_USE_ENV_PROXY=1, or use the npm scripts, which set it.',
  )
}

/**
 * Every upstream response is cached on disk keyed by request. Overpass mirrors
 * are heavily loaded and a full import is dozens of requests; without this,
 * iterating on the derivation steps means re-hammering someone else's server.
 */
export async function cached<T>(key: string, produce: () => Promise<T>): Promise<T> {
  const hash = createHash('sha1').update(key).digest('hex').slice(0, 16)
  const path = join(CACHE_DIR, `${hash}.json`)
  try {
    const raw = await readFile(path, 'utf8')
    return JSON.parse(raw) as T
  } catch {
    /* miss */
  }
  const value = await produce()
  await mkdir(CACHE_DIR, { recursive: true })
  await writeFile(path, JSON.stringify(value))
  return value
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

export interface RetryOptions {
  attempts?: number
  baseDelayMs?: number
  timeoutMs?: number
  label?: string
}

export async function fetchWithRetry(
  url: string,
  init: RequestInit = {},
  opts: RetryOptions = {},
): Promise<Response> {
  const attempts = opts.attempts ?? 5
  const base = opts.baseDelayMs ?? 3000
  const timeout = opts.timeoutMs ?? 180_000
  let lastErr: unknown

  for (let i = 0; i < attempts; i++) {
    const ac = new AbortController()
    const timer = setTimeout(() => ac.abort(), timeout)
    try {
      const res = await fetch(url, { ...init, signal: ac.signal })
      clearTimeout(timer)
      if (res.ok) return res
      // 429/504 from Overpass means "busy", which is worth waiting out.
      if (res.status === 429 || res.status >= 500) {
        lastErr = new Error(`${res.status} ${res.statusText}`)
      } else {
        throw new Error(`${opts.label ?? url}: ${res.status} ${res.statusText}`)
      }
    } catch (err) {
      clearTimeout(timer)
      lastErr = err
    }
    const delay = base * 2 ** i
    process.stderr.write(
      `  retry ${i + 1}/${attempts} in ${(delay / 1000).toFixed(0)}s (${opts.label ?? url}): ${String(lastErr)}\n`,
    )
    await sleep(delay)
  }
  throw new Error(`${opts.label ?? url}: exhausted retries — ${String(lastErr)}`)
}
