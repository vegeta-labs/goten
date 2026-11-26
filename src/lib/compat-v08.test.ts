// TC-J-01: with none of the v0.9 inputs, the engines give exactly the v0.8.13 results, field by field.
// The v0.8.13 engines are kept unchanged in ./legacy (test-only). Seeded random inputs, so failures repeat.
import { describe, expect, it } from 'vitest'
import { allocate, type AllocationInput, type Fee } from './allocation'
import { allocate as allocateV08 } from './legacy/allocation.v08'
import { distribute, type WaterfallInput } from './waterfall'
import { distribute as distributeV08 } from './legacy/waterfall.v08'
import { reconcile, type ReconcileInput } from './reconcile'
import { reconcile as reconcileV08 } from './legacy/reconcile.v08'

function rng(seed: number) {
  let x = seed >>> 0
  return (n: number) => {
    x = (Math.imul(x ^ (x >>> 15), 0x2c1b3c6d) + 0x9e3779b9) >>> 0
    x = (x ^ (x >>> 13)) >>> 0
    return x % n
  }
}

/** The fields v0.8.13 returned, from a v0.9 result (new fields dropped). */
function v08Allocation(r: Record<string, unknown>) {
  const rows = (r.rows as Record<string, unknown>[]).map(({ ownTerms: _a, carryBps: _b, ownFee: _c, preFeeInvested: _d, platformShare: _e, ...x }) => x)
  const { platformFee: _p, ...totals } = r.totals as Record<string, unknown>
  const { blockerIds: _i, ...rest } = r
  return { ...rest, rows, totals }
}
function v08Waterfall(r: Record<string, unknown>) {
  const { payees: _p, perInvestor: _q, tieredNote: _t, ...rest } = r
  return rest
}
function v08Reconcile(r: Record<string, unknown>) {
  const commitments = (r.commitments as Record<string, unknown>[]).map(({ refundOnly: _f, ...x }) => x)
  return { ...r, commitments }
}

describe('TC-J-01 v0.8.13 results unchanged without new inputs', () => {
  it('TC-J-01 allocation: 1,000 random deals without own terms, platform fee or another instrument', () => {
    const r = rng(20261125)
    for (let n = 0; n < 1_000; n++) {
      const fees: Fee[] = Array.from({ length: r(4) }, (_, i) => {
        const payer = (['investors', 'company', 'lead'] as const)[r(3)]
        const kind = payer === 'investors' ? (r(2) ? 'percent' : 'perInvestor') : r(2) ? 'percent' : 'fixed'
        return { id: `f${i}`, label: `Fee ${i}`, payer, kind, value: kind === 'percent' ? r(1_500) : 1 + r(50_000) }
      })
      const input: AllocationInput = {
        feeBasis: r(2) ? 'deducted' : 'onTop',
        minimum: r(3) ? 0 : r(2_000_000),
        cap: r(3) ? null : 1 + r(20_000_000),
        priceMicros: 1 + r(5_000_000),
        fees,
        investors: Array.from({ length: 1 + r(8) }, (_, i) => ({ id: `i${i}`, name: `I${i}`, received: r(10) ? r(5_000_000) : 0, scheme: (['none', 'SEIS', 'EIS'] as const)[r(3)] })),
      }
      const now = allocate(input)
      const then = allocateV08(input as Parameters<typeof allocateV08>[0])
      expect(now.ok, `deal ${n}`).toBe(then.ok)
      if (now.ok && then.ok) {
        expect(v08Allocation(now.result as unknown as Record<string, unknown>), `deal ${n}`).toEqual(then.result)
        // same checks with the same outcome; v0.9 adds the platform-fee checks and rewords the cash-balance label
        const outcome = (cs: { id: string; kind: string; pass: boolean }[]) => cs.filter((c) => !c.id.startsWith('platform-')).map((c) => [c.id, c.kind, c.pass])
        expect(outcome(now.checks), `deal ${n}`).toEqual(outcome(then.checks))
      }
    }
  })

  it('TC-J-01 exit: 1,000 random exits without personal carry or payees', () => {
    const r = rng(7)
    for (let n = 0; n < 1_000; n++) {
      const tiered = r(3) === 0
      const k = r(3_000)
      const h = r(2) ? r(1_500) : 0
      const input: WaterfallInput = {
        holdings: Array.from({ length: 1 + r(6) }, (_, i) => ({ id: `h${i}`, name: `H${i}`, capital: 1 + r(5_000_000) })),
        proceeds: r(60_000_000),
        exitCosts: r(4) ? 0 : r(1_000_000),
        years100: r(1_000),
        carry: tiered
          ? { mode: 'tiered', tiers: [{ upTo100: 150n + BigInt(r(200)), rate: r(2_500) }, { upTo100: null, rate: r(4_000) }] }
          : { mode: 'fixed', k, h, c: h > 0 && r(2) ? k + 1 + r(10_000 - k) : 0 },
      }
      const now = distribute(input)
      const then = distributeV08(input as Parameters<typeof distributeV08>[0])
      expect(now.ok, `exit ${n}`).toBe(then.ok)
      if (now.ok && then.ok) {
        expect(v08Waterfall(now.result as unknown as Record<string, unknown>), `exit ${n}`).toEqual(then.result)
        expect(now.result.payees, `exit ${n}`).toEqual([{ name: 'Lead', shareBps: 10_000, amount: now.result.carry }])
      }
    }
  })

  it('TC-J-01 reconciliation: 1,000 random statements without refunded or refund-only', () => {
    const r = rng(42)
    for (let n = 0; n < 1_000; n++) {
      const people = Array.from({ length: 1 + r(6) }, (_, i) => ({
        id: `c${i}`,
        name: ['Ann Lee', 'Bo Kim', 'Cy Diaz', 'Di Roy', 'Ed Fox', 'Flo Ng'][i],
        email: '',
        reference: `NW-${100 + i}`,
        cashDue: 1 + r(2_000_000),
        scheme: 'none' as const,
      }))
      const input: ReconcileInput = {
        commitments: people,
        lines: Array.from({ length: r(10) }, (_, i) => {
          const who = people[r(people.length)]
          return {
            id: `l${i}`,
            txnId: r(4) ? `T${i}` : null,
            date: `2026-10-${String(1 + r(25)).padStart(2, '0')}`,
            amount: r(8) ? (r(2) ? who.cashDue : 1 + r(2_000_000)) : -r(1_000),
            payer: r(2) ? who.name.toUpperCase() : 'SOMEONE',
            reference: [who.reference, who.reference.replace('-', ' '), `NW ${100 + r(9)}`, 'INV 4471'][r(4)],
          }
        }),
        decisions: {},
        asOf: '2026-10-20',
        thresholdDays: 10,
        withdrawn: r(4) ? {} : { c0: '2026-10-10' },
      }
      const now = reconcile(input)
      const then = reconcileV08(input as Parameters<typeof reconcileV08>[0])
      expect(now.ok, `statement ${n}`).toBe(then.ok)
      if (now.ok && then.ok) expect(v08Reconcile(now.result as unknown as Record<string, unknown>), `statement ${n}`).toEqual(then.result)
    }
  })
})
