// Export formats (Test Plan §6) and the closing confirmation (R-ALL-10).
import { formatMicroShares, formatMoney, formatPrice, plainMoney, type Currency } from './money'
import { toCsv } from './csv'
import { chaseMessage } from './messages'
import type { ReconcileResult } from './reconcile'
import type { AllocationResult, Instrument, OwnTerms } from './allocation'
import type { Holding, WaterfallResult } from './waterfall'

/** percent from bps, two decimals, as the importers read it back (I-02) */
const plainPct = (bps: number) => (bps / 100).toFixed(2)
const modeCell = (t: OwnTerms | null) => (t ? (t.mode === 'onTop' ? 'on_top' : 'deducted') : '')

/** Every export ends with the deal currency's ISO code on each row; column names stay fixed (Test Plan §6, v0.7.5). */
export function ledgerCsv(r: ReconcileResult, currency: Currency): string {
  const names = new Map(r.commitments.map((c) => [c.commitment.id, c.commitment.name]))
  // v0.8: the withdrawal date on every line booked to a withdrawn investor (PRD §5.5)
  const withdrawnOn = new Map(r.commitments.map((c) => [c.commitment.id, c.withdrawnOn]))
  return toCsv(
    ['transaction_id', 'date', 'amount', 'payer', 'reference', 'status', 'investor_id', 'investor_name', 'decided_by', 'withdrawn_on', 'currency'],
    r.lines.map((l) => [
      l.line.txnId ?? '',
      l.line.date,
      plainMoney(l.line.amount),
      l.line.payer,
      l.line.reference,
      l.status,
      l.assignedTo ?? '',
      l.assignedTo ? names.get(l.assignedTo) ?? '' : '',
      l.status === 'auto' ? 'auto' : l.status === 'confirmed' || l.status === 'rejected' ? 'person' : '',
      l.assignedTo ? (withdrawnOn.get(l.assignedTo) ?? '') : '',
      currency,
    ]),
    ['amount'],
  )
}

/**
 * Partial and outstanding only (TC-REC-27), so never a withdrawn investor. `committed` is the effective cash due; where a
 * fee payer change adjusts it, `committed_original` / `committed_adjustment` show the list value and the difference
 * (C-ALL-11). `message` is the chase text, made by the same function as "Copy message" (R-REC-10.1).
 */
export function chaseListCsv(r: ReconcileResult, currency: Currency, dealName: string): string {
  return toCsv(
    ['investor_id', 'name', 'email', 'committed', 'received', 'difference', 'status', 'committed_original', 'committed_adjustment', 'message', 'refunded', 'currency'],
    r.commitments
      .filter((c) => c.status === 'partial' || c.status === 'outstanding')
      .map((c) => [
        c.commitment.id,
        c.commitment.name,
        c.commitment.email,
        plainMoney(c.due),
        plainMoney(c.received),
        plainMoney(c.difference),
        c.status,
        c.due !== c.commitment.cashDue ? plainMoney(c.commitment.cashDue) : '',
        c.due !== c.commitment.cashDue ? plainMoney(c.due - c.commitment.cashDue) : '',
        chaseMessage(dealName, currency, c),
        c.commitment.refunded ? plainMoney(c.commitment.refunded) : '', // v0.9, before currency: `received` is net of this (C-REC-4)
        currency,
      ]),
    ['committed', 'received', 'difference', 'committed_original', 'committed_adjustment', 'refunded'],
  )
}

export function allocationCsv(r: AllocationResult, currency: Currency): string {
  const investorFees = r.feeTotals.filter((f) => f.payer === 'investors')
  return toCsv(
    [
      'investor_id',
      'name',
      'scheme',
      'received',
      'invested',
      'units',
      ...investorFees.map((f) => `fee_${f.label}`),
      'fees_total',
      'refund',
      'seis_eis_claimable_shares',
      'seis_eis_claimable_amount',
      'status',
      // v0.9 (§5.5): own terms round-trip into "Import investors"; empty without new inputs
      'own_fee_mode',
      'own_fee_rate',
      'own_fee_fixed',
      'own_fee',
      'carry',
      'platform_fee',
      'currency',
    ],
    r.rows.map((x) => [
      x.id,
      x.name,
      x.scheme,
      plainMoney(x.received),
      plainMoney(x.invested),
      x.microShares === null ? '' : formatMicroShares(x.microShares),
      ...investorFees.map((f) => plainMoney(x.fees[f.id] ?? 0)),
      plainMoney(x.feesTotal),
      plainMoney(x.refund),
      x.participating && x.scheme !== 'none' && x.claimableShares !== null ? x.claimableShares : '',
      x.participating && x.scheme !== 'none' && x.claimableAmount !== null ? plainMoney(x.claimableAmount) : '',
      x.participating ? (x.scaledBack ? 'scaled-back' : 'allocated') : x.exclusion ?? '',
      modeCell(x.ownTerms),
      x.ownTerms?.fee?.kind === 'percent' ? plainPct(x.ownTerms.fee.bps) : '',
      x.ownTerms?.fee?.kind === 'fixed' ? plainMoney(x.ownTerms.fee.amount) : '',
      x.ownFee === null ? '' : plainMoney(x.ownFee),
      x.carryBps === null ? '' : plainPct(x.carryBps),
      r.totals.platformFee?.payer === 'investors' ? plainMoney(x.platformShare) : '',
      currency,
    ]),
    ['received', 'invested', 'units', ...investorFees.map((f) => `fee_${f.label}`), 'fees_total', 'refund', 'seis_eis_claimable_shares', 'seis_eis_claimable_amount', 'own_fee_rate', 'own_fee_fixed', 'own_fee', 'carry', 'platform_fee'],
  )
}

/** C-ALL-5 v0.9: share cells are blank for a convertible or fund units; holdings imported or saved before v0.9 are equity. */
export const noSharesFor = (instrument: Instrument | undefined): boolean => (instrument ?? 'equity') !== 'equity'

export function distributionCsv(r: WaterfallResult, sharePriceMicros: number | null, currency: Currency, noShares = false): string {
  return toCsv(
    ['investor_id', 'name', 'capital', 'shares_display', 'distribution', 'profit', 'multiple_excl_entry_fees', 'carry', 'currency'],
    r.rows.map((x) => [
      x.id,
      x.name,
      plainMoney(x.capital),
      noShares ? '' : sharesDisplay(x.capital, sharePriceMicros), // C-ALL-5 v0.9: no shares for a convertible or fund units
      plainMoney(x.distribution),
      plainMoney(x.profit),
      (x.multiple100 / 100).toFixed(2),
      // v0.9 (§5.5): the rate used, only in fixed mode when some holding has a personal carry; otherwise empty
      x.carryBps === undefined ? '' : plainPct(x.carryBps),
      currency,
    ]),
    ['capital', 'shares_display', 'distribution', 'profit', 'multiple_excl_entry_fees', 'carry'],
  )
}

/** C-DIS-9 / §5.5 v0.9: who receives the carry. Without a payee list, one row "Lead". */
export function payeesCsv(r: WaterfallResult, currency: Currency): string {
  return toCsv(
    ['payee', 'share', 'amount', 'currency'],
    r.payees.map((p) => [p.name, plainPct(p.shareBps), plainMoney(p.amount), currency]),
    ['share', 'amount'],
  )
}

/** Reusable holdings export; re-import takes only capital and share_price. */
export function holdingsCsv(rows: Holding[], sharePriceMicros: number | null, currency: Currency, noShares = false): string {
  return toCsv(
    ['investor_id', 'name', 'capital', 'shares_display', 'share_price', 'carry', 'currency'],
    rows.map((h) => [
      h.id,
      h.name,
      plainMoney(h.capital),
      noShares ? '' : sharesDisplay(h.capital, sharePriceMicros),
      sharePriceMicros === null ? '' : plainPrice(sharePriceMicros),
      h.carryBps === undefined || h.carryBps === null ? '' : plainPct(h.carryBps), // v0.9: personal carry (C-DIS-8)
      currency,
    ]),
    ['capital', 'shares_display', 'share_price', 'carry'],
  )
}

export function sharesDisplay(capital: number, sharePriceMicros: number | null): string {
  if (sharePriceMicros === null) return '—'
  return formatMicroShares((BigInt(capital) * 10_000n * 1_000_000n) / BigInt(sharePriceMicros))
}

export function plainPrice(micros: number): string {
  const frac = String(micros % 1_000_000).padStart(6, '0').replace(/0+$/, '')
  return `${Math.floor(micros / 1_000_000)}${frac ? `.${frac}` : ''}`
}

/** R-ALL-10: the summary a lead confirms instead of an email chain. */
export function closingConfirmation(
  dealName: string,
  currency: Currency,
  /** null for a convertible or fund units (R-DEAL-06) */
  priceMicros: number | null,
  r: AllocationResult,
  /** refunds found in reconciliation, outside the allocation: over-payments (R-REC-08), withdrawals (C-REC-7), refund-only (C-REC-9) */
  excess: { name: string; amount: number; reason?: 'Withdrawn' | 'Over-paid' | 'Refund only' }[] = [],
  instrument: Instrument = 'equity',
): string {
  const m = (x: number | null) => (x === null ? '—' : formatMoney(x, currency))
  const pf = r.totals.platformFee
  const lines = [
    `Closing confirmation — ${dealName}`,
    `Currency: ${currency}`,
    priceMicros !== null
      ? `Share price: ${formatPrice(priceMicros, currency)} (nominee SPV; fractional shares allowed)`
      : `No shares (${instrument === 'fund_units' ? 'fund units' : 'convertible'}): amounts only`,
    '',
    `Cash received: ${m(r.totals.received)}`,
    `Total invested: ${m(r.totals.invested)}`,
    ...r.feeTotals.map((f) => `${f.label} (paid by ${f.payer}): ${m(f.amount)}`),
    ...(pf ? [`Pro-rata platform fee (${pf.payer}): ${m(pf.amount)}`] : []),
    `Refunds: ${m(r.totals.refunds)}`,
    `Wire to company: ${m(r.totals.wire)}`,
    ...(r.totals.leadInvoice ? [`Invoice to lead: ${m(r.totals.leadInvoice)}`] : []),
    '',
    'Per investor:',
    ...r.rows.map((x) => {
      if (!x.participating) return `- ${x.name}: not in this close, refund ${m(x.refund)}`
      // v0.9: the own fee and the platform fee share only when they apply, so v0.8 lines are unchanged
      // an own fee is the person's only cash fee (C-ALL-0): one item, not "fees" plus "own fee"
      const fees = x.ownFee !== null ? `own fee ${m(x.ownFee)}` : `fees ${m(x.feesTotal)}`
      const share = pf?.payer === 'investors' ? `, platform fee share ${m(x.platformShare)}` : ''
      return `- ${x.name}: invests ${m(x.invested)}, ${fees}${share}, refund ${m(x.refund)}`
    }),
  ]
  const over = excess.filter((x) => x.reason !== 'Withdrawn' && x.reason !== 'Refund only')
  const withdrawn = excess.filter((x) => x.reason === 'Withdrawn')
  const refundOnly = excess.filter((x) => x.reason === 'Refund only')
  if (over.length) lines.push('', 'Over-payments to refund (not part of the allocation):', ...over.map((x) => `- ${x.name}: ${m(x.amount)}`))
  // R-ALL-10 (v0.8): withdrawn investors after the over-payments
  if (withdrawn.length) lines.push('', 'Withdrawn before closing (refund in full):', ...withdrawn.map((x) => `- ${x.name}: ${m(x.amount)}`))
  // C-REC-9 (v0.9): other final states, after the withdrawals
  if (refundOnly.length) lines.push('', 'Refund only (not in this close, refund in full):', ...refundOnly.map((x) => `- ${x.name}: ${m(x.amount)}`))
  if (r.blockers.length) lines.push('', 'NOT READY TO CLOSE: ' + r.blockers.map((b) => b.code + (b.names.length ? ` (${b.names.join(', ')})` : '')).join('; '))
  return lines.join('\n')
}
