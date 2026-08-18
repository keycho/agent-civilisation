/**
 * §40.5: the log as audio.
 *
 * A soft tick per routine event, a low thud on demolition, a rising tone on
 * construction complete, with the density of ticks tracking the activity rate
 * — so a busy generation sounds busy. Generative, no loops, and muted by
 * default with the toggle in the bottom bar.
 *
 * Synthesized on the WebAudio graph directly rather than through tone.js: the
 * whole vocabulary is three envelopes over two oscillators and a noise burst,
 * and a library for that would be more bytes than the feature.
 *
 * Wishlist: physical events are placed rather than global. A demolition on the
 * far bank should not be as loud as one under the camera, and the ear is how a
 * viewer notices work happening off-frame. Each placed sound gets a gain from
 * its distance to the camera and a stereo pan from which side of the view it
 * fired on, so the soundscape is a second reading of the same map §50.3's
 * windows draw.
 */

export interface Placement {
  /** 0 at the camera, 1 at the far edge of what is being looked at */
  distance: number
  /** -1 hard left, 0 centre, +1 hard right */
  pan: number
}

const CENTRE: Placement = { distance: 0.4, pan: 0 }

export class WorldSound {
  private ctx: AudioContext | null = null
  private master: GainNode | null = null
  private enabled = false
  /** ticks are rate-limited: a busy world must not become a buzz */
  private lastTick = 0
  private tickBudget = 0

  get on(): boolean {
    return this.enabled
  }

  /**
   * Browsers only allow an AudioContext to start inside a gesture, which is
   * exactly where this is called from — the toggle.
   */
  setEnabled(on: boolean): boolean {
    this.enabled = on
    if (!on) {
      if (this.master && this.ctx) this.master.gain.setTargetAtTime(0, this.ctx.currentTime, 0.05)
      return false
    }
    if (!this.ctx) {
      const Ctor =
        window.AudioContext ??
        (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
      if (!Ctor) {
        this.enabled = false
        return false
      }
      this.ctx = new Ctor()
      this.master = this.ctx.createGain()
      this.master.gain.value = 0
      this.master.connect(this.ctx.destination)
    }
    void this.ctx.resume()
    this.master!.gain.setTargetAtTime(0.5, this.ctx.currentTime, 0.08)
    return true
  }

  /** the per-frame budget refill — density tracks the world's own rate */
  update(dt: number, eventsPerSecond: number): void {
    // at most ~6 ticks a second however fast the world runs, and fewer when
    // it is quiet, so quiet reads as quiet rather than as silence with gaps
    this.tickBudget = Math.min(6, this.tickBudget + dt * Math.min(6, 1 + eventsPerSecond))
  }

  /** a routine event: the soft tick, rate-limited by the budget */
  tick(at: Placement = CENTRE): void {
    if (!this.ready()) return
    if (this.tickBudget < 1) return
    this.tickBudget -= 1
    const ctx = this.ctx!
    const now = ctx.currentTime
    if (now - this.lastTick < 0.045) return
    this.lastTick = now
    const osc = ctx.createOscillator()
    osc.type = 'triangle'
    osc.frequency.value = 1750 + Math.sin(now * 3.1) * 90
    const env = ctx.createGain()
    env.gain.setValueAtTime(0.0001, now)
    env.gain.exponentialRampToValueAtTime(0.05, now + 0.004)
    env.gain.exponentialRampToValueAtTime(0.0001, now + 0.07)
    osc.connect(env)
    this.place(env, at)
    osc.start(now)
    osc.stop(now + 0.09)
  }

  /** demolition: a low thud with a noise tail, the mass coming down */
  thud(at: Placement = CENTRE): void {
    if (!this.ready()) return
    const ctx = this.ctx!
    const now = ctx.currentTime
    const osc = ctx.createOscillator()
    osc.type = 'sine'
    osc.frequency.setValueAtTime(150, now)
    osc.frequency.exponentialRampToValueAtTime(38, now + 0.42)
    const env = ctx.createGain()
    env.gain.setValueAtTime(0.0001, now)
    env.gain.exponentialRampToValueAtTime(0.4, now + 0.012)
    env.gain.exponentialRampToValueAtTime(0.0001, now + 0.6)
    osc.connect(env)
    this.place(env, at)
    osc.start(now)
    osc.stop(now + 0.62)

    const noise = ctx.createBufferSource()
    const buf = ctx.createBuffer(1, Math.floor(ctx.sampleRate * 0.5), ctx.sampleRate)
    const d = buf.getChannelData(0)
    for (let i = 0; i < d.length; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / d.length) ** 2.4
    noise.buffer = buf
    const nf = ctx.createBiquadFilter()
    nf.type = 'lowpass'
    nf.frequency.value = 420
    const ng = ctx.createGain()
    ng.gain.value = 0.24
    noise.connect(nf).connect(ng)
    this.place(ng, at)
    noise.start(now + 0.01)
  }

  /** construction complete: a rising two-note tone, the only figure that lifts */
  rise(at: Placement = CENTRE): void {
    if (!this.ready()) return
    const ctx = this.ctx!
    const now = ctx.currentTime
    const osc = ctx.createOscillator()
    osc.type = 'triangle'
    osc.frequency.setValueAtTime(392, now)
    osc.frequency.setValueAtTime(523.25, now + 0.11)
    const env = ctx.createGain()
    env.gain.setValueAtTime(0.0001, now)
    env.gain.exponentialRampToValueAtTime(0.16, now + 0.02)
    env.gain.exponentialRampToValueAtTime(0.0001, now + 0.42)
    osc.connect(env)
    this.place(env, at)
    osc.start(now)
    osc.stop(now + 0.44)
  }

  /** §40.4: the milestone sting, under the title card */
  swell(): void {
    if (!this.ready()) return
    const ctx = this.ctx!
    const now = ctx.currentTime
    for (const [i, f] of [261.63, 392, 523.25].entries()) {
      const osc = ctx.createOscillator()
      osc.type = 'sine'
      osc.frequency.value = f
      const env = ctx.createGain()
      env.gain.setValueAtTime(0.0001, now)
      env.gain.exponentialRampToValueAtTime(0.07, now + 0.5 + i * 0.12)
      env.gain.exponentialRampToValueAtTime(0.0001, now + 2.6)
      osc.connect(env).connect(this.master!)
      osc.start(now)
      osc.stop(now + 2.7)
    }
  }

  /**
   * Wishlist: distance and side. A StereoPannerNode plus a distance gain is
   * enough — a full PannerNode would need a listener orientation kept in sync
   * with an orbit camera every frame to buy nothing the ear can hear at this
   * scale.
   */
  private place(node: AudioNode, at: Placement): void {
    const ctx = this.ctx!
    const gain = ctx.createGain()
    // inverse-ish falloff, floored so a far event is quiet, never absent
    gain.gain.value = 0.18 + 0.82 / (1 + 3.2 * Math.max(0, at.distance) ** 2)
    node.connect(gain)
    if (ctx.createStereoPanner) {
      const panner = ctx.createStereoPanner()
      panner.pan.value = Math.max(-1, Math.min(1, at.pan)) * 0.75
      gain.connect(panner).connect(this.master!)
    } else {
      gain.connect(this.master!)
    }
  }

  private ready(): boolean {
    return this.enabled && this.ctx !== null && this.ctx.state === 'running'
  }
}
