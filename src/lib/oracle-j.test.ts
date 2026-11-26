// Test Plan §1 "独立复算" for decision J: the TypeScript engines and the independent Python oracle agree on
// generated v0.9 cases (SCHEMA.md "v0.9 extension"). Error outputs compare `ok` only (the oracle adds a code).
import { describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { allocate, type AllocationInput, type Fee, type OwnTerms } from './allocation'
import { distribute, type WaterfallInput } from './waterfall'
import { reconcile, type BankLine, type Commitment } from './reconcile'
import { handoffToAllocation } from './reconcile'

type Case = Record<string, unknown> & { kind: 'allocation' | 'waterfall' | 'reconcile' | 'handoff'; id?: string }

function pyRun(cases: Case[]): unknown[] {
  const dir = mkdtempSync(join(tmpdir(), 'oracle-j-'))
  const file = join(dir, 'cases.json')
  writeFileSync(file, JSON.stringify(cases))
  return JSON.parse(execFileSync('python3', [new URL('../../scripts/oracle/batch.py', import.meta.url).pathname, file], { encoding: 'utf8', maxBuffer: 1 << 28 }))
}
function rng(seed: number) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}
const sortKeys = (x: unknown): unknown =>
  Array.isArray(x) ? x.map(sortKeys) : x && typeof x === 'object' ? Object.fromEntries(Object.keys(x).sort().map((k) => [k, sortKeys((x as Record<string, unknown>)[k])])) : x
const okOnly = (x: unknown) => ((x as { ok?: boolean }).ok === false ? { ok: false } : x)

// ---------- TypeScript side in the oracle's shapes ----------

type OracleTerms = { mode: 'deducted' | 'onTop'; fee: null | { kind: 'percent' | 'fixed'; value: number } }
const toTerms = (t: OracleTerms): OwnTerms => ({ mode: t.mode, fee: t.fee === null ? null : t.fee.kind === 'percent' ? { kind: 'percent', bps: t.fee.value } : { kind: 'fixed', amount: t.fee.value } })

function tsAllocation(c: Case) {
  const x = c as unknown as Omit<AllocationInput, 'investors' | 'platformFee'> & { investors: { id: string; received: number; scheme: 'none' | 'SEIS' | 'EIS'; ownTerms?: OracleTerms }[]; platformFee?: Record<string, unknown> | null }
  const pf = x.platformFee
  const o = allocate({
    feeBasis: x.feeBasis,
    minimum: x.minimum,
    cap: x.cap,
    priceMicros: x.priceMicros ?? null,
    instrument: x.instrument,
    fees: x.fees.map((f) => ({ ...f, label: f.id })),
    platformFee: pf ? { rateBps: pf.rate as number, minimum: pf.minimum as number, maximum: pf.maximum as number | null, addOnThreshold: pf.addOnThreshold as number | null, addOnBps: (pf.addOnRate as number | null) ?? 0, payer: pf.payer as Fee['payer'] } : null,
    investors: x.investors.map((v) => ({ id: v.id, name: v.id, received: v.received, scheme: v.scheme, ...(v.ownTerms ? { ownTerms: toTerms(v.ownTerms) } : {}) })),
  })
  if (!o.ok) return { ok: false }
  const r = o.result
  const invFees = x.fees.filter((f) => f.payer === 'investors')
  return {
    ok: true,
    investors: Object.fromEntries(
      r.rows.map((y) => [
        y.id,
        {
          participating: y.participating,
          invested: y.invested,
          fees: y.participating && !y.ownTerms ? Object.fromEntries(invFees.map((f) => [f.id, y.fees[f.id]])) : {},
          refund: y.refund,
          microShares: y.microShares === null ? null : String(y.microShares),
          claimableShares: y.claimableShares,
          claimableAmount: y.claimableAmount,
          target: y.preFeeInvested,
          ownFee: y.ownFee,
          platformFeeShare: y.platformShare,
          exclusion: y.exclusion,
        },
      ]),
    ),
    feeTotals: Object.fromEntries(r.feeTotals.map((f) => [f.id, f.amount])),
    totalInvested: r.totals.invested,
    companyFees: r.totals.companyFees,
    leadInvoice: r.totals.leadInvoice,
    wire: r.totals.wire,
    blockers: r.blockers.map((b) => b.code).sort(),
    blockerIds: Object.fromEntries(r.blockers.map((b) => [b.code, r.blockerIds[b.code] ?? []])),
    platformFee: r.totals.platformFee,
    received: r.totals.received,
    investorFees: r.totals.investorFees,
    refunds: r.totals.refunds,
  }
}

function tsWaterfall(c: Case) {
  const x = c as unknown as Omit<WaterfallInput, 'holdings' | 'payees'> & { holdings: { id: string; capital: number; carry?: number | null }[]; payees?: { name: string; share: number }[] | null }
  const raw = c.carry as { mode: string; tiers?: { upTo100: number | null; rate: number }[] }
  const carry = (raw.mode === 'tiered' ? { ...raw, tiers: raw.tiers!.map((t) => ({ ...t, upTo100: t.upTo100 === null ? null : BigInt(t.upTo100) })) } : raw) as WaterfallInput['carry']
  const o = distribute({
    proceeds: x.proceeds,
    exitCosts: x.exitCosts,
    years100: x.years100,
    carry,
    holdings: x.holdings.map((h) => ({ id: h.id, name: h.id, capital: h.capital, ...('carry' in h ? { carryBps: h.carry ?? null } : {}) })),
    ...(x.payees ? { payees: x.payees.map((p) => ({ name: p.name, shareBps: p.share })) } : {}),
  })
  if (!o.ok) return { ok: false }
  const r = o.result
  const anyCarry = x.holdings.some((h) => h.carry !== undefined && h.carry !== null)
  const extended = x.holdings.some((h) => 'carry' in h) || 'payees' in c
  const old = {
    ok: true,
    blockers: r.shortfall > 0 ? ['exit-cost-shortfall'] : [],
    shortfall: r.shortfall,
    costsPaid: r.costsPaid,
    returnOfCapital: r.returnOfCapital,
    hurdlePaid: r.hurdlePaid,
    catchUpTranche: r.catchUpTranche,
    catchUpToLead: r.catchUpToLead,
    carry: r.carry,
    investorsTotal: r.investorsTotal,
    distributions: Object.fromEntries(r.rows.map((y) => [y.id, y.distribution])),
  }
  if (!extended) return old
  return {
    ...old,
    perInvestor: r.perInvestor
      ? Object.fromEntries(
          r.perInvestor.map((p) => [
            p.id,
            { distributable: p.share, k: p.carryBps, returnOfCapital: p.returnOfCapital, hurdlePaid: p.hurdlePaid, catchUpTranche: p.catchUpTranche, catchUpToLead: p.catchUpToLead, carry: p.carry, distribution: p.distribution },
          ]),
        )
      : null,
    payees: r.shortfall > 0 ? null : r.payees.map((p) => ({ name: p.name, amount: p.amount })),
    tieredNotice: r.tieredNote,
    carryUsed: carry.mode === 'fixed' && anyCarry ? Object.fromEntries(r.rows.map((y) => [y.id, y.carryBps!])) : null,
  }
}

function tsReconcile(c: Case) {
  const commitments: Commitment[] = (c.commitments as (Omit<Commitment, 'email' | 'scheme'> & { refunded?: number | null })[]).map((x) => ({
    ...x,
    email: '',
    scheme: 'none' as const,
    refunded: x.refunded ?? undefined,
  }))
  const lines = c.lines as BankLine[]
  const withdrawn: Record<string, string> = Object.create(null)
  for (const id of (c.withdrawn as string[] | undefined) ?? []) withdrawn[id] = '2026-10-16'
  const o = reconcile({ commitments, lines, decisions: {}, asOf: c.asOf as string, thresholdDays: c.thresholdDays as number, withdrawn, due: {} })
  if (!o.ok) return { ok: false }
  const r = o.result
  const status = (x: (typeof r.commitments)[number]) =>
    x.status === 'withdrawn' && x.refundOnly === 'withdrawn' ? 'withdrawn-imported' : x.status === 'refund-only' ? 'closed-refund-only' : x.status
  const h = handoffToAllocation({ ...r, pendingSuggestions: 0, notCovered: [] })
  const handoff = h.ok
    ? Object.fromEntries(h.value.investors.map((v) => [v.id, v.received]))
    : Object.fromEntries(r.commitments.filter((x) => x.received >= 0 && x.withdrawnOn === null && x.refundOnly === null).map((x) => [x.commitment.id, Math.min(x.received, x.due)]))
  return {
    lines: Object.fromEntries(
      r.lines.map((l) => [
        l.line.id,
        {
          status: l.status,
          assignedTo: l.assignedTo,
          suspectedDuplicate: l.suspectedDuplicate,
          candidates: l.status === 'suggested' ? l.candidates.map((x) => ({ id: x.commitmentId, score: Math.round(x.score * 10_000) / 10_000 })) : [],
        },
      ]),
    ),
    commitments: Object.fromEntries(
      r.commitments.map((x) => [
        x.commitment.id,
        {
          received: x.received,
          difference: x.difference,
          status: status(x),
          cashDue: x.due,
          // the oracle's `withdrawn` says a manual mark exists; the engine's withdrawnOn is the mark in force (an imported flag wins)
          withdrawn: ((c.withdrawn as string[] | undefined) ?? []).includes(x.commitment.id),
          booked: x.received + (x.commitment.refunded ?? 0),
          refunded: x.commitment.refunded ?? 0,
          refundOnly: x.refundOnly,
        },
      ]),
    ),
    totals: { bank: r.totals.bank, booked: r.totals.booked, unbooked: r.totals.unbooked },
    aged: r.lines.filter((l) => l.aged).map((l) => l.line.id).sort(),
    refunds: r.refunds.map((x) => ({ id: x.id, amount: x.amount, reason: x.reason === 'Withdrawn' ? 'withdrawn' : x.reason === 'Refund only' ? 'refund-only' : 'overpayment' })),
    refundTotal: r.refunds.reduce((a, b) => a + b.amount, 0),
    receivable: r.totals.cashDue,
    withdrawnSummary: { count: r.totals.withdrawn.count, refund: r.totals.withdrawn.toRefund },
    chase: r.commitments.filter((x) => x.status === 'partial' || x.status === 'outstanding').map((x) => ({ id: x.commitment.id, outstanding: x.due - x.received })),
    handoff,
    handoffBlockedBy: r.commitments.filter((x) => x.received < 0).map((x) => x.commitment.id),
    checks: { refundIdentity: o.checks.some((k) => k.id === 'refunds-tie' && k.pass) },
  }
}

const tsRun = (c: Case) => (c.kind === 'allocation' ? tsAllocation(c) : c.kind === 'waterfall' ? tsWaterfall(c) : tsReconcile(c))

// ---------- generators (decision J inputs) ----------

function genAllocation(r: () => number, i: number): Case {
  const int = (lo: number, hi: number) => lo + Math.floor(r() * (hi - lo + 1))
  const feeBasis = r() < 0.5 ? 'deducted' : 'onTop'
  const fees: Fee[] = []
  for (let k = int(0, 2); k > 0; k--) fees.push({ id: `p${fees.length}`, label: '', kind: 'percent', value: int(0, 1500), payer: 'investors' })
  if (r() < 0.3) fees.push({ id: `q${fees.length}`, label: '', kind: 'perInvestor', value: int(1, 5_000), payer: 'investors' })
  if (r() < 0.4) {
    const kind = r() < 0.5 ? 'percent' : 'fixed'
    fees.push({ id: `c${fees.length}`, label: '', kind, value: kind === 'percent' ? int(0, 800) : int(1, 300_000), payer: 'company' })
  }
  if (r() < 0.3) fees.push({ id: `l${fees.length}`, label: '', kind: r() < 0.5 ? 'percent' : 'fixed', value: int(1, 2_000), payer: 'lead' })
  const instrument = (['equity', 'equity', 'convertible', 'fund_units'] as const)[int(0, 3)]
  const investors = Array.from({ length: int(1, 10) }, (_, j) => {
    const own = r() < 0.6
    const mode = r() < 0.5 ? 'deducted' : 'onTop'
    const fee = r() < 0.2 ? null : r() < 0.6 ? { kind: 'percent' as const, value: int(0, mode === 'deducted' ? 5_000 : 9_000) } : { kind: 'fixed' as const, value: int(1, 50_000) }
    return { id: `i${j}`, received: r() < 0.1 ? int(0, 300) : int(0, 3_000_000), scheme: (['none', 'SEIS', 'EIS'] as const)[int(0, 2)], ...(own ? { ownTerms: { mode, fee } } : {}) }
  })
  const demand = investors.reduce((a, b) => a + b.received, 0)
  const threshold = r() < 0.5 ? null : int(0, 2_000_000)
  const max = r() < 0.4 ? null : int(0, 300_000)
  const min = int(0, max ?? 400_000)
  return {
    kind: 'allocation',
    id: `alloc-j-${i}`,
    feeBasis,
    minimum: r() < 0.5 ? 0 : int(1, 800_000),
    cap: r() < 0.6 ? null : int(1, Math.max(1, demand)),
    instrument,
    priceMicros: instrument === 'equity' ? [1_000_000, 2_413_700, int(1, 50_000_000)][int(0, 2)] : null,
    fees,
    platformFee: r() < 0.25 ? null : { rate: int(0, 500), minimum: min, maximum: max, addOnThreshold: threshold, addOnRate: threshold === null ? null : int(0, 200), payer: (['investors', 'investors', 'lead', 'company'] as const)[int(0, 3)] },
    investors,
  }
}

function genWaterfall(r: () => number, i: number): Case {
  const int = (lo: number, hi: number) => lo + Math.floor(r() * (hi - lo + 1))
  const tiered = r() < 0.25
  const holdings = Array.from({ length: int(1, 6) }, (_, j) => ({ id: `h${j}`, capital: int(1, 5_000_000) }))
  const mode = int(0, 3) // 0 none, 1 all equal, 2 differ, 3 mixed blanks
  const common = int(0, 3_000)
  const withCarry = holdings.map((h) => ({ ...h, carry: mode === 0 ? undefined : mode === 1 ? common : mode === 3 && r() < 0.4 ? null : int(0, 3_000) }))
  const k = int(0, 3_000)
  const h = r() < 0.5 ? int(0, 1_500) : 0
  const used = withCarry.map((x) => (x.carry === undefined || x.carry === null ? k : x.carry))
  const c = h > 0 && r() < 0.6 ? Math.min(10_000, Math.max(...used) + 1 + int(0, 3_000)) : 0
  const nPay = r() < 0.5 ? 0 : int(1, 4)
  const payees =
    nPay === 0
      ? null
      : (() => {
          const shares = Array.from({ length: nPay }, () => int(1, 100))
          const total = shares.reduce((a, b) => a + b, 0)
          const bps = shares.map((s) => Math.floor((s * 10_000) / total))
          bps[0] += 10_000 - bps.reduce((a, b) => a + b, 0)
          return bps.map((s, j) => ({ name: `Payee ${j + 1}`, share: s }))
        })()
  return {
    kind: 'waterfall',
    id: `wf-j-${i}`,
    holdings: withCarry.map((x) => (x.carry === undefined ? { id: x.id, capital: x.capital } : x)),
    proceeds: int(0, 60_000_000),
    exitCosts: r() < 0.8 ? 0 : int(0, 1_000_000),
    years100: int(0, 1_000),
    carry: tiered ? { mode: 'tiered', tiers: [{ upTo100: int(150, 300), rate: int(0, 2_500) }, { upTo100: null, rate: int(0, 4_000) }] } : { mode: 'fixed', k, h, c },
    ...(payees ? { payees } : {}),
  }
}

function genReconcile(r: () => number, i: number): Case {
  const int = (lo: number, hi: number) => lo + Math.floor(r() * (hi - lo + 1))
  const names = ['Ann Lee', 'Bo Kim', 'Cy Diaz', 'Di Roy', 'Ed Fox', 'Flo Ng']
  const commitments = Array.from({ length: int(1, 6) }, (_, j) => ({
    id: `c${j}`,
    name: names[j],
    reference: `NW-${100 + j}`,
    cashDue: int(1, 2_000_000),
    refunded: r() < 0.4 ? int(0, 300_000) : null,
    refundOnly: r() < 0.25 ? (r() < 0.5 ? 'withdrawn' : 'closed') : null,
  }))
  const lines = Array.from({ length: int(0, 10) }, (_, j) => {
    const who = commitments[int(0, commitments.length - 1)]
    return { id: `l${j}`, txnId: `T${j}`, date: `2026-10-${String(int(1, 25)).padStart(2, '0')}`, amount: r() < 0.9 ? (r() < 0.5 ? who.cashDue : int(1, 2_000_000)) : -int(0, 1_000), payer: r() < 0.5 ? who.name.toUpperCase() : 'SOMEONE', reference: [who.reference, `NW ${100 + int(0, 8)}`, 'INV 4471'][int(0, 2)] }
  })
  return { kind: 'reconcile', id: `rec-j-${i}`, asOf: '2026-10-20', thresholdDays: 10, commitments, lines, decisions: {}, withdrawn: commitments.filter(() => r() < 0.15).map((x) => x.id), adjustedCashDue: {} }
}

describe('independent oracle agreement — decision J', () => {
  const r = rng(20261125)
  const cases: Case[] = [
    ...Array.from({ length: 1_000 }, (_, i) => genAllocation(r, i)),
    ...Array.from({ length: 1_000 }, (_, i) => genWaterfall(r, i)),
    ...Array.from({ length: 1_000 }, (_, i) => genReconcile(r, i)),
  ]
  const py = pyRun(cases)

  it('ORACLE-J1 3,000 generated decision J cases agree field by field (own terms, platform fee, instruments, personal carry, payees, net received, refund-only)', () => {
    const mismatches: string[] = []
    cases.forEach((c, i) => {
      const a = JSON.stringify(sortKeys(okOnly(tsRun(c))))
      const b = JSON.stringify(sortKeys(okOnly(py[i])))
      if (a !== b) mismatches.push(`${c.id}\nTS: ${a}\nPY: ${b}\nCASE: ${JSON.stringify(c)}`)
    })
    expect(mismatches.slice(0, 2).join('\n\n'), `${mismatches.length} mismatches`).toBe('')
    // 3,000 cases take about 2 s here and went past the 5 s default on the CI runner (failed twice there, never locally)
  }, 60_000)

  it('ORACLE-J2 the generated cases reach the new paths, not only errors', () => {
    const ok = (i: number) => (py[i] as { ok?: boolean }).ok !== false
    const allocOk = cases.map((_, i) => i).filter((i) => cases[i].kind === 'allocation' && ok(i))
    expect(allocOk.length / 1_000).toBeGreaterThan(0.9)
    expect(allocOk.filter((i) => (py[i] as { platformFee: unknown }).platformFee !== null).length).toBeGreaterThan(300)
    const perInvestor = cases.filter((c, i) => c.kind === 'waterfall' && ok(i) && (py[i] as { perInvestor: unknown }).perInvestor !== null).length
    expect(perInvestor).toBeGreaterThan(150)
  })

  it('ORACLE-J3 the hand-off vectors: the oracle computes the same hashes and the TC-J-45 result', () => {
    const vectors = JSON.parse(readFileSync('docs/formats/allocation-handoff-v1.vectors.json', 'utf8')).vectors as { kind: string; projection?: unknown; projection_hash?: string; request_text?: string; expected_result?: unknown }[]
    const hv: Case[] = [
      ...vectors.filter((v) => v.kind === 'canonical').map((v) => ({ kind: 'handoff' as const, projection: v.projection })),
      ...vectors.filter((v) => v.kind === 'result').map((v) => ({ kind: 'handoff' as const, requestText: v.request_text, dealCurrency: 'GBP' })),
    ]
    const out = pyRun(hv) as { ok: boolean; hash?: string; result?: unknown }[]
    const canon = vectors.filter((v) => v.kind === 'canonical')
    canon.forEach((v, i) => expect(out[i].hash).toBe(v.projection_hash))
    expect(sortKeys(out[canon.length].result)).toEqual(sortKeys(vectors.find((v) => v.kind === 'result')!.expected_result))
  })
})
