import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
export const CACHE_DIR = join(HERE, '..', '..', '.cache')

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
