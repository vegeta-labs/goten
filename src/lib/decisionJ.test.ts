// Decision J engine cases (Test Plan §2.6, PRD v0.9). Amounts in pence; £1 = 100.
import Papa from 'papaparse'
import { describe, expect, it } from 'vitest'
import { allocate, type AllocationInput, type AllocationInvestor, type AllocationResult } from './allocation'
import { platformFeeAmount } from './money'
import { distribute, type Holding, type WaterfallInput, type WaterfallResult } from './waterfall'
import { handoffToAllocation, reconcile, type BankLine, type Commitment } from './reconcile'
import { previewFeePayerChange } from './feePayer'
import { importCommitments, importHoldings, importInvestors } from './csv'
import { allocationCsv, chaseListCsv, distributionCsv, holdingsCsv, payeesCsv, closingConfirmation } from './exports'

const P = (pounds: number) => Math.round(pounds * 100)
const inv = (id: string, received: number, extra: Partial<AllocationInvestor> = {}): AllocationInvestor => ({ id, name: id, received, scheme: 'none', ...extra })
const base: AllocationInput = { feeBasis: 'deducted', minimum: 0, cap: null, priceMicros: 1_000_000, fees: [], investors: [] }
function alloc(x: Partial<AllocationInput>): AllocationResult {
  const o = allocate({ ...base, ...x })
  if (!o.ok) throw new Error(JSON.stringify(o.errors))
  return o.result
}
const row = (r: AllocationResult, id: string) => r.rows.find((x) => x.id === id)!
const pf = (rateBps: number, minimum: number, payer: 'investors' | 'company' | 'lead' = 'investors', maximum: number | null = null) => ({
  rateBps,
  minimum,
  maximum,
  addOnThreshold: null,
  addOnBps: 0,
  payer,
})
const threePct = { id: 'f3', label: 'Platform fee', payer: 'investors' as const, kind: 'percent' as const, value: 300 }

describe('decision J — allocation (C-ALL-0, 3, 5, 8, 9a, 9b)', () => {
  it('TC-J-02 own terms replace the deal investor fees', () => {
    const r = alloc({ fees: [threePct], investors: [inv('X', P(10_400), { ownTerms: { mode: 'onTop', fee: { kind: 'percent', bps: 400 } } }), inv('Y', P(10_000))] })
    expect([row(r, 'X').preFeeInvested, row(r, 'X').ownFee, row(r, 'X').fees.f3, row(r, 'X').refund]).toEqual([P(10_000), P(400), undefined, 0])
    expect([row(r, 'Y').preFeeInvested, row(r, 'Y').fees.f3, row(r, 'Y').ownFee, row(r, 'Y').refund]).toEqual([P(9_700), P(300), null, 0])
  })

  it('TC-J-03 own terms with no cash fee pay nothing, even with a deal investor fee', () => {
    const r = alloc({ fees: [threePct], investors: [inv('X', P(5_000), { ownTerms: { mode: 'deducted', fee: null } })] })
    expect([row(r, 'X').invested, row(r, 'X').feesTotal, row(r, 'X').refund]).toEqual([P(5_000), 0, 0])
  })

  it('TC-J-04 own fixed fee deducted with received ≤ F: not participating, full refund', () => {
    const r = alloc({ investors: [inv('X', P(200), { ownTerms: { mode: 'deducted', fee: { kind: 'fixed', amount: P(250) } } })] })
    expect([row(r, 'X').participating, row(r, 'X').exclusion, row(r, 'X').refund]).toEqual([false, 'fees-exceed-receipt', P(200)])
  })

  it('TC-J-05 own fixed fee on top: the minimum compares M', () => {
    const terms = { ownTerms: { mode: 'onTop' as const, fee: { kind: 'fixed' as const, amount: P(250) } } }
    expect(row(alloc({ minimum: P(10_000), investors: [inv('X', P(10_250), terms)] }), 'X').participating).toBe(true)
    expect(row(alloc({ minimum: P(10_000), investors: [inv('X', P(10_249.99), terms)] }), 'X').exclusion).toBe('below-minimum')
  })

  it('TC-J-06 scale-back minimum check on each person’s commitment basis (R30)', () => {
    const investors = [inv('X', P(20_000), { ownTerms: { mode: 'deducted', fee: { kind: 'fixed', amount: P(250) } } }), inv('Y', P(100_000))]
    const ok = alloc({ cap: P(100_000), minimum: P(16_600), investors })
    expect([row(ok, 'X').preFeeInvested, row(ok, 'Y').preFeeInvested]).toEqual([P(16_492.69), P(83_507.31)])
    expect(ok.blockers).toEqual([])
    const no = alloc({ cap: P(100_000), minimum: P(16_800), investors })
    expect(no.blockers).toEqual([{ code: 'scale-back-below-minimum', names: ['X'] }])
  })

  it('TC-J-07 an own rate of 100% deducted is an input error; on top it halves', () => {
    expect(allocate({ ...base, investors: [inv('X', P(100), { ownTerms: { mode: 'deducted', fee: { kind: 'percent', bps: 10_000 } } })] }).ok).toBe(false)
    const r = alloc({ investors: [inv('X', P(100), { ownTerms: { mode: 'onTop', fee: { kind: 'percent', bps: 10_000 } } })] })
    expect(row(r, 'X').preFeeInvested).toBe(P(50))
  })

  it('TC-J-08 platform fee formula, each part rounded half-up on its own', () => {
    const f = { rateBps: 250, minimum: P(4_000), maximum: P(20_000), addOnThreshold: P(5_000_000), addOnBps: 10 }
    expect([P(100_000), P(500_000), P(1_000_000), P(6_000_000)].map((B) => platformFeeAmount(B, f))).toEqual([P(4_000), P(12_500), P(20_000), P(21_000)])
    expect(platformFeeAmount(P(1_000_000), { ...f, maximum: null })).toBe(P(25_000))
    expect(platformFeeAmount(100, { rateBps: 50, minimum: 0, maximum: null, addOnThreshold: 0, addOnBps: 50 })).toBe(2)
  })

  it('TC-J-09 investors pay the platform fee pro rata', () => {
    const r = alloc({
      platformFee: pf(250, P(4_000)),
      investors: [
        inv('A', P(104_000), { ownTerms: { mode: 'onTop', fee: { kind: 'percent', bps: 400 } } }),
        inv('B', P(100_000), { ownTerms: { mode: 'deducted', fee: { kind: 'percent', bps: 400 } } }),
      ],
    })
    expect(r.totals.platformFee).toEqual({ amount: P(4_900), base: P(196_000), payer: 'investors' })
    expect([row(r, 'A').platformShare, row(r, 'A').invested, row(r, 'B').platformShare, row(r, 'B').invested]).toEqual([P(2_500), P(97_500), P(2_400), P(93_600)])
    expect(r.totals.received).toBe(r.totals.invested + r.totals.investorFees + r.totals.platformFee!.amount + r.totals.refunds)
  })

  it('TC-J-10 equal remainders of the platform fee go to the earlier person', () => {
    const fee = { rateBps: 0, minimum: 3, maximum: 3, addOnThreshold: null, addOnBps: 0, payer: 'investors' as const }
    const ab = alloc({ platformFee: fee, investors: [inv('A', P(100)), inv('B', P(100))] })
    expect([row(ab, 'A').platformShare, row(ab, 'B').platformShare]).toEqual([2, 1])
    const ba = alloc({ platformFee: fee, investors: [inv('B', P(100)), inv('A', P(100))] })
    expect([row(ba, 'B').platformShare, row(ba, 'A').platformShare]).toEqual([2, 1])
  })

  it('TC-J-11 no participants: no platform fee is worked out', () => {
    const r = alloc({ minimum: P(1_000), platformFee: pf(0, P(4_000)), investors: [inv('A', P(500))] })
    expect([r.totals.platformFee, row(r, 'A').refund, r.blockers.map((b) => b.code)]).toEqual([null, P(500), ['no-participants']])
  })

  it('TC-J-12 the platform fee blocks when a share reaches the target or the fee exceeds B', () => {
    const a = alloc({ platformFee: pf(0, P(500)), investors: [inv('A', P(500))] })
    expect(a.blockers).toEqual([{ code: 'platform-fee-exceeds', names: ['A'] }])
    const b = alloc({ platformFee: pf(0, P(600)), investors: [inv('A', P(500))] })
    expect(b.blockers).toEqual([{ code: 'platform-fee-exceeds', names: ['A'] }])
    expect(b.blockerIds['platform-fee-exceeds']).toEqual(['A'])
  })

  it('TC-J-13 a company- or lead-paid platform fee leaves I = T', () => {
    const c = alloc({ platformFee: pf(250, 0, 'company'), investors: [inv('A', P(100_000))] })
    expect([row(c, 'A').invested, c.totals.wire]).toEqual([P(100_000), P(97_500)])
    const l = alloc({ platformFee: pf(250, 0, 'lead'), investors: [inv('A', P(100_000))] })
    expect([row(l, 'A').invested, l.totals.leadInvoice, l.totals.wire]).toEqual([P(100_000), P(2_500), P(100_000)])
  })

  it('TC-J-14 company % fees use Σ I after an investor-paid platform fee', () => {
    const r = alloc({ platformFee: pf(250, 0), fees: [{ id: 'legal', label: 'Legal', payer: 'company', kind: 'percent', value: 100 }], investors: [inv('A', P(100_000))] })
    expect([r.totals.platformFee!.amount, row(r, 'A').invested, r.feeTotals[0].amount, r.totals.wire]).toEqual([P(2_500), P(97_500), P(975), P(96_525)])
  })

  it('TC-J-15 convertible: amounts only; a share price is an input error', () => {
    const r = alloc({ instrument: 'convertible', priceMicros: null, investors: [inv('A', P(10_000), { scheme: 'SEIS' })] })
    expect([row(r, 'A').invested, row(r, 'A').microShares, row(r, 'A').claimableShares, r.byScheme.SEIS.microShares]).toEqual([P(10_000), null, null, null])
    expect(allocationCsv(r, 'GBP').split(/\r?\n/)[1].split(',')[5]).toBe('')
    const bad = allocate({ ...base, instrument: 'convertible', priceMicros: 1_000_000, investors: [inv('A', P(10_000))] })
    expect(bad.ok ? [] : bad.errors.map((e) => e.message)).toContain('share price must be empty for a convertible or fund units')
    expect(alloc({ instrument: 'fund_units', priceMicros: null, investors: [inv('A', P(10_000))] }).rows[0].microShares).toBeNull()
  })

  it('TC-J-55 a blocked platform fee shows I ≤ 0 for inspection with no shares', () => {
    const r = alloc({ platformFee: pf(0, P(600)), investors: [inv('A', P(500))] })
    expect([row(r, 'A').invested, row(r, 'A').microShares, row(r, 'A').claimableShares]).toEqual([-P(100), 0n, 0])
  })

  it('TC-J-58 with the platform fee blocking, deal-level fees are not worked out (no internal error)', () => {
    const o = allocate({ ...base, platformFee: pf(0, P(600)), fees: [{ id: 'c1', label: 'C', payer: 'company', kind: 'percent', value: 100 }], investors: [inv('A', P(500))] })
    expect(o.ok).toBe(true)
    if (!o.ok) return
    expect([o.result.totals.wire, o.result.totals.companyFees, o.result.feeTotals[0].amount]).toEqual([null, null, null])
    expect(o.result.blockers.map((b) => b.code)).toEqual(['platform-fee-exceeds'])
    expect(o.checks.every((c) => c.kind !== 'invariant' || c.pass)).toBe(true) // no failed self-check (no internal error)
  })

  it('TC-J-60 the platform fee base is T after the C-ALL-7 retry', () => {
    const r = alloc({
      feeBasis: 'onTop',
      fees: [
        { id: 'a', label: 'a', payer: 'investors', kind: 'percent', value: 2_500 },
        { id: 'b', label: 'b', payer: 'investors', kind: 'percent', value: 2_500 },
      ],
      platformFee: pf(2_500, 0),
      investors: [inv('A', 3)],
    })
    expect([row(r, 'A').preFeeInvested, row(r, 'A').feesTotal, row(r, 'A').refund, r.totals.platformFee!.amount, r.blockers]).toEqual([1, 0, 2, 0, []])
  })

  it('TC-J-61 the platform fee base is T after scale-back', () => {
    const r = alloc({ cap: P(100_000), platformFee: pf(250, 0), investors: [inv('A', P(100_000)), inv('B', P(100_000))] })
    expect(r.totals.platformFee!.amount).toBe(P(2_500))
    for (const id of ['A', 'B']) expect([row(r, id).preFeeInvested, row(r, id).platformShare, row(r, id).invested, row(r, id).refund]).toEqual([P(50_000), P(1_250), P(48_750), P(50_000)])
  })

  it('TC-J-50 the closing confirmation shows own fees, platform shares and the platform fee; convertibles have no shares', () => {
    const r = alloc({
      platformFee: pf(250, P(4_000)),
      investors: [inv('A', P(104_000), { ownTerms: { mode: 'onTop', fee: { kind: 'percent', bps: 400 } } }), inv('B', P(100_000), { ownTerms: { mode: 'deducted', fee: { kind: 'percent', bps: 400 } } })],
    })
    const text = closingConfirmation('Deal', 'GBP', 1_000_000, r)
    expect(text).toContain('Pro-rata platform fee (investors): £4,900.00')
    expect(text).toContain('- A: invests £97,500.00, own fee £4,000.00, platform fee share £2,500.00, refund £0.00')
    const c = alloc({ instrument: 'convertible', priceMicros: null, investors: [inv('A', P(10_000))] })
    expect(closingConfirmation('Deal', 'GBP', null, c, [], 'convertible')).toContain('No shares (convertible)')
  })
})

describe('decision J — fee payer change (C-ALL-10)', () => {
  const people = (due: number) => [{ id: 'A', name: 'A', cashDue: due, scheme: 'none' as const }]
  it('TC-J-17 the target is T before the platform fee', () => {
    const o = previewFeePayerChange({ feeBasis: 'deducted', minimum: 0, cap: null, priceMicros: 1_000_000, platformFee: pf(250, P(4_000)), fees: [threePct], feeId: 'f3', to: 'company', investors: people(P(200_000)) })
    if (!o.ok) throw new Error('preview failed')
    expect([o.result.rows[0].target, o.result.rows[0].newDue, o.result.rows[0].difference, o.result.blockers]).toEqual([P(194_000), P(194_000), -P(6_000), []])
  })
  it('TC-J-57 a platform fee that blocks the commitment allocation blocks the change', () => {
    const o = previewFeePayerChange({ feeBasis: 'deducted', minimum: 0, cap: null, priceMicros: 1_000_000, platformFee: pf(0, P(600)), fees: [threePct], feeId: 'f3', to: 'company', investors: people(P(500)) })
    if (!o.ok) throw new Error('preview failed')
    expect(o.result.blockers.map((b) => b.code)).toContain('before-platform-fee-exceeds')
    expect(allocate({ ...base, fees: [threePct], investors: [inv('A', P(500))] }).ok && row(alloc({ fees: [threePct], investors: [inv('A', P(500))] }), 'A').preFeeInvested).toBe(P(485))
  })
})

describe('decision J — reconciliation (C-REC-3, 4, 9)', () => {
  const c = (id: string, due: number, extra: Partial<Commitment> = {}): Commitment => ({ id, name: id, email: '', reference: `NW-${id}`, cashDue: due, scheme: 'none', ...extra })
  const line = (id: string, amount: number, reference: string, payer = 'P'): BankLine => ({ id, txnId: id, date: '2026-10-01', amount, payer, reference })
  const run = (commitments: Commitment[], lines: BankLine[], withdrawn: Record<string, string> = {}) => {
    const o = reconcile({ commitments, lines, decisions: {}, asOf: '2026-10-20', thresholdDays: 10, withdrawn })
    if (!o.ok) throw new Error(JSON.stringify(o.errors))
    return o.result
  }

  it('TC-J-20 net received = booked − refunded', () => {
    const r = run([c('AAA', P(10_000), { refunded: P(1_000) })], [line('t1', P(11_000), 'NW-AAA')])
    expect([r.commitments[0].received, r.commitments[0].status, r.refunds]).toEqual([P(10_000), 'paid', []])
    const g = run([c('AAA', P(10_000))], [line('t1', P(11_000), 'NW-AAA')])
    expect(g.refunds).toEqual([{ id: 'AAA', name: 'AAA', amount: P(1_000), reason: 'Over-paid' }])
  })

  it('TC-J-21 negative net received: Check refunds, not chased, hand-off refused', () => {
    const r = run([c('AAA', P(1_000), { refunded: P(500) }), c('BBB', P(1_000), { refunded: P(500), refundOnly: 'closed' })], [])
    expect(r.commitments.map((x) => x.status)).toEqual(['check-refunds', 'check-refunds'])
    expect(chaseListCsv(r, 'GBP', 'D').split(/\r?\n/).filter(Boolean)).toHaveLength(1)
    const h = handoffToAllocation(r)
    expect(h.ok ? '' : h.reason).toBe('Check refunds for: AAA, BBB. Refunded is more than received.')
  })

  it('TC-J-22 refund-only closed: matched, not chased, not carried, refunded in full', () => {
    const r = run([c('AAA', P(1_000), { refundOnly: 'closed' }), c('BBB', P(500))], [line('t1', P(1_000), 'NW-AAA')])
    expect(r.commitments[0].status).toBe('refund-only')
    expect(r.totals.cashDue).toBe(P(500))
    expect(r.refunds).toEqual([{ id: 'AAA', name: 'AAA', amount: P(1_000), reason: 'Refund only' }])
    expect(r.totals.withdrawn).toEqual({ count: 1, toRefund: P(1_000) })
    const h = handoffToAllocation(r)
    expect(h.ok && h.value.investors.map((x) => x.id)).toEqual(['BBB'])
  })

  it('TC-J-23 an imported withdrawn flag wins over a manual withdrawal while it is there', () => {
    const r = run([c('AAA', P(1_000), { refundOnly: 'withdrawn' })], [line('t1', P(400), 'NW-AAA')], { AAA: '2026-10-10' })
    expect([r.commitments[0].status, r.commitments[0].refundOnly, r.commitments[0].withdrawnOn]).toEqual(['withdrawn', 'withdrawn', null])
    expect(r.refunds).toEqual([{ id: 'AAA', name: 'AAA', amount: P(400), reason: 'Withdrawn' }])
    const cleared = run([c('AAA', P(1_000))], [line('t1', P(400), 'NW-AAA')], { AAA: '2026-10-10' })
    expect([cleared.commitments[0].status, cleared.commitments[0].withdrawnOn]).toEqual(['withdrawn', '2026-10-10'])
  })

  it('TC-J-25 the amount score uses the outstanding amount on net received', () => {
    const lines = [line('t1', P(9_000), 'NW-AAA'), line('t2', P(2_000), 'NW-AAB', 'SOMEONE ELSE')]
    const net = run([c('AAA', P(10_000), { refunded: P(1_000) })], lines)
    expect(net.lines[1].candidates.map((x) => x.score)).toEqual([0.5])
    const gross = run([c('AAA', P(10_000))], lines)
    expect(gross.lines[1].candidates).toEqual([])
  })

  it('TC-J-27 the refund check counts refund-only and withdrawn investors in full', () => {
    const r = run(
      [c('AAA', P(1_000), { refundOnly: 'closed' }), c('BBB', P(1_000)), c('CCC', P(1_000))],
      [line('t1', P(1_000), 'NW-AAA'), line('t2', P(1_200), 'NW-BBB'), line('t3', P(300), 'NW-CCC')],
      { CCC: '2026-10-10' },
    )
    expect(r.refunds.reduce((a, x) => a + x.amount, 0)).toBe(P(1_500))
    expect(r.commitments.length).toBe(3)
  })

  it('TC-J-32 the chase list shows net received and the refunded column', () => {
    const r = run([c('AAA', P(10_000), { refunded: P(1_000) })], [line('t1', P(9_000), 'NW-AAA')])
    const [head, cells] = Papa.parse<string[]>(chaseListCsv(r, 'GBP', 'D'), { skipEmptyLines: true }).data
    expect([cells[head.indexOf('received')], cells[head.indexOf('refunded')]]).toEqual(['8000.00', '1000.00'])
  })
})

describe('decision J — exit (C-DIS-8, C-DIS-9)', () => {
  const H = (id: string, capital: number, carryBps?: number | null): Holding => ({ id, name: id, capital, ...(carryBps === undefined ? {} : { carryBps }) })
  const fixed = (k: number, h = 0, c = 0) => ({ mode: 'fixed' as const, k, h, c })
  function d(x: Partial<WaterfallInput> & { holdings: Holding[] }): WaterfallResult {
    const o = distribute({ proceeds: P(300_000), exitCosts: 0, years100: 100, carry: fixed(2_000), ...x })
    if (!o.ok) throw new Error(JSON.stringify(o.errors))
    return o.result
  }
  const three = [H('A', P(100_000), 2_000), H('B', P(50_000), 0), H('C', P(50_000), 1_000)]

  it('TC-J-33 each investor runs their own waterfall', () => {
    const r = d({ holdings: three })
    expect(r.rows.map((x) => [x.carry, x.distribution])).toEqual([[P(10_000), P(140_000)], [0, P(75_000)], [P(2_500), P(72_500)]])
    expect(r.carry).toBe(P(12_500))
  })

  it('TC-J-34 with a hurdle', () => {
    expect(d({ holdings: three, carry: fixed(2_000, 800) }).rows.map((x) => x.carry)).toEqual([P(8_400), 0, P(2_100)])
  })

  it('TC-J-35 equal personal carry runs the original algorithm with that rate', () => {
    const r = d({ holdings: [H('A', P(100_000), 1_000), H('B', P(100_000), 1_000)] })
    expect([r.carry, r.rows.map((x) => x.distribution), r.perInvestor]).toEqual([P(10_000), [P(145_000), P(145_000)], null])
  })

  it('TC-J-36 a blank carry means the deal carry: same as all blank', () => {
    const a = d({ holdings: [H('A', P(100_000)), H('B', P(100_000), 2_000)] })
    const b = d({ holdings: [H('A', P(100_000)), H('B', P(100_000))] })
    expect({ ...a, rows: a.rows.map(({ carryBps: _c, ...x }) => x) }).toEqual(b)
  })

  it('TC-J-37 tiered carry with personal carry', () => {
    const tiered = { mode: 'tiered' as const, tiers: [{ upTo100: 200n, rate: 2_000 }, { upTo100: null, rate: 3_000 }] }
    const run = (holdings: Holding[]) => distribute({ holdings, proceeds: P(300_000), exitCosts: 0, years100: 100, carry: tiered })
    const blank = run([H('A', P(100_000)), H('B', P(100_000))])
    expect(blank.ok && blank.result.tieredNote).toBeNull()
    const ten = run([H('A', P(100_000), 1_000), H('B', P(100_000), 1_000)])
    expect(ten.ok && ten.result.tieredNote).toBe(1_000)
    const mixed = run([H('A', P(100_000)), H('B', P(100_000), 1_000)])
    expect(mixed.ok ? [] : mixed.errors.map((e) => e.message)).toContain("Fill in every investor's carry, or none, for tiered carry")
    const differ = run([H('A', P(100_000), 1_000), H('B', P(100_000), 2_000)])
    expect(differ.ok ? [] : differ.errors.map((e) => e.message)).toContain('Tiered carry needs the same carry for every investor')
  })

  it('TC-J-38 catch-up is checked on the carry rates actually used', () => {
    const two = (a: number, b: number) => [H('A', P(100_000), a), H('B', P(100_000), b)]
    const bad = distribute({ holdings: two(2_000, 0), proceeds: P(300_000), exitCosts: 0, years100: 100, carry: fixed(2_000, 800, 1_500) })
    expect(bad.ok).toBe(false)
    const r = d({ holdings: two(1_000, 0), carry: fixed(2_000, 800, 1_500) })
    expect(r.perInvestor!.map((x) => [x.hurdlePaid, x.catchUpToLead, x.carry, x.distribution])).toEqual([
      [P(8_000), P(2_400), P(5_000), P(145_000)],
      [P(8_000), 0, 0, P(150_000)],
    ])
    const same = d({ holdings: two(1_000, 1_000), carry: fixed(2_000, 800, 1_500) })
    expect([same.perInvestor, same.carry]).toEqual([null, P(10_000)])
  })

  it('TC-J-39 carry payees by largest remainder, ties to the earlier payee', () => {
    const r = d({ holdings: three, payees: [{ name: 'P1', shareBps: 5_000 }, { name: 'P2', shareBps: 3_000 }, { name: 'P3', shareBps: 2_000 }] })
    expect(r.payees.map((x) => x.amount)).toEqual([P(6_250), P(3_750), P(2_500)])
    const penny = distribute({ holdings: [H('A', P(1))], proceeds: P(1) + 5, exitCosts: 0, years100: 0, carry: fixed(2_000), payees: [{ name: 'X', shareBps: 5_000 }, { name: 'Y', shareBps: 5_000 }] })
    expect(penny.ok && penny.result.payees.map((x) => x.amount)).toEqual([1, 0])
    for (const payees of [[{ name: 'X', shareBps: 9_900 }], [{ name: 'X', shareBps: 10_000 }, { name: 'Y', shareBps: 0 }], Array.from({ length: 21 }, (_, i) => ({ name: `P${i}`, shareBps: i === 0 ? 8_000 : 100 }))])
      expect(distribute({ holdings: three, proceeds: P(300_000), exitCosts: 0, years100: 0, carry: fixed(2_000), payees }).ok).toBe(false)
  })

  it('TC-J-40 proceeds are split by capital with largest remainder before each waterfall', () => {
    const split = (D: number, caps: number[]) => d({ proceeds: D, holdings: caps.map((cap, i) => H(`I${i}`, cap, [0, 500, 1_000][i])) }).perInvestor!.map((x) => x.share)
    expect(split(3, [100, 100, 100])).toEqual([1, 1, 1])
    expect(split(2, [100, 100, 100])).toEqual([1, 1, 0])
    expect(split(2, [100, 200, 300])).toEqual([0, 1, 1])
  })

  it('TC-J-62 exports: carry column and payees CSV', () => {
    const r = d({ holdings: three, payees: [{ name: 'Payee 1', shareBps: 7_000 }, { name: 'Payee 2', shareBps: 3_000 }] })
    const lines = distributionCsv(r, null, 'GBP').split(/\r?\n/)
    expect(lines[0].endsWith(',carry,currency')).toBe(true)
    expect(lines.slice(1).map((l) => l.split(',').slice(-2)[0])).toEqual(['20.00', '0.00', '10.00'])
    expect(payeesCsv(r, 'GBP').split(/\r?\n/).slice(1)).toEqual(['Payee 1,70.00,8750.00,GBP', 'Payee 2,30.00,3750.00,GBP'])
    const plain = d({ holdings: [H('A', P(100_000)), H('B', P(100_000))] })
    expect(payeesCsv(plain, 'GBP').split(/\r?\n/)[1]).toBe(`Lead,100.00,${(plain.carry / 100).toFixed(2)},GBP`)
    expect(distributionCsv(plain, null, 'GBP').split(/\r?\n/)[1].split(',').slice(-2)[0]).toBe('')
  })
})

describe('decision J — CSV (§5.5)', () => {
  it('TC-J-24 refund_only values', () => {
    const csv = (v: string) => importCommitments(`name,reference,cash_due,refund_only\nA,NW-001,10,${v}\n`, 'GBP')
    const read = (v: string) => {
      const r = csv(v)
      return r.ok ? r.rows[0].refundOnly : null
    }
    expect([read('yes'), read(' Closed '), read('WITHDRAWN')]).toEqual(['closed', 'closed', 'withdrawn'])
    const bad = csv('maybe')
    expect(bad.ok ? [] : bad.errors.map((e) => e.where)).toEqual(['row 2, refund_only'])
  })

  it('TC-J-29 own terms columns and their combination errors', () => {
    const ok = importCommitments('name,reference,cash_due,Own fee mode,own fee rate\nA,NW-001,10,on top,4%\n', 'GBP')
    expect(ok.ok && ok.rows[0].ownTerms).toEqual({ mode: 'onTop', fee: { kind: 'percent', bps: 400 } })
    const bad = importCommitments('name,reference,cash_due,own_fee_mode,own_fee_rate,own_fee_fixed\nA,NW-001,10,deducted,4,250\nB,NW-002,10,,4,\n', 'GBP')
    expect(bad.ok ? [] : bad.errors.map((e) => e.where)).toEqual(['row 2, own_fee_rate', 'row 3, own_fee_mode'])
  })

  it('TC-J-30 own terms round-trip through the allocation export; no new inputs leave the new columns empty', () => {
    const r = alloc({ investors: [inv('X', P(10_400), { ownTerms: { mode: 'onTop', fee: { kind: 'percent', bps: 400 } }, carryBps: 2_000 }), inv('Y', P(500))] })
    const back = importInvestors(allocationCsv(r, 'GBP'), 'GBP')
    expect(back.ok && back.rows.map((x) => [x.ownTerms ?? null, x.carryBps ?? null])).toEqual([[{ mode: 'onTop', fee: { kind: 'percent', bps: 400 } }, 2_000], [null, null]])
    const plain = alloc({ investors: [inv('Y', P(500))] })
    expect(allocationCsv(plain, 'GBP').split(/\r?\n/)[1].endsWith(',allocated,,,,,,,GBP')).toBe(true)
    expect(holdingsCsv([{ id: 'a', name: 'A', capital: 1 }], null, 'GBP').split(/\r?\n/)[1]).toBe('a,A,0.01,—,,,GBP')
  })

  it('TC-J-31 a deal fee named "rate" never becomes an own fee on re-import', () => {
    const r = alloc({ fees: [{ ...threePct, label: 'rate' }], investors: [inv('Y', P(1_000))] })
    const csv = allocationCsv(r, 'GBP')
    expect(csv.split(/\r?\n/)[0].split(',')).toContain('fee_rate')
    const back = importInvestors(csv, 'GBP')
    expect(back.ok && [back.rows[0].ownTerms, back.ignoredColumns.includes('fee_rate')]).toEqual([undefined, true])
  })

  it('TC-J-54 holdings carry column', () => {
    const h = importHoldings('name,capital,carry\nA,10,20\nB,10,\nC,10,10%\n', 'GBP')
    expect(h.ok && h.rows.map((x) => x.carryBps ?? null)).toEqual([2_000, null, 1_000])
    const bad = importHoldings('name,capital,carry\nA,10,abc\n', 'GBP')
    expect(bad.ok ? [] : bad.errors.map((e) => e.where)).toEqual(['row 2, carry'])
  })

  it('TC-J-52 names up to 256 characters in the investor list', () => {
    expect(importCommitments(`name,reference,cash_due\n${'n'.repeat(256)},NW-001,10\n`, 'GBP').ok).toBe(true)
    expect(importCommitments(`name,reference,cash_due\n${'n'.repeat(257)},NW-001,10\n`, 'GBP').ok).toBe(false)
  })
})
