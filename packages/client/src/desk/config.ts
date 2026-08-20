/**
 * §79: the desk's unbound values, in one place, unset.
 *
 * THE PROTOTYPE SHIPPED A CONTRACT ADDRESS. `7Ru7kZdKBepiKF56vEfa1gEe6BNQ...`
 * is a well-formed Solana mint sitting in a demo file, and the handoff says
 * plainly that nothing marked `data-ph` may ship as written. That instruction
 * is doing more work here than anywhere else on the page: a plausible-looking
 * address next to a "copy ca" button is an instruction to send money, and if
 * it is not the right one the money is gone and nobody can undo it. There is
 * no version of "close enough" for this field.
 *
 * So the demo values are not carried over — not even as comments to be
 * uncommented, because that is the same mistake with an extra step. Every
 * field below is empty, the desk renders an explicit UNSET state rather than
 * anything that could be mistaken for an address, and `copy ca` and `buy` are
 * disabled until a real value is set here.
 *
 * Set these when the token exists. Nothing else on the page needs editing.
 */
export interface DeskConfig {
  /** the SPL mint. shown in the contract panel and copied by `copy ca`. */
  tokenMint: string
  /** the pump.fun listing, behind both `buy $fork` and the ghost button */
  pumpfunUrl: string
  xUrl: string
  telegramUrl: string
  siteUrl: string
  /** the pair label in the head sub-slot, e.g. "$fork/sol" */
  pair: string
}

export const DESK: DeskConfig = {
  tokenMint: '',
  pumpfunUrl: '',
  xUrl: '',
  telegramUrl: '',
  siteUrl: '',
  pair: '',
}

/** a field that is set to something real, rather than blank or whitespace */
export const bound = (v: string): boolean => v.trim().length > 0

/**
 * What the page shows where a value is missing. Deliberately not an address
 * shape and not a plausible URL — a reader must not be able to mistake it for
 * a value, and a screenshot of this state must be obviously pre-launch.
 */
export const UNSET = 'not published yet'

/**
 * Named loudly at boot so an unbound field cannot ship quietly. This is the
 * §21.4 habit — assert against what was actually emitted — pointed at config
 * rather than at a seed file.
 */
export function unboundFields(c: DeskConfig = DESK): string[] {
  return (Object.keys(c) as Array<keyof DeskConfig>).filter((k) => !bound(c[k]))
}
