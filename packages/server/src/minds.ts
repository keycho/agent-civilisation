/**
 * §55 tier 1: Claude writes the line, in the agent's own voice.
 *
 * The sim already decides everything. What it produces is a fact string —
 * `4 to 5 levels, returns 8.1% on cost` — which is accurate, dense, and reads
 * like a spreadsheet cell. Tier 1 hands those same facts to a haiku-class
 * model and asks for the sentence a person can follow. It changes NOTHING
 * about what happened; it changes what the log sounds like.
 *
 * Two callers only, per §55's scope for this block:
 *   - high-weight events, which are what the feed and the director spend
 *   - the reasoning for whoever is currently being followed
 *
 * §71's surfaces, the mind budget and tier 2 are explicitly NOT here.
 *
 * ---------------------------------------------------------------------------
 * PRE-REGISTERED, before the first production run
 * ---------------------------------------------------------------------------
 *
 * MEASURED on a 20,005-decision local run (packages/sim/test/wshare.ts), not
 * assumed — the first draft of this block assumed one event per decision and
 * was wrong by 4x in the direction that matters:
 *
 *   events per decision                          0.230
 *   events at weight >= 90 with an agent+line    1.52% of events
 *
 * Deployed rate: 8 chunks x 14 decisions/second = 112 decisions/second.
 *   events/second     112 x 0.230           = 25.8
 *   ELIGIBLE/second   25.8 x 0.0152         = 0.392   (1,411/hour)
 *
 * Cost per call, from the real prompt shape at haiku rates ($1/$5 per MTok).
 * This one is an ESTIMATE — count_tokens needs the key, which is on Railway
 * and not here — and the production report corrects it:
 *   input   ~330 tokens = $0.00033
 *   output   ~45 tokens = $0.000225
 *   per call             ~$0.00056
 *
 * Uncapped, that is 1,411 x $0.00056 = $0.79/hour, $18.96/day against a $20
 * ceiling. Which is why the caps are NOT set at the ceiling: 5% headroom means
 * one busier-than-average day switches tier 1 off for budget before midnight,
 * and the failure lands in the evening when someone is most likely watching.
 *
 * GLOBAL_CALLS_PER_MIN is therefore 17 (0.28/s), about 70% of the ceiling:
 *
 *   PREDICTED SPEND        17 x 60 x $0.00056 = $0.57/hour, $13.7/day
 *   PREDICTED FALLTHROUGH  of ELIGIBLE events, 1 - (1,020/1,411) = 27.7%
 *                          take the rule-based line on the rate cap
 *                          of ALL DECISIONS, 1,020/(112x3600) = 0.25% get a
 *                          Claude line; 99.75% never produce an eligible
 *                          event in the first place
 *
 * The second figure is the uncomfortable one and it is the true one: tier 1
 * touches a quarter of one percent of what the world does. What it buys is
 * that the loudest events — the ones the director cuts to, the ones the feed
 * leads with, and the ones belonging to whoever you are following — read like
 * someone thought them. Everything else is still the sim's own voice, which
 * was never wrong, only terse.
 *
 * Both figures are re-measured against production in the block's report.
 */
import Anthropic from '@anthropic-ai/sdk'

/** haiku-class, as specified. $1/MTok in, $5/MTok out. */
const MODEL = 'claude-haiku-4-5'
const IN_PER_TOKEN = 1 / 1_000_000
const OUT_PER_TOKEN = 5 / 1_000_000

/** the daily ceiling, in dollars. hard: at it, tier 1 stops. */
export const DAILY_CEILING = Number(process.env.MINDS_DAILY_CEILING ?? 20)
const GLOBAL_CALLS_PER_MIN = Number(process.env.MINDS_GLOBAL_RPM ?? 17)
const CHUNK_CALLS_PER_MIN = Number(process.env.MINDS_CHUNK_RPM ?? 4)
/** only events at or above this are worth a call */
const WEIGHT_FLOOR = Number(process.env.MINDS_WEIGHT_FLOOR ?? 90)
/**
 * A call that has not returned by here is abandoned. The tick never waits on
 * this — the abandonment is about not holding a slot, not about latency the
 * world can feel.
 */
const CALL_TIMEOUT_MS = 6_000
/** how long an inspect keeps an agent eligible below the weight floor */
const WATCH_TTL_MS = 60_000
const MAX_LINE = 120

/**
 * §35: the whole product is lowercase, and the line lands in a terminal feed
 * beside rule-based lines. A sentence that arrives capitalised or punctuated
 * like prose is not in the register even when it is a good sentence.
 */
const SYSTEM = [
  'you write one line of interior monologue for a property developer in a simulation.',
  'you are given the facts of a decision that has ALREADY happened. do not change them,',
  'do not add numbers, do not invent an address, a name, a date or a motive.',
  'write what the developer would say about it, in their own voice, in one clause.',
  'all lowercase. no full stop. no quotation marks. under 110 characters.',
  'be concrete and dry. no metaphors, no drama, no adjectives about feelings.',
].join(' ')

/**
 * §55: "structured output constrained to the existing vocabulary."
 *
 * The schema constrains the SHAPE. The vocabulary is constrained by the
 * validator below, which is where it can actually be enforced: `verb` is an
 * enum of the action kinds the sim performs, and every digit in the returned
 * line must appear in the facts the sim supplied. A model that invents a yield,
 * a storey count or a distance fails that check and the rule-based line stands.
 */
const SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['line', 'verb'],
  properties: {
    line: { type: 'string', maxLength: MAX_LINE },
    verb: {
      type: 'string',
      enum: [
        'acquire',
        'renovate',
        'convert',
        'expand',
        'demolish',
        'develop',
        'assemble',
        'build_road',
        'inherit',
        'die',
        'district',
      ],
    },
  },
} as const

export interface MindRequest {
  chunkId: string
  agentId?: string
  /** the sim's own line — the tier-0 fallback, and the fact source */
  rationale: string
  /** the action kind, so the model cannot relabel what happened */
  verb: string
  agentName: string
  /** e.g. "warehouse", so voice can sit on the thing rather than float */
  subject?: string
  weight: number
}

interface Ledger {
  day: string
  spentUsd: number
  calls: number
  ok: number
  malformed: number
  failed: number
  inTokens: number
  outTokens: number
}

const today = (): string => new Date().toISOString().slice(0, 10)

function freshLedger(): Ledger {
  return {
    day: today(),
    spentUsd: 0,
    calls: 0,
    ok: 0,
    malformed: 0,
    failed: 0,
    inTokens: 0,
    outTokens: 0,
  }
}

/**
 * Why tier 1 is not running right now, when it is not. The distinction §55
 * asks for is BUDGET vs LOAD, because they mean opposite things to whoever
 * reads /health: load is the system working as designed, budget is the feature
 * being switched off until tomorrow.
 */
export type DegradeReason = 'none' | 'no_key' | 'rate' | 'budget' | 'disabled'

export class Minds {
  private client: Anthropic | null = null
  private ledger: Ledger = freshLedger()
  /** call start times, newest last, trimmed to the last minute */
  private recent: number[] = []
  private perChunk = new Map<string, number[]>()
  private inFlight = 0
  private lastDegrade: DegradeReason = 'none'
  private degradedSince = 0
  /** rolling sample of what tier 1 actually produced, for the block's report */
  readonly transcript: Array<{ at: string; chunk: string; tier: 0 | 1; line: string }> = []

  constructor() {
    const key = process.env.ANTHROPIC_API_KEY
    if (key) this.client = new Anthropic({ apiKey: key, maxRetries: 0, timeout: CALL_TIMEOUT_MS })
  }

  get enabled(): boolean {
    return this.client !== null && process.env.MINDS_TIER1 !== 'off'
  }

  /** §55: the loud line. Says WHICH constraint is binding, not merely "degraded". */
  health(): Record<string, unknown> {
    this.rollDay()
    const reason = this.degradeReason()
    return {
      tier: reason === 'none' ? 1 : 0,
      model: MODEL,
      spentUsdToday: +this.ledger.spentUsd.toFixed(4),
      ceilingUsd: DAILY_CEILING,
      calls: this.ledger.calls,
      wrote: this.ledger.ok,
      malformed: this.ledger.malformed,
      failed: this.ledger.failed,
      callsLastMinute: this.recent.length,
      /**
       * The distinction that matters. A reader seeing "rate" knows the world
       * is busier than the allowance and the lines will come back on their
       * own; a reader seeing "budget" knows the feature is off until the day
       * rolls and that someone has to decide whether the ceiling is right.
       */
      degraded: reason === 'none' ? null : reason,
      degradedNote:
        reason === 'budget'
          ? `TIER 1 OFF FOR BUDGET: $${this.ledger.spentUsd.toFixed(2)} of $${DAILY_CEILING} spent today; rule-based lines until ${today()} rolls`
          : reason === 'rate'
            ? 'tier 1 rate-capped: the world is emitting faster than the allowance, lines fall through to the sim'
            : reason === 'no_key'
              ? 'tier 1 idle: no ANTHROPIC_API_KEY on this process'
              : reason === 'disabled'
                ? 'tier 1 switched off by MINDS_TIER1=off'
                : null,
      degradedForSeconds: reason === 'none' ? 0 : Math.round((Date.now() - this.degradedSince) / 1000),
    }
  }

  private rollDay(): void {
    if (this.ledger.day !== today()) this.ledger = freshLedger()
  }

  private degradeReason(): DegradeReason {
    if (!this.client) return 'no_key'
    if (process.env.MINDS_TIER1 === 'off') return 'disabled'
    if (this.ledger.spentUsd >= DAILY_CEILING) return 'budget'
    if (this.recent.length >= GLOBAL_CALLS_PER_MIN) return 'rate'
    return 'none'
  }

  private note(r: DegradeReason): void {
    if (r !== this.lastDegrade) {
      this.lastDegrade = r
      this.degradedSince = Date.now()
      if (r === 'budget') {
        // loud, once, on the way down — /health carries the standing state
        console.warn(
          `[minds] TIER 1 OFF FOR BUDGET — $${this.ledger.spentUsd.toFixed(2)} of $${DAILY_CEILING} today. rule-based lines until the day rolls.`,
        )
      }
    }
  }

  /** trims both windows to the last 60s and reports whether a slot exists */
  private slot(chunkId: string): boolean {
    const now = Date.now()
    const cut = now - 60_000
    while (this.recent.length && this.recent[0] < cut) this.recent.shift()
    const per = this.perChunk.get(chunkId) ?? []
    while (per.length && per[0] < cut) per.shift()
    this.perChunk.set(chunkId, per)
    if (this.recent.length >= GLOBAL_CALLS_PER_MIN) return false
    if (per.length >= CHUNK_CALLS_PER_MIN) return false
    // one call in flight per chunk is enough; queuing behind it just ages the line
    if (this.inFlight >= GLOBAL_CALLS_PER_MIN) return false
    this.recent.push(now)
    per.push(now)
    return true
  }

  /**
   * §55: "the reasoning for whoever is being followed."
   *
   * An `inspectAgent` marks that agent watched for a while. A watched agent's
   * lines are eligible whatever their weight, because the whole point of
   * following someone is the small decisions — a person who has chosen one
   * developer to watch is asking for THEIR reasoning, not for the loudest
   * thing in the city. The TTL means a closed pane stops spending within a
   * minute without needing an unfollow message the protocol does not have.
   */
  private watched = new Map<string, number>()

  watch(agentId: string): void {
    this.watched.set(agentId, Date.now() + WATCH_TTL_MS)
  }

  isWatched(agentId: string | undefined): boolean {
    if (!agentId) return false
    const until = this.watched.get(agentId)
    if (until === undefined) return false
    if (until < Date.now()) {
      this.watched.delete(agentId)
      return false
    }
    return true
  }

  /** is this event worth a call at all, before any cap is consulted */
  wants(weight: number, agentId?: string): boolean {
    return weight >= WEIGHT_FLOOR || this.isWatched(agentId)
  }

  /**
   * The line, or null to keep the sim's.
   *
   * NEVER THROWS and never blocks a tick: callers await it off the tick loop,
   * and every failure path — no key, capped, over budget, timeout, malformed,
   * refusal, a fabricated number — returns null, which means "the rule-based
   * line stands". There is no state in which this function can stall the world.
   */
  async write(req: MindRequest): Promise<string | null> {
    this.rollDay()
    const reason = this.degradeReason()
    this.note(reason)
    if (reason !== 'none') return null
    if (!this.wants(req.weight, req.agentId)) return null
    if (!this.slot(req.chunkId)) {
      this.note('rate')
      return null
    }

    this.inFlight++
    try {
      const res = await this.client!.messages.create({
        model: MODEL,
        max_tokens: 200,
        system: SYSTEM,
        messages: [{ role: 'user', content: prompt(req) }],
        output_config: { format: { type: 'json_schema', schema: SCHEMA } },
      })
      this.ledger.calls++
      this.ledger.inTokens += res.usage.input_tokens
      this.ledger.outTokens += res.usage.output_tokens
      this.ledger.spentUsd +=
        res.usage.input_tokens * IN_PER_TOKEN + res.usage.output_tokens * OUT_PER_TOKEN

      const raw = res.content.find((b) => b.type === 'text')
      if (!raw || raw.type !== 'text') {
        this.ledger.malformed++
        return null
      }
      const line = validate(raw.text, req)
      if (!line) {
        this.ledger.malformed++
        return null
      }
      this.ledger.ok++
      this.remember(req.chunkId, 1, `${req.agentName.split(' ')[0].toLowerCase()} ${line}`)
      return line
    } catch {
      // a rate limit, a timeout, a 500, a network blip: the sim's line stands
      this.ledger.failed++
      return null
    } finally {
      this.inFlight--
    }
  }

  /** the tier-0 lines go in the transcript too, so the report shows the mix */
  remember(chunk: string, tier: 0 | 1, line: string): void {
    this.transcript.push({ at: new Date().toISOString().slice(11, 19), chunk, tier, line })
    if (this.transcript.length > 200) this.transcript.shift()
  }
}

function prompt(req: MindRequest): string {
  return [
    `developer: ${req.agentName.split(' ')[0].toLowerCase()}`,
    req.subject ? `subject: ${req.subject}` : null,
    `action: ${req.verb}`,
    `facts: ${req.rationale}`,
    '',
    'write their one-clause line about this. use only the numbers in facts.',
  ]
    .filter(Boolean)
    .join('\n')
}

/**
 * The vocabulary guard, and the reason this is safe to put in front of a log
 * that people will read as a record of what happened.
 *
 * The model is not trusted to be truthful about quantities — it is trusted to
 * be fluent. So every digit in the line has to be a digit the sim supplied. A
 * fabricated yield, an invented storey count or a made-up distance fails here
 * and the rule-based line stands, which is the same outcome as the model being
 * down. That makes hallucination a fallthrough rather than a defect.
 */
export function validate(text: string, req: MindRequest): string | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return null
  }
  if (typeof parsed !== 'object' || parsed === null) return null
  const o = parsed as { line?: unknown; verb?: unknown }
  if (typeof o.line !== 'string' || typeof o.verb !== 'string') return null
  if (o.verb !== req.verb) return null

  const line = o.line.trim().replace(/\s+/g, ' ')
  if (!line || line.length > MAX_LINE) return null
  // §35's register: the product is lowercase and unpunctuated at the end
  if (line !== line.toLowerCase()) return null
  if (/["'`]/.test(line)) return null

  // every number in the line must be one the sim gave it
  const allowed = new Set((req.rationale.match(/\d+(?:\.\d+)?/g) ?? []).map(String))
  for (const n of line.match(/\d+(?:\.\d+)?/g) ?? []) {
    if (!allowed.has(n)) return null
  }
  return line.replace(/[.]+$/, '')
}
