import type {
  AgentWire,
  BuildingDetail,
  ClientMessage,
  EventWire,
  Frame,
  Hello,
  Readouts,
  ScrubResult,
  ServerMessage,
} from '@civ/protocol'
import { fromBase64 } from '@civ/protocol'

/**
 * §21.6: the client's whole relationship with the world.
 *
 * There is no `Simulation` on this side any more, no `World`, no store and no
 * rng. What arrives is a delta of the §16.2 data texture, a list of masses to
 * generate, agent positions and events. What goes back is two questions — show
 * me an ordinal, tell me about a building — and nothing that could advance the
 * world, because there is one world and this is not the process that owns it.
 *
 * Frames land at ~10 Hz. `interpolate` below is what makes that read as motion
 * rather than as a strobe.
 */

export interface ConnectionHandlers {
  onHello(h: Hello): void
  onFrame(f: Frame): void
  onScrub(s: ScrubResult): void
  onBuilding(b: BuildingDetail): void
  onStatus(state: 'connecting' | 'live' | 'lost'): void
}

export class Connection {
  private ws: WebSocket | null = null
  private readonly url: string
  private readonly handlers: ConnectionHandlers
  private retry = 0
  private closed = false

  constructor(url: string, handlers: ConnectionHandlers) {
    this.url = url
    this.handlers = handlers
    this.open()
  }

  private open(): void {
    this.handlers.onStatus(this.retry === 0 ? 'connecting' : 'lost')
    const ws = new WebSocket(this.url)
    this.ws = ws
    ws.addEventListener('open', () => {
      this.retry = 0
      this.handlers.onStatus('live')
    })
    ws.addEventListener('message', (ev) => {
      const m = JSON.parse(String(ev.data)) as ServerMessage
      switch (m.t) {
        case 'hello':
          return this.handlers.onHello(m)
        case 'frame':
          return this.handlers.onFrame(m)
        case 'scrub':
          return this.handlers.onScrub(m)
        case 'building':
          return this.handlers.onBuilding(m)
        case 'error':
          return console.warn('[server]', m.message)
      }
    })
    const drop = () => {
      if (this.closed) return
      this.handlers.onStatus('lost')
      // The world keeps running without this viewer; reconnecting rejoins it
      // where it is now rather than resuming anything.
      this.retry = Math.min(this.retry + 1, 6)
      setTimeout(() => this.open(), 400 * 2 ** this.retry)
    }
    ws.addEventListener('close', drop)
    ws.addEventListener('error', () => ws.close())
  }

  send(m: ClientMessage): void {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(m))
  }

  close(): void {
    this.closed = true
    this.ws?.close()
  }
}

export { fromBase64 }
export type { AgentWire, EventWire, Frame, Hello, Readouts, ScrubResult, BuildingDetail }

/**
 * Agent presence, smoothed between frames.
 *
 * §5 is explicit that movement is never an event: positions are mutable state
 * broadcast in the frame and discarded. At 10 Hz, drawn raw, that is a strobe —
 * so each agent carries where it was and where it is, and the renderer reads a
 * position between them. Which is also why a dropped frame degrades into a
 * slightly long glide rather than a jump.
 */
export class AgentInterpolator {
  private from = new Map<string, { x: number; y: number }>()
  private to = new Map<string, AgentWire>()
  private t = 1
  private readonly period: number

  constructor(frameIntervalMs: number) {
    this.period = frameIntervalMs / 1000
  }

  accept(agents: AgentWire[], retired: string[]): void {
    // start the next leg from wherever the last one had reached
    for (const [id, a] of this.to) {
      const prev = this.from.get(id)
      const k = Math.min(1, this.t)
      this.from.set(id, {
        x: prev ? prev.x + (a.x - prev.x) * k : a.x,
        y: prev ? prev.y + (a.y - prev.y) * k : a.y,
      })
    }
    this.to = new Map(agents.map((a) => [a.id, a]))
    for (const id of retired) {
      this.from.delete(id)
      this.to.delete(id)
    }
    for (const a of agents) if (!this.from.has(a.id)) this.from.set(a.id, { x: a.x, y: a.y })
    this.t = 0
  }

  advance(dt: number): void {
    this.t = Math.min(1.4, this.t + dt / this.period)
  }

  /** Present agents, at their interpolated positions. */
  *positions(): Generator<AgentWire> {
    const k = Math.min(1, this.t)
    for (const [id, a] of this.to) {
      const f = this.from.get(id)
      if (!f) {
        yield a
        continue
      }
      yield { ...a, x: f.x + (a.x - f.x) * k, y: f.y + (a.y - f.y) * k }
    }
  }

  get count(): number {
    return this.to.size
  }
}
