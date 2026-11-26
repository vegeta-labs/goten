// Decision J at the state layer (Test Plan §2.6): locks, voids, staleness, hand-off requests, saved data, events.
import { describe, expect, it } from 'vitest'
import {
  allocationStale,
  feePayerChangeBlock,
  initialState,
  investorImportLoss,
  importLossText,
  amountsEntered,
  OWN_TERMS_BLOCK_TEXT,
  parseSaved,
  reducer,
  commitmentRow,
  type Action,
  type AppState,
} from './state'
import { deriveAllocation, deriveDistribution, deriveHoldings, deriveReconcile } from './derive'
import { importHoldings } from './lib/csv'
import { distributionCsv, holdingsCsv, noSharesFor } from './lib/exports'
import { decide, handoffToAllocation, reconcile } from './lib/reconcile'
import { activeChange } from './lib/adjust'
import { allocate } from './lib/allocation'
import { distribute } from './lib/waterfall'
import { holdingsFromAllocation } from './lib/snapshot'
import { buildResult, hashProjection, parseRequest } from './lib/handoff'
import { readFileSync } from 'node:fs'
import { sampleLosesNothing } from './tour/script'

const run = (s: AppState, ...actions: Action[]) => actions.reduce(reducer, s)
const fresh = () => initialState(new Date('2026-10-20T12:00:00Z'))
const events = (s: AppState) => s.log.entries.map((e) => e.event)

function rec(s: AppState) {
  const d = deriveReconcile(s)
  if (!d.input) throw new Error(JSON.stringify(d.errors))
  const o = reconcile(d.input)
  if (!o.ok) throw new Error('reconcile failed')
  return o.result
}
function decideOn(s: AppState, txn: string, investorId: string | null): AppState {
  const r = rec(s)
  const l = r.lines.find((x) => x.line.txnId === txn)!
  const who = investorId ? r.commitments.find((c) => c.commitment.id === investorId)!.commitment : null
  return reducer(s, { type: 'decide', lineId: l.line.id, decision: decide(l.line, who), via: 'candidate', prevStatus: l.status })
}
function reviewed(): AppState {
  let s = run(fresh(), { type: 'loadSample' })
  for (const [t, who] of [['t03', 'c03'], ['t05', 'c05'], ['t12', 'c11'], ['t11', null], ['t14', null]] as const) s = decideOn(s, t, who)
  return s
}
function handoff(s: AppState): AppState {
  const h = handoffToAllocation(rec(s))
  if (!h.ok) throw new Error(h.reason)
  return reducer(s, { type: 'handoff', handoff: h.value })
}
const at = (s: AppState, id: string) => s.commitments.findIndex((c) => c.id === id)
const edit = (s: AppState, id: string, field: 'ownFeeMode' | 'ownFeeRate' | 'carry' | 'refunded' | 'refundOnly', value: string): Action => ({
  type: 'editCommitment',
  index: at(s, id),
  rowId: id,
  field,
  value,
})
/** TC-ALL-36: the sample reviewed and handed off, minimum £970, the 3% platform fee item moved to the company with consent. */
function applied(before: (s: AppState) => AppState = (s) => s): AppState {
  let s = before(reviewed())
  s = run(s, { type: 'setDeal', patch: { minimum: '970' } })
  s = handoff(s)
  return run(s, { type: 'applyFeePayerChange', feeId: 'f1', to: 'company', consent: true })
}

describe('decision J — fee payer change and own terms (C-ALL-10, R-ALL-12.1)', () => {
  it('TC-J-16 own fee terms in scope disable the panel; carry alone, or terms on someone out of scope, do not', () => {
    const own = handoff(run(reviewed(), edit(reviewed(), 'c01', 'ownFeeMode', 'on_top')))
    expect(feePayerChangeBlock(own)).toBe(OWN_TERMS_BLOCK_TEXT)
    const carry = handoff(run(reviewed(), edit(reviewed(), 'c01', 'carry', '20')))
    expect(feePayerChangeBlock(carry)).toBeNull()
    let out = run(reviewed(), edit(reviewed(), 'c12', 'ownFeeMode', 'on_top'))
    out = handoff(run(out, edit(out, 'c12', 'refundOnly', 'closed')))
    expect(feePayerChangeBlock(out)).toBeNull()
  })

  it('TC-J-18 while a change is active, own fee terms of a covered person are locked; carry is not', () => {
    const s = applied()
    expect(activeChange(s.feePayerChanges)).toBeDefined()
    expect(run(s, edit(s, 'c01', 'ownFeeMode', 'on_top'))).toBe(s)
    const c = run(s, edit(s, 'c01', 'carry', '20'))
    expect([c.commitments[at(c, 'c01')].carry, activeChange(c.feePayerChanges)?.status]).toEqual(['20', 'active'])
  })

  it('TC-J-19 a replace import that brings own fee terms voids the whole change and is announced first', () => {
    const s = applied()
    const rows = s.commitments.map((c) => (c.id === 'c01' ? { ...c, ownFeeMode: 'on_top' } : c))
    const loss = investorImportLoss(s, rows)
    expect([loss.changes, importLossText(loss)]).toEqual([1, 'This import will void 1 fee payer change. This cannot be undone.'])
    const v = run(s, { type: 'replaceCommitments', rows })
    expect([activeChange(v.feePayerChanges), v.feePayerChanges.at(-1)!.voidReason]).toEqual([undefined, 'own fee terms added'])
    const carryOnly = run(s, { type: 'replaceCommitments', rows: s.commitments.map((c) => (c.id === 'c01' ? { ...c, carry: '20' } : c)) })
    expect(activeChange(carryOnly.feePayerChanges)?.status).toBe('active')
  })

  it('TC-J-28 refund-only and coverage: outside the scope no flag; a covered person’s line is voided for good', () => {
    const s = applied()
    // (b) A covered: the flag voids the line, clearing it leaves A not covered
    const flagged = run(s, edit(s, 'c01', 'refundOnly', 'closed'))
    expect(events(flagged)).toContain('adjustment_voided')
    expect(rec(flagged).notCovered).not.toContain('c01')
    const cleared = run(flagged, edit(flagged, 'c01', 'refundOnly', ''))
    expect(rec(cleared).notCovered).toContain('c01')
    // (a) a new person D outside the scope: not flagged while refund-only, flagged once cleared
    const withD = run(s, { type: 'addCommitment' })
    const d = withD.commitments.at(-1)!.id
    const named = run(
      withD,
      { type: 'editCommitment', index: withD.commitments.length - 1, rowId: d, field: 'name', value: 'Dana' },
      { type: 'editCommitment', index: withD.commitments.length - 1, rowId: d, field: 'reference', value: 'NW-099' },
      { type: 'editCommitment', index: withD.commitments.length - 1, rowId: d, field: 'cashDue', value: '100' },
      { type: 'editCommitment', index: withD.commitments.length - 1, rowId: d, field: 'refundOnly', value: 'closed' },
    )
    expect(rec(named).notCovered).not.toContain(d)
    expect(rec(run(named, { type: 'editCommitment', index: named.commitments.length - 1, rowId: d, field: 'refundOnly', value: '' })).notCovered).toContain(d)
  })

  it('TC-J-53 the platform fee payer note and an unchanged cash due', () => {
    let s = handoff(reviewed())
    s = run(s, { type: 'setAllocation', patch: { platformFee: { rate: '2.5', minimum: '0', maximum: '', threshold: '', addOnRate: '', payer: 'investors' } } })
    const due = rec(s).commitments.map((c) => c.due)
    const t = run(s, { type: 'setAllocation', patch: { platformFee: { ...s.allocation.platformFee!, payer: 'company' } } })
    expect(rec(t).commitments.map((c) => c.due)).toEqual(due)
    expect(t.log.entries.at(-1)).toMatchObject({ event: 'platform_fee_payer_changed', detail: 'investors → company' })
  })
})

describe('decision J — reconciliation data (R-REC-04.4, R-X-07)', () => {
  it('TC-J-26 new fields never void decisions; they make the allocation out of date; a typo only blocks figures', () => {
    const s = handoff(reviewed())
    const confirmed = Object.keys(s.decisions).length
    let t = run(s, edit(s, 'c03', 'refunded', '100'))
    expect([Object.values(t.decisions).filter((d) => d.lineFp !== 'void').length, allocationStale(t)]).toEqual([confirmed, true])
    t = run(t, edit(t, 'c03', 'refundOnly', 'closed'), edit(t, 'c03', 'ownFeeMode', 'deducted'), edit(t, 'c03', 'refunded', 'abc'))
    expect(deriveReconcile(t).input).toBeNull()
    t = run(t, edit(t, 'c03', 'refunded', '100'))
    expect([deriveReconcile(t).input !== null, Object.values(t.decisions).filter((d) => d.lineFp !== 'void').length]).toEqual([true, confirmed])
  })
})

describe('decision J — saved data and exit (schema 3, C-DIS-8)', () => {
  it('TC-J-48 a schema 2 save loads with the same results; a schema 3 save missing a field is refused', () => {
    const s = handoff(reviewed())
    const v2 = JSON.parse(JSON.stringify(s))
    v2.schema = 2
    for (const c of v2.commitments) for (const k of ['ownFeeMode', 'ownFeeRate', 'ownFeeFixed', 'carry', 'refunded', 'refundOnly']) delete c[k]
    for (const c of v2.allocation.investors) for (const k of ['ownFeeMode', 'ownFeeRate', 'ownFeeFixed', 'carry']) delete c[k]
    for (const k of ['instrument', 'platformFee', 'handoffRequest', 'editedSinceRequest']) delete v2.allocation[k]
    for (const h of v2.exit.holdings) delete h.carry
    delete v2.exit.payees
    const back = parseSaved(JSON.stringify(v2))!
    expect(back.schema).toBe(3)
    expect(allocate(deriveAllocation(back).input!)).toEqual(allocate(deriveAllocation(s).input!))
    const broken = JSON.parse(JSON.stringify(s))
    delete broken.allocation.platformFee
    expect(parseSaved(JSON.stringify(broken))).toBeNull()
  })

  it('TC-J-49 personal carry survives switching to tiered and back', () => {
    let s = run(fresh(), { type: 'replaceHoldings', rows: [{ id: 'a', name: 'A', capital: '100', carry: '10' }], sharePriceMicros: null })
    s = run(s, { type: 'setExit', patch: { carry: '20' } }, { type: 'setCarryMode', mode: 'tiered' }, { type: 'setCarryMode', mode: 'fixed' })
    expect([s.exit.holdings[0].carry, s.exit.carry]).toEqual(['10', ''])
  })
})

describe('decision J — allocation hand-off request in the app (R-ALL-14)', () => {
  const vectors = JSON.parse(readFileSync('docs/formats/allocation-handoff-v1.vectors.json', 'utf8')).vectors as { kind: string; request_text: string; expected_result: unknown }[]
  const result = vectors.find((v) => v.kind === 'result')!
  async function imported(s: AppState, text = result.request_text): Promise<AppState> {
    const hash = await hashProjection(JSON.parse(text).projection)
    const p = parseRequest(text, { currency: s.deal.currency, currencyLocked: false, hash })
    if (!p.ok) throw new Error(p.errors.join('; '))
    const x = p.value.input
    const plain = (n: number) => (n / 100).toFixed(2)
    return reducer(s, {
      type: 'importHandoffRequest',
      text,
      hash,
      handoffId: p.value.handoffId,
      participants: p.value.participants.length,
      rows: x.investors.map((v) => ({ id: v.id, name: v.name, received: plain(v.received), scheme: v.scheme, ownFeeMode: v.ownTerms!.mode === 'onTop' ? 'on_top' : 'deducted', ownFeeRate: v.ownTerms!.fee?.kind === 'percent' ? (v.ownTerms!.fee.bps / 100).toFixed(2) : '', ownFeeFixed: v.ownTerms!.fee?.kind === 'fixed' ? plain(v.ownTerms!.fee.amount) : '', carry: v.carryBps === null || v.carryBps === undefined ? '' : (v.carryBps / 100).toFixed(2) })),
      minimum: x.minimum ? plain(x.minimum) : '',
      allocation: {
        price: x.priceMicros === null ? '' : String(x.priceMicros / 1_000_000),
        cap: x.cap === null ? '' : plain(x.cap),
        instrument: x.instrument ?? 'equity',
        platformFee: x.platformFee ? { rate: (x.platformFee.rateBps / 100).toFixed(2), minimum: plain(x.platformFee.minimum), maximum: '', threshold: '', addOnRate: '', payer: x.platformFee.payer } : null,
        fees: [],
      },
    })
  }
  async function exported(s: AppState): Promise<unknown> {
    const req = s.allocation.handoffRequest!
    const p = parseRequest(req.text, { currency: s.deal.currency, currencyLocked: false, hash: req.hash })
    if (!p.ok) throw new Error(p.errors.join('; '))
    const a = allocate(deriveAllocation(s).input!)
    if (!a.ok) throw new Error('allocation failed')
    return JSON.parse(buildResult(p.value, a.result))
  }

  it('TC-J-46 edits block the result; reconciliation does not; a reload keeps both states', async () => {
    let s = await imported(reviewed())
    expect(await exported(s)).toEqual(result.expected_result)
    s = run(s, edit(s, 'c01', 'refunded', '1'))
    expect([allocationStale(s), s.allocation.editedSinceRequest]).toEqual([false, false])
    s = parseSaved(JSON.stringify(s))!
    expect(await exported(s)).toEqual(result.expected_result)
    s = run(s, { type: 'setAllocation', patch: { cap: '1' } }, { type: 'setAllocation', patch: { cap: '' } })
    expect(s.allocation.editedSinceRequest).toBe(true)
    expect(parseSaved(JSON.stringify(s))!.allocation.editedSinceRequest).toBe(true)
    s = await imported(s)
    expect(s.allocation.editedSinceRequest).toBe(false)
    s = run(s, { type: 'setDeal', patch: { currency: 'EUR' } })
    expect(s.allocation.editedSinceRequest).toBe(true)
  })

  it('TC-J-47 log events for the request, the result and the platform fee payer', async () => {
    let s = await imported(reviewed())
    s = run(s, { type: 'handoffResultExported', handoffId: 'ho_1', hash: s.allocation.handoffRequest!.hash })
    s = run(s, { type: 'setAllocation', patch: { platformFee: { ...s.allocation.platformFee!, payer: 'company' } } })
    const last = s.log.entries.slice(-3)
    expect(last.map((e) => e.event)).toEqual(['handoff_request_imported', 'handoff_result_exported', 'platform_fee_payer_changed'])
    const hex12 = s.allocation.handoffRequest!.hash.slice(7, 19)
    expect([last[0].detail.includes(hex12), last[1].detail.includes(hex12), last[2].detail]).toEqual([true, true, 'investors → company'])
  })

  it('TC-J-51 carry from a request reaches the holdings and the per-investor exit', async () => {
    const text = JSON.parse(result.request_text)
    text.projection.participants[0].terms.carry_bps = '2000'
    text.projection.participants[1].terms.carry_bps = '0'
    text.projection_hash = await hashProjection(text.projection)
    const s = await imported(reviewed(), JSON.stringify(text))
    const a = allocate(deriveAllocation(s).input!)
    if (!a.ok) throw new Error('allocation failed')
    const snap = holdingsFromAllocation(a.result, deriveAllocation(s).input!.priceMicros, s.allocVersion)
    let e = run(s, { type: 'handoffToExit', holdings: snap.data.rows, sharePriceMicros: snap.data.sharePriceMicros })
    expect(e.exit.holdings.map((h) => h.carry)).toEqual(['20.00', '0.00'])
    const capital = snap.data.rows.reduce((x, h) => x + h.capital, 0)
    e = run(e, { type: 'setExit', patch: { proceeds: ((2 * capital) / 100).toFixed(2), carry: '20' } })
    const w = distribute(deriveDistribution(e).input!)
    expect(w.ok && [w.result.perInvestor !== null, w.result.rows[1].carry]).toEqual([true, 0])
  })

  it('TC-J-52 a 256-character name survives the trip to exit, export and reload', () => {
    const name = 'n'.repeat(256)
    let s = run(reviewed(), { type: 'replaceCommitments', rows: reviewed().commitments.map((c) => (c.id === 'c01' ? { ...c, name } : c)) })
    s = handoff(s)
    const a = allocate(deriveAllocation(s).input!)
    expect(a.ok).toBe(true)
    expect(parseSaved(JSON.stringify(s))!.commitments[0].name).toBe(name)
    expect(commitmentRow(rec(s).commitments[0].commitment).name).toBe(name)
  })
})

describe('decision J — M7 review fixes', () => {
  it('TC-J-46 (review #1) importing a request while a fee payer change is active voids the change (its fee is gone)', async () => {
    const s = applied()
    const v = JSON.parse(readFileSync('docs/formats/allocation-handoff-v1.vectors.json', 'utf8')).vectors.find((x: { kind: string }) => x.kind === 'result')
    const text: string = v.request_text
    const hash = await hashProjection(JSON.parse(text).projection)
    const p = parseRequest(text, { currency: s.deal.currency, currencyLocked: true, hash })
    if (!p.ok) throw new Error(p.errors.join('; '))
    const t = run(s, { type: 'importHandoffRequest', text, hash, handoffId: p.value.handoffId, participants: 2, rows: [], minimum: '', allocation: { price: '1', cap: '', instrument: 'equity', platformFee: null, fees: [] } })
    expect([activeChange(t.feePayerChanges), t.feePayerChanges.at(-1)!.voidReason]).toEqual([undefined, 'fee deleted'])
    expect(events(t)).toContain('fee_payer_change_voided')
  })

  it('TC-J-44 (review #2) a request that breaks a Goten input rule is refused whole', async () => {
    const v = JSON.parse(readFileSync('docs/formats/allocation-handoff-v1.vectors.json', 'utf8')).vectors.find((x: { name: string }) => x.name === 'accept_base_request')
    const r = JSON.parse(v.request_text)
    r.bookkeeping.participants[0].name = '   '
    const text = JSON.stringify(r)
    const p = parseRequest(text, { currency: 'GBP', currencyLocked: false, hash: await hashProjection(r.projection) })
    expect(p.ok).toBe(false)
  })
})

describe('decision J — Codex M7 round 1 fixes', () => {
  it('TC-J-46 (Codex #1) reversing a fee payer change after a request import blocks the result export', async () => {
    const s = applied()
    const base = JSON.parse(JSON.parse(readFileSync('docs/formats/allocation-handoff-v1.vectors.json', 'utf8')).vectors.find((x: { kind: string }) => x.kind === 'result').request_text)
    base.projection.deal_fees = [{ id: 'f1', label: 'Platform fee', payer: 'company', kind: 'percent', value: '300' }]
    const text = JSON.stringify({ ...base, projection_hash: await hashProjection(base.projection) })
    const hash = await hashProjection(base.projection)
    const p = parseRequest(text, { currency: 'GBP', currencyLocked: true, hash })
    if (!p.ok) throw new Error(p.errors.join('; '))
    let t = run(s, { type: 'importHandoffRequest', text, hash, handoffId: p.value.handoffId, participants: 2, rows: [], minimum: '', allocation: { price: '1', cap: '', instrument: 'equity', platformFee: null, fees: [{ id: 'f1', label: 'Platform fee', payer: 'company', kind: 'percent', value: '3.00' }] } })
    expect([activeChange(t.feePayerChanges)?.status, t.allocation.editedSinceRequest]).toEqual(['active', false])
    t = run(t, { type: 'reverseFeePayerChange', changeId: activeChange(t.feePayerChanges)!.id })
    expect(t.allocation.editedSinceRequest).toBe(true)
  })

  it('TC-J-19 (Codex #3) own fee terms on a person whose line is voided in the same import still void the whole change', () => {
    const s = applied()
    const rows = s.commitments.map((c) => (c.id === 'c01' ? { ...c, cashDue: '20000', ownFeeMode: 'on_top', ownFeeRate: '4' } : c))
    const t = run(s, { type: 'replaceCommitments', rows })
    expect(activeChange(t.feePayerChanges)).toBeUndefined()
    expect(investorImportLoss(s, rows).changes).toBe(1)
  })

  it('TC-J-48 (Codex #5) a saved request that does not read back makes the save invalid', () => {
    const s = JSON.parse(JSON.stringify(handoff(reviewed())))
    s.allocation.handoffRequest = { text: 'not JSON', hash: 'sha256:bad' }
    expect(parseSaved(JSON.stringify(s))).toBeNull()
  })

  it('TC-J-54 (Codex #2) the holdings export keeps personal carry, an explicit 0% included', () => {
    let s = run(fresh(), { type: 'replaceHoldings', rows: [{ id: 'a', name: 'A', capital: '100', carry: '0' }, { id: 'b', name: 'B', capital: '100', carry: '' }, { id: 'c', name: 'C', capital: '100', carry: '20' }], sharePriceMicros: null })
    s = run(s, { type: 'setExit', patch: { carry: '20' } })
    const h = deriveHoldings(s).input!
    const back = importHoldings(holdingsCsv(h, null, 'GBP'), 'GBP')
    expect(back.ok && back.rows.map((x) => x.carryBps ?? null)).toEqual([0, null, 2_000])
  })
})

describe('decision J — Codex M7 round 2 fixes', () => {
  it('TC-J-18 (Codex r2 #1) the allocation table cannot change own fee terms of a covered person either', () => {
    const s = applied()
    const i = s.allocation.investors.findIndex((v) => v.id === 'c01')
    expect(run(s, { type: 'editInvestor', index: i, rowId: 'c01', field: 'ownFeeMode', value: 'on_top' })).toBe(s)
  })

  it('TC-J-53 (Codex r2 #3, #4; r3 #5) each new allocation setting counts as data to lose; platform money counts as money to relabel', () => {
    // the page as it opens today loses nothing, so each change below is what makes the difference
    const base = initialState()
    expect(sampleLosesNothing(base)).toBe(true)
    const pf = { rate: '2.5', minimum: '4000', maximum: '', threshold: '', addOnRate: '', payer: 'investors' as const }
    expect(sampleLosesNothing(run(base, { type: 'setAllocation', patch: { instrument: 'convertible' } }))).toBe(false)
    expect(sampleLosesNothing(run(base, { type: 'setAllocation', patch: { platformFee: pf } }))).toBe(false)
    expect(sampleLosesNothing({ ...base, allocation: { ...base.allocation, handoffRequest: { text: '{}', hash: 'sha256:x' } } })).toBe(false)
    expect(amountsEntered(run(base, { type: 'setAllocation', patch: { platformFee: pf } }))).toBeGreaterThan(0)
  })

  it('TC-J-15 (Codex r2 #7, r3 #6) a convertible handed to exit leaves share cells blank in the holdings and distribution exports', () => {
    const h = [{ id: 'a', name: 'A', capital: 100_000 }]
    expect(holdingsCsv(h, null, 'GBP', true).split(/\r?\n/)[1]).toBe('a,A,1000.00,,,,GBP')
    expect(holdingsCsv(h, null, 'GBP').split(/\r?\n/)[1]).toBe('a,A,1000.00,—,,,GBP')
    // the instrument goes through the exit hand-off, and the page's choice of blank cells follows it
    let s = run(fresh(), { type: 'handoffToExit', holdings: h, sharePriceMicros: null, instrument: 'convertible' })
    expect(noSharesFor(s.exit.instrument)).toBe(true)
    expect(noSharesFor(run(s, { type: 'replaceHoldings', rows: s.exit.holdings, sharePriceMicros: null }).exit.instrument)).toBe(false)
    s = run(s, { type: 'setExit', patch: { proceeds: '2000', years: '1', carry: '20' } })
    const d = deriveDistribution(s)
    if (!d.input) throw new Error(JSON.stringify(d.errors))
    const r = distribute(d.input)
    if (!r.ok) throw new Error('distribution failed')
    const lines = distributionCsv(r.result, s.exit.sharePriceMicros, 'GBP', noSharesFor(s.exit.instrument)).split(/\r?\n/)
    const col = lines[0].split(',').indexOf('shares_display')
    expect(lines[1].split(',')[col]).toBe('')
    expect(distributionCsv(r.result, s.exit.sharePriceMicros, 'GBP').split(/\r?\n/)[1].split(',')[col]).toBe('—')
  })

  it('TC-J-18 (Codex r3 #2) a restored save with own fee terms on someone the active change covers voids the change', () => {
    const s = applied()
    expect(activeChange(s.feePayerChanges)).toBeDefined()
    const raw = JSON.parse(JSON.stringify(s))
    raw.commitments = raw.commitments.map((c: { id: string }) => (c.id === 'c01' ? { ...c, ownFeeMode: 'on_top', ownFeeRate: '4' } : c))
    const back = parseSaved(JSON.stringify(raw))!
    expect(activeChange(back.feePayerChanges)).toBeUndefined()
    expect(back.feePayerChanges.at(-1)!.status).toBe('voided')
    expect(back.recVersion).toBeGreaterThan(s.recVersion)
    // untouched, the same save keeps the change
    expect(activeChange(parseSaved(JSON.stringify(s))!.feePayerChanges)).toBeDefined()
  })

  it('TC-J-52 (Codex r2 #9) a 256-character name goes to exit, through the holdings export and back, and survives a reload', () => {
    const name = 'n'.repeat(256)
    let s = run(reviewed(), { type: 'replaceCommitments', rows: reviewed().commitments.map((c) => (c.id === 'c01' ? { ...c, name } : c)) })
    s = handoff(s)
    const a = allocate(deriveAllocation(s).input!)
    if (!a.ok) throw new Error('allocation failed')
    const snap = holdingsFromAllocation(a.result, deriveAllocation(s).input!.priceMicros, s.allocVersion)
    s = run(s, { type: 'handoffToExit', holdings: snap.data.rows, sharePriceMicros: snap.data.sharePriceMicros })
    const h = deriveHoldings(s)
    expect(h.errors).toEqual([])
    const back = importHoldings(holdingsCsv(h.input!, s.exit.sharePriceMicros, 'GBP'), 'GBP')
    expect(back.ok && back.rows[0].name).toBe(name)
    expect(parseSaved(JSON.stringify(s))!.exit.holdings[0].name).toBe(name)
  })
})
