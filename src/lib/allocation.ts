// Closing allocation, nominee SPV only (PRD §4.2, C-ALL-0..9).
import { mulDiv, mulDivN, platformFeeAmount, splitProRata, sum, sumExact, toNum, MAX_PRICE_MICROS } from './money'
import { Errors, LIMITS, MAX_FEES, MAX_INVESTORS } from './validate'
import { finish, type Check, type InputError, type Outcome } from './outcome'

export type TaxScheme = 'none' | 'SEIS' | 'EIS'
export type FeeBasis = 'deducted' | 'onTop'
export type FeePayer = 'investors' | 'company' | 'lead'
/** percent: bps; perInvestor / fixed: minor units */
export type FeeKind = 'percent' | 'perInvestor' | 'fixed'

export interface Fee {
  id: string
  label: string
  kind: FeeKind
  value: number
  payer: FeePayer
}

/** R-DEAL-06: only equity has a share price and share counts. */
export type Instrument = 'equity' | 'convertible' | 'fund_units'
/** C-ALL-0: one cash fee per person, a rate or a fixed amount, or none. */
export type OwnFee = { kind: 'percent'; bps: number } | { kind: 'fixed'; amount: number } | null
/** C-ALL-0 / R-DEAL-05: the person's own fee terms; they replace the deal's investor-paid fees. */
export interface OwnTerms {
  mode: FeeBasis
  fee: OwnFee
}
/** C-ALL-9b / R-ALL-13: pro-rata platform fee. */
export interface PlatformFee {
  rateBps: number
  minimum: number
  /** null: no cap */
  maximum: number | null
  /** null: no add-on */
  addOnThreshold: number | null
  addOnBps: number
  payer: FeePayer
}

export interface AllocationInvestor {
  id: string
  name: string
  received: number
  scheme: TaxScheme
  /** C-ALL-0; absent or null: the deal's default terms (v0.8 behaviour) */
  ownTerms?: OwnTerms | null
  /** carried to the holdings only (C-DIS-8); null: the deal's carry */
  carryBps?: number | null
}

export interface AllocationInput {
  feeBasis: FeeBasis
  minimum: number
  cap: number | null
  /** equity: > 0; convertible / fund units: null (R-DEAL-06) */
  priceMicros: number | null
  fees: Fee[]
  investors: AllocationInvestor[]
  /** absent: equity */
  instrument?: Instrument
  /** absent or null: no platform fee (v0.8 behaviour) */
  platformFee?: PlatformFee | null
}

export type ExclusionReason = 'no-funds' | 'fees-exceed-receipt' | 'below-minimum' | 'zero-investment'

export interface AllocationRow {
  id: string
  name: string
  scheme: TaxScheme
  received: number
  participating: boolean
  exclusion: ExclusionReason | null
  /** passed through from the input, for exports and the hand-off to exit */
  ownTerms: OwnTerms | null
  carryBps: number | null
  /** the person's own cash fee (C-ALL-0), or null without own fee terms */
  ownFee: number | null
  /** T after C-ALL-7, before the platform fee */
  preFeeInvested: number
  /** S (C-ALL-9b); 0 unless investors pay the platform fee */
  platformShare: number
  /** Target before refund retries (= M, or the scaled-back share of the cap). */
  target: number
  scaledBack: boolean
  invested: number
  /** investor-paid fee id → amount (participants only) */
  fees: Record<string, number>
  feesTotal: number
  refund: number
  /** floor(invested ÷ price) in millionths of a share — display only */
  /** null for convertible / fund units */
  microShares: bigint | null
  claimableShares: number | null
  claimableAmount: number | null
  nonClaimable: number | null
}

export interface AllocationResult {
  rows: AllocationRow[]
  /** amount is null only for company/lead fees while the platform fee blocks (C-ALL-9b) */
  feeTotals: { id: string; label: string; payer: FeePayer; kind: FeeKind; amount: number | null }[]
  totals: {
    received: number
    invested: number
    investorFees: number
    refunds: number
    /** null while the platform fee blocks: C-ALL-9a is not computed then */
    companyFees: number | null
    leadInvoice: number | null
    wire: number | null
    /** C-ALL-9b; null without a platform fee or with no participants */
    platformFee: { amount: number; base: number; payer: FeePayer } | null
  }
  /** microShares null for convertible / fund units */
  byScheme: Record<TaxScheme, { investors: number; invested: number; microShares: bigint | null }>
  scaledBack: boolean
  blockers: { code: BlockerCode; names: string[] }[]
  /** the same blockers' investor IDs, in the same order (hand-off results use IDs; kept apart so v0.8 blocker objects are unchanged) */
  blockerIds: Partial<Record<BlockerCode, string[]>>
}

export type BlockerCode = 'no-participants' | 'company-fees-exceed' | 'scale-back-below-minimum' | 'platform-fee-exceeds'

export function validateAllocation(input: AllocationInput): InputError[] {
  const e = new Errors()
  const instrument = input.instrument ?? 'equity'
  if (instrument !== 'equity' && instrument !== 'convertible' && instrument !== 'fund_units') e.add('instrument', 'must be equity, convertible or fund_units')
  if (instrument !== 'equity') {
    if (input.priceMicros !== null) e.add('sharePrice', 'share price must be empty for a convertible or fund units')
  } else if (input.priceMicros === null || !Number.isSafeInteger(input.priceMicros) || input.priceMicros <= 0 || input.priceMicros > MAX_PRICE_MICROS)
    e.add('sharePrice', 'must be greater than 0 and at most 1,000,000')
  const pf = input.platformFee ?? null
  if (pf) {
    const bps = (v: number) => Number.isInteger(v) && v >= 0 && v <= 10_000
    if (!bps(pf.rateBps)) e.add('platformFee rate', 'percentage must be between 0% and 100%')
    if (!bps(pf.addOnBps)) e.add('platformFee add-on rate', 'percentage must be between 0% and 100%')
    e.money(pf.minimum, 'platformFee minimum', 0)
    if (pf.maximum !== null) e.money(pf.maximum, 'platformFee maximum', 0)
    if (pf.addOnThreshold !== null) e.money(pf.addOnThreshold, 'platformFee add-on threshold', 0)
    else if (pf.addOnBps !== 0) e.add('platformFee add-on rate', 'needs an add-on threshold')
    if (pf.maximum !== null && pf.minimum > pf.maximum) e.add('platformFee', 'minimum must not exceed the maximum')
    if (pf.payer !== 'investors' && pf.payer !== 'company' && pf.payer !== 'lead') e.add('platformFee payer', 'must be investors, company or lead')
  }
  e.money(input.minimum, 'minimum', 0)
  if (input.cap !== null) e.money(input.cap, 'cap', 1)
  if (input.feeBasis !== 'deducted' && input.feeBasis !== 'onTop') e.add('feeBasis', 'must be deducted or onTop')
  e.count(input.fees.length, MAX_FEES, 'fees')
  e.uniqueIds(input.fees.map((f) => f.id), 'fees')
  // labels become export column names, so they must be unique too (self-test #7)
  e.uniqueIds(input.fees.map((f) => f.label.trim().toLowerCase()), 'fee labels')
  input.fees.forEach((f, i) => {
    const where = `fees[${i + 1}] ${f.label}`
    e.text(f.id, `${where} id`, LIMITS.investorId, true)
    e.text(f.label, `${where} label`, LIMITS.freeText, false)
    const okKind = f.payer === 'investors' ? f.kind === 'percent' || f.kind === 'perInvestor' : (f.payer === 'company' || f.payer === 'lead') && (f.kind === 'percent' || f.kind === 'fixed')
    if (!okKind)
      e.add(where, f.payer === 'investors' ? 'investor-paid fees must be a percentage or a fixed amount per investor' : 'company- or lead-paid fees must be a percentage or a fixed total')
    if (f.kind === 'percent') {
      if (!Number.isInteger(f.value) || f.value < 0 || f.value > 10_000) e.add(where, 'percentage must be between 0% and 100%')
    } else e.money(f.value, where, 1)
  })
  const p = sum(input.fees.filter((f) => f.payer === 'investors' && f.kind === 'percent').map((f) => f.value))
  if (input.feeBasis === 'deducted' && p >= 10_000) e.add('fees', 'investor percentage fees deducted from the wire must total less than 100%')
  e.count(input.investors.length, MAX_INVESTORS, 'investors')
  e.uniqueIds(input.investors.map((v) => v.id), 'investors')
  input.investors.forEach((v, i) => {
    const where = `investors[${i + 1}]`
    e.text(v.id, `${where} id`, LIMITS.investorId, true)
    e.text(v.name, `${where} name`, LIMITS.name, true)
    if (!['none', 'SEIS', 'EIS'].includes(v.scheme)) e.add(`${where} scheme`, 'must be none, SEIS or EIS')
    e.money(v.received, `${where} received`, 0)
    if (v.carryBps !== undefined && v.carryBps !== null && (!Number.isInteger(v.carryBps) || v.carryBps < 0 || v.carryBps > 10_000))
      e.add(`${where} carry`, 'percentage must be between 0% and 100%')
    const t = v.ownTerms
    if (t) {
      if (t.mode !== 'deducted' && t.mode !== 'onTop') e.add(`${where} own fee mode`, 'must be deducted or onTop')
      if (t.fee?.kind === 'percent') {
        if (!Number.isInteger(t.fee.bps) || t.fee.bps < 0 || t.fee.bps > 10_000) e.add(`${where} own fee rate`, 'percentage must be between 0% and 100%')
        else if (t.mode === 'deducted' && t.fee.bps >= 10_000) e.add(`${where} own fee rate`, 'a fee deducted from the wire must be less than 100%')
      } else if (t.fee?.kind === 'fixed') e.money(t.fee.amount, `${where} own fixed fee`, 1)
      else if (t.fee !== null) e.add(`${where} own fee`, 'must be a rate, a fixed amount or none')
    }
  })
  return e.list
}

/** C-ALL-0: the fee terms that apply to one investor. */
interface Terms {
  feeBasis: FeeBasis
  p: number
  F: number
  pctFees: Fee[]
  perInvFees: Fee[]
  own: OwnTerms | null
}

export function allocate(input: AllocationInput): Outcome<AllocationResult> {
  const errors = validateAllocation(input)
  if (errors.length) return { ok: false, errors }
  try {
    return compute(input)
  } catch (err) {
    // Only reachable with extreme fee combinations whose totals cannot be represented exactly (review M1 #10).
    if (err instanceof Error && /safe integer/.test(err.message)) return { ok: false, errors: [{ where: 'fees', message: 'totals exceed the supported size' }] }
    throw err
  }
}

function compute(input: AllocationInput): Outcome<AllocationResult> {

  const { minimum, cap, priceMicros: price, fees, investors } = input
  const equity = (input.instrument ?? 'equity') === 'equity'
  const dealPct = fees.filter((f) => f.payer === 'investors' && f.kind === 'percent')
  const dealPerInv = fees.filter((f) => f.payer === 'investors' && f.kind === 'perInvestor')
  const dealTerms: Terms = {
    feeBasis: input.feeBasis,
    p: sum(dealPct.map((f) => f.value)),
    F: sum(dealPerInv.map((f) => f.value)),
    pctFees: dealPct,
    perInvFees: dealPerInv,
    own: null,
  }
  // C-ALL-0: own fee terms replace the deal's investor-paid items for that person.
  const terms: Terms[] = investors.map((v) => {
    const t = v.ownTerms
    if (!t) return dealTerms
    return {
      feeBasis: t.mode,
      p: t.fee?.kind === 'percent' ? t.fee.bps : 0,
      F: t.fee?.kind === 'fixed' ? t.fee.amount : 0,
      pctFees: [],
      perInvFees: [],
      own: t,
    }
  })

  // C-ALL-1: maximum investable M; C-ALL-2: minimum on the commitment basis.
  const M = investors.map((v, i) => {
    const { feeBasis, p, F } = terms[i]
    if (v.received <= F) return 0
    return feeBasis === 'deducted'
      ? mulDivN(v.received - F, 10_000 - p, 10_000, 'floor')
      : mulDivN(v.received - F, 10_000, 10_000 + p, 'floor')
  })
  const exclusion: (ExclusionReason | null)[] = investors.map((v, i) => {
    const { feeBasis, F } = terms[i]
    if (v.received === 0) return 'no-funds'
    if (v.received <= F || M[i] <= 0) return 'fees-exceed-receipt'
    const commitment = feeBasis === 'deducted' ? v.received : M[i]
    return commitment < minimum ? 'below-minimum' : null
  })
  const inM = M.map((m, i) => (exclusion[i] ? 0 : m))

  // C-ALL-3: pro-rata scale-back to the cap.
  const demand = sum(inM)
  const scaledBack = cap !== null && demand > cap
  const T = scaledBack ? splitProRata(cap, inM) : inM
  const belowAfterScale: AllocationInvestor[] = []
  if (scaledBack) {
    investors.forEach((v, i) => {
      if (exclusion[i]) return // every participant is checked, even if rounding left T = M (review M1 #3)
      const { feeBasis, p, F } = terms[i] // C-ALL-3 v0.9: each person's own basis (Bulma R30)
      // deducted: T/(1−p) + F < minimum  ⇔  T × 10,000 < (minimum − F) × (10,000 − p)
      const below =
        feeBasis === 'deducted'
          ? BigInt(T[i]) * 10_000n < BigInt(minimum - F) * BigInt(10_000 - p)
          : T[i] < minimum
      if (below) belowAfterScale.push(v)
    })
  }

  // C-ALL-5..7: invest T, charge each fee separately, retry 1p at a time until the refund is ≥ 0.
  // C-ALL-6 v0.9: fees are on T before the platform fee; the rows' `invested` is set after C-ALL-9b.
  const rows: AllocationRow[] = investors.map((v, i) => {
    const { feeBasis, p, pctFees, perInvFees, own } = terms[i]
    const pctFee = (I: number, rate: number) =>
      feeBasis === 'deducted' ? mulDivN(I, rate, 10_000 - p, 'halfUp') : mulDivN(I, rate, 10_000, 'halfUp')
    const base = {
      id: v.id,
      name: v.name,
      scheme: v.scheme,
      received: v.received,
      target: T[i],
      scaledBack: scaledBack && !exclusion[i] && T[i] < inM[i],
      ownTerms: v.ownTerms ?? null,
      carryBps: v.carryBps ?? null,
    }
    const out = (reason: ExclusionReason): AllocationRow => ({
      ...base,
      participating: false,
      exclusion: reason,
      ownFee: own ? 0 : null,
      preFeeInvested: 0,
      platformShare: 0,
      invested: 0,
      fees: Object.create(null),
      feesTotal: 0,
      refund: v.received,
      microShares: equity ? 0n : null,
      claimableShares: equity ? 0 : null,
      claimableAmount: equity ? 0 : null,
      nonClaimable: equity ? 0 : null,
    })
    if (exclusion[i]) return out(exclusion[i]!)
    let I = T[i]
    for (;;) {
      if (I <= 0) return out('zero-investment')
      const feeMap: Record<string, number> = Object.create(null) // fee ids such as "__proto__" stay ordinary keys
      for (const f of pctFees) feeMap[f.id] = pctFee(I, f.value)
      for (const f of perInvFees) feeMap[f.id] = f.value
      const ownFee = own === null ? null : own.fee?.kind === 'percent' ? pctFee(I, own.fee.bps) : own.fee?.kind === 'fixed' ? own.fee.amount : 0
      const feesTotal = sum(Object.values(feeMap)) + (ownFee ?? 0)
      const refund = v.received - I - feesTotal
      if (refund < 0) {
        I -= 1
        continue
      }
      return {
        ...base,
        participating: true,
        exclusion: null,
        ownFee,
        preFeeInvested: I,
        platformShare: 0,
        invested: I,
        fees: feeMap,
        feesTotal,
        refund,
        ...shareFields(I),
      }
    }
  })

  function shareFields(I: number): Pick<AllocationRow, 'microShares' | 'claimableShares' | 'claimableAmount' | 'nonClaimable'> {
    if (!equity || price === null) return { microShares: null, claimableShares: null, claimableAmount: null, nonClaimable: null }
    const J = Math.max(I, 0) // a blocked platform fee can leave I ≤ 0; the figures are only for inspection (C-03)
    const claimableShares = toNum(mulDiv(J, 10_000, price, 'floor'))
    const claimableAmount = toNum(mulDiv(claimableShares, price, 10_000, 'floor'))
    return {
      microShares: mulDiv(BigInt(J) * 10_000n, 1_000_000n, price, 'floor'),
      claimableShares,
      claimableAmount,
      nonClaimable: J - claimableAmount,
    }
  }

  // C-ALL-9b: pro-rata platform fee on B = Σ final T; investors pay by largest remainder (ties to the earlier person).
  const pf = input.platformFee ?? null
  const B = sumExact(rows.map((r) => r.preFeeInvested))
  let platformFee: AllocationResult['totals']['platformFee'] = null
  const platformBlocked: AllocationRow[] = []
  if (pf && B > 0) {
    const amount = platformFeeAmount(B, pf)
    platformFee = { amount, base: B, payer: pf.payer }
    if (pf.payer === 'investors') {
      const S = splitProRata(amount, rows.map((r) => r.preFeeInvested))
      rows.forEach((r, i) => {
        if (!r.participating) return
        r.platformShare = S[i]
        r.invested = r.preFeeInvested - S[i]
        Object.assign(r, shareFields(r.invested))
        if (S[i] >= r.preFeeInvested) platformBlocked.push(r)
      })
    }
  }

  // C-ALL-9a: deal-level fees and the wire, on Σ I. Not computed while the platform fee blocks (Σ I may be ≤ 0).
  const invested = sumExact(rows.map((r) => r.invested))
  // only when investors pay: a company-paid fee is checked by company-fees-exceed, a lead-paid one is an invoice
  const pfBlocked = platformFee !== null && platformFee.payer === 'investors' && (platformFee.amount > B || platformBlocked.length > 0)
  const feeTotals = fees.map((f) => ({
    id: f.id,
    label: f.label,
    payer: f.payer,
    kind: f.kind,
    amount:
      f.payer === 'investors'
        ? sumExact(rows.map((r) => r.fees[f.id] ?? 0))
        : pfBlocked
          ? null
          : f.kind === 'percent'
            ? mulDivN(invested, f.value, 10_000, 'halfUp')
            : f.value,
  }))
  const payerShare = (who: FeePayer) => (platformFee && platformFee.payer === who ? platformFee.amount : 0)
  const companyFees = pfBlocked ? null : sumExact(feeTotals.filter((f) => f.payer === 'company').map((f) => f.amount ?? 0)) + payerShare('company')
  const leadInvoice = pfBlocked ? null : sumExact(feeTotals.filter((f) => f.payer === 'lead').map((f) => f.amount ?? 0)) + payerShare('lead')
  const participants = rows.filter((r) => r.participating)

  const byScheme: AllocationResult['byScheme'] = {
    none: { investors: 0, invested: 0, microShares: equity ? 0n : null },
    SEIS: { investors: 0, invested: 0, microShares: equity ? 0n : null },
    EIS: { investors: 0, invested: 0, microShares: equity ? 0n : null },
  }
  for (const r of participants) {
    const g = byScheme[r.scheme]
    g.investors += 1
    g.invested += r.invested
    if (g.microShares !== null && r.microShares !== null) g.microShares += r.microShares
  }

  const blockers: AllocationResult['blockers'] = []
  const blockerIds: AllocationResult['blockerIds'] = {}
  const block = (code: BlockerCode, who: { id: string; name: string }[]) => {
    blockers.push({ code, names: who.map((x) => x.name) })
    blockerIds[code] = who.map((x) => x.id)
  }
  if (participants.length === 0) block('no-participants', [])
  if (companyFees !== null && companyFees > invested) block('company-fees-exceed', [])
  if (belowAfterScale.length) block('scale-back-below-minimum', belowAfterScale)
  if (pfBlocked) block('platform-fee-exceeds', platformBlocked)

  const result: AllocationResult = {
    rows,
    feeTotals,
    totals: {
      received: sumExact(rows.map((r) => r.received)),
      invested,
      investorFees: sumExact(rows.map((r) => r.feesTotal)),
      refunds: sumExact(rows.map((r) => r.refund)),
      companyFees,
      leadInvoice,
      wire: companyFees === null ? null : invested - companyFees,
      platformFee,
    },
    byScheme,
    scaledBack,
    blockers,
    blockerIds,
  }

  const checks: Check[] = [
    {
      id: 'cash-balances',
      kind: 'invariant',
      label: 'For every investor, cash received = invested + platform fee share + fees + refund',
      pass: rows.every((r) => r.received === r.invested + r.platformShare + r.feesTotal + r.refund),
    },
    {
      id: 'platform-identity',
      kind: 'invariant',
      label: 'Invested = target − platform fee share',
      pass: rows.every((r) => r.invested === r.preFeeInvested - r.platformShare),
    },
    {
      id: 'platform-fee-split',
      kind: 'invariant',
      label: 'Investors’ platform fee shares add up to the platform fee',
      pass: !platformFee || platformFee.payer !== 'investors' || sumExact(rows.map((r) => r.platformShare)) === platformFee.amount,
    },
    {
      id: 'platform-fee-rate',
      kind: 'invariant',
      label: 'Platform fee matches its rate, minimum, maximum and add-on',
      pass: !platformFee || (pf !== null && platformFee.base === sumExact(participants.map((r) => r.preFeeInvested)) && platformFeeAmount(platformFee.base, pf) === platformFee.amount),
    },
    {
      id: 'no-negative-refund',
      kind: 'invariant',
      label: 'No refund is negative',
      pass: rows.every((r) => r.refund >= 0),
    },
    {
      id: 'fee-items',
      kind: 'invariant',
      label: 'Each investor-paid fee adds up across investors',
      pass: feeTotals
        .filter((f) => f.payer === 'investors')
        .every((f) => f.amount === sumExact(participants.map((r) => r.fees[f.id] ?? 0))),
    },
    {
      // Independent of how each fee was computed: total investor % fees must sit within one penny per fee
      // of the rate applied to the right base (self-test #6 — catches a fee computed on the wrong base).
      id: 'fee-rate',
      kind: 'invariant',
      label: 'Investor percentage fees match their rates',
      pass: participants.every((r) => {
        const { feeBasis, p, pctFees, own } = terms[rows.indexOf(r)]
        if (own && own.fee?.kind !== 'percent') return true // a fixed own fee or none: nothing to check against a rate
        const pct = own ? (r.ownFee ?? 0) : sum(pctFees.map((f) => r.fees[f.id]))
        const items = own ? 1 : pctFees.length
        const expectedX10000 = feeBasis === 'deducted' ? BigInt(r.preFeeInvested) * BigInt(p) * 10_000n / BigInt(10_000 - p) : BigInt(r.preFeeInvested) * BigInt(p)
        const diff = BigInt(pct) * 10_000n - expectedX10000
        return (diff < 0n ? -diff : diff) <= BigInt(items) * 10_000n
      }),
    },
    {
      id: 'non-participants',
      kind: 'invariant',
      label: 'Investors who are out pay no fees and get everything back',
      pass: rows.filter((r) => !r.participating).every((r) => r.invested === 0 && r.platformShare === 0 && r.feesTotal === 0 && r.refund === r.received),
    },
    {
      id: 'cap',
      kind: 'invariant',
      label: 'Total invested is within the round cap',
      pass: cap === null || invested <= cap,
    },
    {
      id: 'wire',
      kind: 'invariant',
      label: 'Wire to company + company-paid fees = total invested',
      pass: result.totals.wire === null || companyFees === null || result.totals.wire + companyFees === invested,
    },
    {
      id: 'no-participants',
      kind: 'blocker',
      label: 'At least one investor is in the allocation',
      pass: participants.length > 0,
    },
    {
      id: 'company-fees-exceed',
      kind: 'blocker',
      label: 'Company-paid fees do not exceed the amount raised',
      pass: companyFees === null || companyFees <= invested,
    },
    {
      id: 'scale-back-below-minimum',
      kind: 'blocker',
      label: 'Nobody falls below the minimum after scale-back',
      pass: belowAfterScale.length === 0,
      detail: belowAfterScale.map((v) => v.name).join(', '),
    },
    {
      id: 'platform-fee-exceeds',
      kind: 'blocker',
      label: 'The platform fee leaves every investor something to invest',
      pass: !pfBlocked,
      detail: platformBlocked.map((r) => r.name).join(', '),
    },
    ...participants
      .filter((r) => r.scheme !== 'none' && r.nonClaimable !== null && r.nonClaimable > 0)
      .map(
        (r): Check => ({
          id: `seis-eis-remainder-${r.id}`,
          kind: 'warning',
          label: `${r.name}: part of the investment is outside whole shares for ${r.scheme}`,
          pass: false,
          detail: SEIS_EIS_HINT,
        }),
      ),
  ]
  return finish(result, checks)
}

/** C-ALL-8 wording, verbatim. */
export const SEIS_EIS_HINT =
  'This estimate uses whole shares in the final allocation. Fees, scale-back and rounding can leave a remainder even when the wire is a multiple of the share price. Check the final allocated share count.'

/** R-ALL-13: shown with the platform fee payer (its consent lives outside this tool) */
export const PLATFORM_PAYER_NOTE = "This changes each investor's amount invested. Get their consent as your process requires."

/** C-ALL-8 v0.9: no S/EIS estimate without shares (convertible, fund units) */
export const NO_SHARES_SEIS = 'No shares yet — any S/EIS claim depends on shares issued later.'

export const SEIS_BEFORE_EIS_NOTE =
  'SEIS shares must be issued on an earlier day than EIS shares — the same day is not enough.'
