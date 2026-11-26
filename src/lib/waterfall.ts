// Exit distribution (PRD §4.3, C-DIS-1..9). One contribution, one exit; per-investor carry (C-DIS-8) and carry payees (C-DIS-9) since v0.9.
import { hurdleAmount, mulDiv, mulDivN, splitProRata, sum, toNum } from './money'
import { Errors, LIMITS, MAX_HOLDINGS } from './validate'
import { finish, type Check, type InputError, type Outcome } from './outcome'

export interface Holding {
  id: string
  name: string
  /** Amount invested, excluding fees. Also the ownership weight (C-DIS-7). */
  capital: number
  /** C-DIS-8 personal carry in bps; absent or null: the deal's carry */
  carryBps?: number | null
}

/** C-DIS-9: a carry payee and their share in bps (all shares add up to 10,000). */
export interface Payee {
  name: string
  shareBps: number
}

export const MAX_PAYEES = 20

export type CarryTerms =
  | { mode: 'fixed'; k: number; h: number; c: number }
  /** upTo100: gross multiple × 100 where the tier ends (BigInt: no ceiling on size); null = last tier.
   *  h / c must be absent in tiered mode — their presence, even as 0, is an input error. */
  | { mode: 'tiered'; tiers: { upTo100: bigint | null; rate: number }[]; h?: number; c?: number }

export interface WaterfallInput {
  holdings: Holding[]
  proceeds: number
  exitCosts: number
  /** years × 100 */
  years100: number
  carry: CarryTerms
  /** C-DIS-9; absent or empty: one payee, "Lead" */
  payees?: Payee[]
}

export interface WaterfallStep {
  label: string
  toInvestors: number
  toLead: number
  explain: string
}

export interface WaterfallRow {
  id: string
  name: string
  capital: number
  distribution: number
  profit: number
  /** distribution ÷ capital × 100, half-up; excludes entry fees */
  multiple100: number
  /** C-DIS-8 path only: this investor's carry amount */
  carry?: number
  /** the carry rate used for this investor, set only in fixed mode when some holding has a personal carry (export column) */
  carryBps?: number
}

export interface WaterfallResult {
  steps: WaterfallStep[]
  rows: WaterfallRow[]
  capital: number
  shortfall: number
  costsPaid: number
  returnOfCapital: number
  hurdlePaid: number
  catchUpTranche: number
  catchUpToLead: number
  carry: number
  investorsTotal: number
  /** C-DIS-9: carry split between payees ("Lead" alone when there is no list) */
  payees: { name: string; shareBps: number; amount: number }[]
  /** C-DIS-8: one row per investor when personal carry rates differ, else null */
  perInvestor: PerInvestorStep[] | null
  /** R-DIS-08: tiered mode with every personal carry filled and equal — the tier table is used instead of this rate */
  tieredNote: number | null
}

export interface PerInvestorStep {
  id: string
  name: string
  carryBps: number
  /** D_i: this investor's share of proceeds after exit costs, by capital */
  share: number
  returnOfCapital: number
  hurdlePaid: number
  catchUpTranche: number
  catchUpToLead: number
  carry: number
  distribution: number
}

/** C-DIS preamble / C-DIS-8: the personal carry rates in use, or why they cannot be used. */
export function effectiveCarry(input: Pick<WaterfallInput, 'holdings' | 'carry'>): { kind: 'deal' } | { kind: 'common'; k: number } | { kind: 'perInvestor'; ks: number[] } | { kind: 'error'; message: string } {
  const set = input.holdings.map((h) => (h.carryBps === undefined || h.carryBps === null ? null : h.carryBps))
  if (set.every((x) => x === null)) return { kind: 'deal' }
  if (input.carry.mode === 'tiered') {
    if (set.some((x) => x === null)) return { kind: 'error', message: "Fill in every investor's carry, or none, for tiered carry" }
    return set.every((x) => x === set[0]) ? { kind: 'common', k: set[0]! } : { kind: 'error', message: 'Tiered carry needs the same carry for every investor' }
  }
  const k = input.carry.k
  const ks = set.map((x) => (x === null ? k : x))
  return ks.every((x) => x === ks[0]) ? { kind: 'common', k: ks[0] } : { kind: 'perInvestor', ks }
}

const fmtMultiple = (m100: bigint) => `${m100 / 100n}.${String(m100 % 100n).padStart(2, '0')}x`
const pct = (bps: number) => `${(bps / 100).toFixed(2).replace(/\.?0+$/, '')}%`

/** The holdings table on its own (field table, I-08): shared by the exit engine and the holdings export (review M3 R1 #6). */
export function validateHoldings(holdings: Holding[], e = new Errors()): InputError[] {
  if (holdings.length === 0) e.add('holdings', 'add at least one holding')
  e.count(holdings.length, MAX_HOLDINGS, 'holdings')
  e.uniqueIds(holdings.map((h) => h.id), 'holdings')
  holdings.forEach((h, i) => {
    e.text(h.id, `holdings[${i + 1}] id`, LIMITS.investorId, true)
    e.text(h.name, `holdings[${i + 1}] name`, LIMITS.name, true)
    e.money(h.capital, `holdings[${i + 1}] capital`, 1)
    if (h.carryBps !== undefined && h.carryBps !== null && (!Number.isInteger(h.carryBps) || h.carryBps < 0 || h.carryBps > 10_000))
      e.add(`holdings[${i + 1}] carry`, 'must be between 0% and 100%')
  })
  return e.list
}

export function validateWaterfall(input: WaterfallInput): InputError[] {
  const e = new Errors()
  validateHoldings(input.holdings, e)
  e.money(input.proceeds, 'proceeds', 0)
  e.money(input.exitCosts, 'exitCosts', 0)
  if (!Number.isInteger(input.years100) || input.years100 < 0 || input.years100 > 5_000) e.add('years', 'must be between 0 and 50')
  const rate = (v: number, where: string) => {
    if (!Number.isInteger(v) || v < 0 || v > 10_000) e.add(where, 'must be between 0% and 100%')
  }
  const c = input.carry
  if (c.mode === 'fixed') {
    // modes are exclusive: a tier table in fixed mode is an input error (C-DIS, Codex M1 round 2)
    if ('tiers' in c) e.add('carry', 'tiers do not apply to fixed carry')
    rate(c.k, 'carry')
    rate(c.h, 'hurdle')
    rate(c.c, 'catchUp')
    if (c.h === 0 && c.c !== 0) e.add('catchUp', 'catch-up only applies with a hurdle; set it to 0 or add a hurdle')
    // v0.9: checked on the carry rates actually used (C-DIS preamble); without personal carry that is the deal's k
    const used = effectiveCarry(input)
    const ks = used.kind === 'perInvestor' ? used.ks : [used.kind === 'common' ? used.k : c.k]
    const tooHigh = used.kind === 'perInvestor' ? input.holdings.filter((_, i) => ks[i] > 0 && c.c <= ks[i]).map((h) => h.name) : ks.filter((k) => c.c <= k).map(() => '')
    if (c.h > 0 && c.c > 0 && tooHigh.length) e.add('catchUp', `catch-up must be higher than the carry rate${tooHigh[0] ? ` (${tooHigh.join(', ')})` : ''}`)
  } else if (c.mode === 'tiered') {
    if ('h' in c || 'c' in c || 'k' in c) e.add('carry', 'a fixed carry rate, hurdle or catch-up does not apply to tiered carry')
    if (c.tiers.length === 0) e.add('tiers', 'add at least one tier')
    let prev = 100n
    c.tiers.forEach((t, i) => {
      const where = `tiers[${i + 1}]`
      rate(t.rate, `${where} rate`)
      const last = i === c.tiers.length - 1
      if (last && t.upTo100 !== null) e.add(where, 'the last tier must have no ceiling')
      if (!last) {
        if (typeof t.upTo100 !== 'bigint' || t.upTo100 <= prev) e.add(where, 'ceiling must be above the previous one and above 1x')
        else prev = t.upTo100
      }
    })
  } else e.add('carry', 'unknown carry mode')
  if (c.mode === 'fixed' || c.mode === 'tiered') {
    const used = effectiveCarry(input)
    if (used.kind === 'error') e.add('carry', used.message)
  }
  const payees = input.payees ?? []
  if (payees.length) {
    e.count(payees.length, MAX_PAYEES, 'payees')
    payees.forEach((p, i) => {
      e.text(p.name, `payees[${i + 1}] name`, LIMITS.name, true)
      if (!Number.isInteger(p.shareBps) || p.shareBps <= 0 || p.shareBps > 10_000) e.add(`payees[${i + 1}] share`, 'must be more than 0% and at most 100%')
    })
    if (sum(payees.map((p) => p.shareBps)) !== 10_000) e.add('payees', 'Payee shares must add up to 100%')
  }
  return e.list
}

export function distribute(input: WaterfallInput): Outcome<WaterfallResult> {
  const errors = validateWaterfall(input)
  if (errors.length) return { ok: false, errors }
  const used = effectiveCarry(input)
  let out: Outcome<WaterfallResult>
  if (used.kind === 'perInvestor' && input.exitCosts <= input.proceeds) out = distributePerInvestor(input, used.ks)
  else {
    const carry = used.kind === 'common' && input.carry.mode === 'fixed' ? { ...input.carry, k: used.k } : input.carry
    out = distributeDeal({ ...input, carry })
    if (out.ok) {
      if (used.kind === 'common' && input.carry.mode === 'tiered') out.result.tieredNote = used.k
      if (used.kind !== 'deal' && input.carry.mode === 'fixed') for (const r of out.result.rows) r.carryBps = (used as { k: number }).k
    }
  }
  if (out.ok) out.result.payees = splitPayees(out.result.carry, input.payees ?? [])
  return out
}

/** C-DIS-9: largest remainder by share, ties to the earlier payee; no list → "Lead" takes it all. */
export function splitPayees(carry: number, payees: Payee[]): { name: string; shareBps: number; amount: number }[] {
  if (payees.length === 0) return [{ name: 'Lead', shareBps: 10_000, amount: carry }]
  const parts = splitProRata(carry, payees.map((p) => p.shareBps))
  return payees.map((p, i) => ({ name: p.name, shareBps: p.shareBps, amount: parts[i] }))
}

/** C-DIS-8: split D by capital, then run each investor's own fixed waterfall with the deal's h, n and c. */
function distributePerInvestor(input: WaterfallInput, ks: number[]): Outcome<WaterfallResult> {
  const { holdings, proceeds: G, exitCosts: E } = input
  if (input.carry.mode !== 'fixed') throw new Error('per-investor carry is fixed mode only')
  const { h, c } = input.carry
  const C = sum(holdings.map((x) => x.capital))
  const D = G - E
  const shares = splitProRata(D, holdings.map((x) => x.capital))
  const per: PerInvestorStep[] = []
  const steps: WaterfallStep[] = []
  const addStep = (s: WaterfallStep) => {
    const found = steps.find((x) => x.label === s.label)
    if (found) {
      found.toInvestors += s.toInvestors
      found.toLead += s.toLead
    } else steps.push({ ...s, explain: `${s.label}: each investor's own waterfall with their own carry rate; see the per-investor table.` })
  }
  let returnOfCapital = 0
  let hurdlePaid = 0
  let catchUpTranche = 0
  let catchUpToLead = 0
  const rows: WaterfallRow[] = holdings.map((x, i) => {
    // one holding, its share of D, its own k: the deal-level engine is the single-investor waterfall
    const one = distributeDeal({ holdings: [{ id: x.id, name: x.name, capital: x.capital }], proceeds: shares[i], exitCosts: 0, years100: input.years100, carry: { mode: 'fixed', k: ks[i], h, c } })
    if (!one.ok) throw new Error('per-investor waterfall failed after validation')
    const r = one.result
    for (const s of r.steps) addStep(s)
    returnOfCapital += r.returnOfCapital
    hurdlePaid += r.hurdlePaid
    catchUpTranche += r.catchUpTranche
    catchUpToLead += r.catchUpToLead
    const distribution = shares[i] - r.carry
    per.push({ id: x.id, name: x.name, carryBps: ks[i], share: shares[i], returnOfCapital: r.returnOfCapital, hurdlePaid: r.hurdlePaid, catchUpTranche: r.catchUpTranche, catchUpToLead: r.catchUpToLead, carry: r.carry, distribution })
    return {
      id: x.id,
      name: x.name,
      capital: x.capital,
      distribution,
      profit: distribution - x.capital,
      multiple100: mulDivN(distribution, 100, x.capital, 'halfUp'),
      carry: r.carry,
      carryBps: ks[i],
    }
  })
  const carryTotal = sum(per.map((x) => x.carry))
  const investorsTotal = sum(rows.map((x) => x.distribution))
  const result: WaterfallResult = {
    steps,
    rows,
    capital: C,
    shortfall: 0,
    costsPaid: E,
    returnOfCapital,
    hurdlePaid,
    catchUpTranche,
    catchUpToLead,
    carry: carryTotal,
    investorsTotal,
    payees: [],
    perInvestor: per,
    tieredNote: null,
  }
  const checks: Check[] = [
    { id: 'balances', kind: 'invariant', label: 'Investors + carry + exit costs = proceeds', pass: investorsTotal + carryTotal + E === G },
    { id: 'per-investor-balances', kind: 'invariant', label: "Each investor's share = payout + carry", pass: per.every((x) => x.share === x.distribution + x.carry) && sum(shares) === D },
    { id: 'capital-first', kind: 'invariant', label: 'No carry on an investor until their capital is returned', pass: per.every((x, i) => x.share > holdings[i].capital || x.carry === 0) },
    { id: 'investor-split', kind: 'invariant', label: 'Investor payouts add up and none is negative', pass: rows.every((x) => x.distribution >= 0) },
  ]
  return finish(result, checks)
}

function distributeDeal(input: WaterfallInput): Outcome<WaterfallResult> {
  const { holdings, proceeds: G, exitCosts: E, carry } = input
  const C = sum(holdings.map((h) => h.capital))
  const steps: WaterfallStep[] = []
  const zeroRows = holdings.map((h) => ({ id: h.id, name: h.name, capital: h.capital, distribution: 0, profit: -h.capital, multiple100: 0 }))

  // C-DIS-1: exit costs larger than proceeds → shortfall, no final distribution.
  if (E > G) {
    const result: WaterfallResult = {
      steps: [{ label: 'Exit costs', toInvestors: 0, toLead: 0, explain: 'Exit costs exceed proceeds. Nothing can be distributed until this is resolved.' }],
      rows: zeroRows,
      capital: C,
      shortfall: E - G,
      costsPaid: G,
      returnOfCapital: 0,
      hurdlePaid: 0,
      catchUpTranche: 0,
      catchUpToLead: 0,
      carry: 0,
      investorsTotal: 0,
      payees: [],
      perInvestor: null,
      tieredNote: null,
    }
    return finish(result, [{ id: 'exit-cost-shortfall', kind: 'blocker', pass: false, label: 'Exit costs do not exceed proceeds' }])
  }

  const D = G - E
  const roc = Math.min(D, C)
  let rem = D - roc
  steps.push({
    label: 'Return of capital',
    toInvestors: roc,
    toLead: 0,
    explain: roc < C ? 'Not enough to return all capital: there is no profit and no carry.' : 'Investors get back what they invested before any carry is paid.',
  })
  let hurdlePaid = 0
  let catchUpTranche = 0
  let catchUpToLead = 0

  if (rem > 0 && carry.mode === 'fixed') {
    const { k, h, c } = carry
    if (h > 0) {
      // C-DIS-3: exact BigInt hurdle, rounded half-up to pence once; n is only for the explanation text.
      const n = input.years100 / 100
      // exact, half-up (review M1 #1); kept as BigInt until clamped by what is left (self-test #1)
      const P = hurdleAmount(C, h, input.years100)
      hurdlePaid = P < BigInt(rem) ? toNum(P) : rem
      rem -= hurdlePaid
      steps.push({ label: 'Preferred return (hurdle)', toInvestors: hurdlePaid, toLead: 0, explain: `${pct(h)} a year, compounding over ${n} years on capital, paid to investors before any carry.` })
      if (c > 0 && rem > 0) {
        // C-DIS-4: Y = k·P′ / (c − k)
        const Y = mulDivN(hurdlePaid, k, c - k, 'halfUp')
        catchUpTranche = Math.min(rem, Y)
        catchUpToLead = mulDivN(catchUpTranche, c, 10_000, 'halfUp')
        rem -= catchUpTranche
        steps.push({
          label: 'Lead catch-up',
          toInvestors: catchUpTranche - catchUpToLead,
          toLead: catchUpToLead,
          explain: `The lead takes ${pct(c)} of the next distributions until it holds ${pct(k)} of all profit paid so far.`,
        })
      }
    }
    const toLead = mulDivN(rem, k, 10_000, 'halfUp')
    steps.push({ label: 'Carried interest split', toInvestors: rem - toLead, toLead, explain: `Remaining profit: ${pct(10_000 - k)} to investors, ${pct(k)} to the lead.` })
    rem = 0
  } else if (rem > 0 && carry.mode === 'tiered') {
    // C-DIS-6: boundaries rounded to a penny first, then each band's carry rounded half-up.
    const profit = BigInt(rem)
    let prevB = 0n
    let prevM = 100n
    for (const t of carry.tiers) {
      // boundaries stay BigInt until clamped by the actual profit (review M1 #9)
      const B = t.upTo100 === null ? null : mulDiv(t.upTo100 - 100n, C, 100, 'halfUp')
      const top = B === null || B > profit ? profit : B
      const amt = toNum(top > prevB ? top - prevB : 0n)
      const toLead = mulDivN(amt, t.rate, 10_000, 'halfUp')
      steps.push({
        label: t.upTo100 === null ? `Profit above ${fmtMultiple(prevM)}` : `Profit from ${fmtMultiple(prevM)} to ${fmtMultiple(t.upTo100)}`,
        toInvestors: amt - toLead,
        toLead,
        explain: `${pct(t.rate)} carry on the profit in this band only.`,
      })
      if (t.upTo100 !== null && B !== null) {
        prevB = B
        prevM = t.upTo100
      }
    }
    rem = 0
  }

  const investorsTotal = sum(steps.map((s) => s.toInvestors))
  const carryTotal = sum(steps.map((s) => s.toLead))
  const parts = splitProRata(investorsTotal, holdings.map((h) => h.capital))
  const rows: WaterfallRow[] = holdings.map((h, i) => ({
    id: h.id,
    name: h.name,
    capital: h.capital,
    distribution: parts[i],
    profit: parts[i] - h.capital,
    multiple100: mulDivN(parts[i], 100, h.capital, 'halfUp'),
  }))
  const result: WaterfallResult = {
    steps,
    rows,
    capital: C,
    shortfall: 0,
    costsPaid: E,
    returnOfCapital: roc,
    hurdlePaid,
    catchUpTranche,
    catchUpToLead,
    carry: carryTotal,
    investorsTotal,
    payees: [],
    perInvestor: null,
    tieredNote: null,
  }
  const checks: Check[] = [
    { id: 'balances', kind: 'invariant', label: 'Investors + carry + exit costs = proceeds', pass: investorsTotal + carryTotal + E === G },
    { id: 'capital-first', kind: 'invariant', label: 'No carry unless all capital is returned', pass: D > C || carryTotal === 0 },
    {
      id: 'investor-split',
      kind: 'invariant',
      label: 'Investor payouts add up and none is negative',
      pass: sum(parts) === investorsTotal && parts.every((x) => x >= 0),
    },
  ]
  return finish(result, checks)
}

/**
 * True when the lead's carry is the full carry rate of all profit, to within a penny (C-DIS-4: what a 100% catch-up
 * achieves when there is enough money). Used to word explanations; no figure depends on it.
 */
export function carryIsFullShare(r: WaterfallResult, kBps: number): boolean {
  const profit = BigInt(r.investorsTotal + r.carry - r.capital)
  if (profit <= 0n) return false
  const diff = BigInt(r.carry) * 10_000n - profit * BigInt(kBps)
  return (diff < 0n ? -diff : diff) <= 10_000n
}
