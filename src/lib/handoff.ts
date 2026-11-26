// Allocation hand-off (PRD v0.9 C-ALL-12, R-ALL-14; docs/formats/allocation-handoff-v1.md).
// Parsing and checking are pure; hashing uses Web Crypto (the one async step, used only for comparison).
import { validateAllocation, type AllocationInput, type AllocationResult, type Fee, type FeePayer, type Instrument, type OwnTerms, type PlatformFee, type TaxScheme } from './allocation'
import { MAX_MONEY, MAX_PRICE_MICROS, type Currency } from './money'
import { MAX_FEES, MAX_INVESTORS } from './validate'
import { RULES_VERSION } from './version'

export const REQUEST_FORMAT = 'goten.allocation-request/1'
export const RESULT_FORMAT = 'goten.allocation-result/1'

export interface HandoffParticipant {
  id: string
  order: number
  status: string
  decision: string
  allocate: boolean
  name: string | null
  email: string | null
  moneyHeld: number | null
  commitment: number | null
  cashDue: number | null
}

export interface ParsedRequest {
  handoffId: string
  dealId: string
  engine: string
  hash: string
  /** the projection exactly as sent; hashed with canonicalJson */
  projection: unknown
  participants: HandoffParticipant[]
  input: AllocationInput
}

export type ParseOutcome = { ok: true; value: ParsedRequest } | { ok: false; errors: string[] }

// ---------- §4: RFC 8785 canonical JSON (every value is a string, object, array or null) ----------

export function canonicalJson(v: unknown): string {
  if (v === null) return 'null'
  if (typeof v === 'string') return JSON.stringify(v) // matches JCS for strings: short escapes, lowercase \u00xx below U+0020, the rest literal
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(',')}]`
  if (typeof v === 'object') {
    const o = v as Record<string, unknown>
    // default sort compares UTF-16 code units, as JCS requires
    return `{${Object.keys(o)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonicalJson(o[k])}`)
      .join(',')}}`
  }
  throw new Error('canonicalJson: only strings, objects, arrays and null are used in format v1')
}

export async function hashProjection(projection: unknown): Promise<string> {
  const bytes = new TextEncoder().encode(canonicalJson(projection))
  const digest = await crypto.subtle.digest('SHA-256', bytes)
  return 'sha256:' + [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

// ---------- §5: refusals JSON.parse would let through ----------

/** Duplicate keys at any depth (RFC 8785 forbids them; JSON.parse keeps the last). Call only on text that parsed. */
export function hasDuplicateKey(text: string): boolean {
  const stack: { obj: boolean; keys: Set<string>; expectKey: boolean }[] = []
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    const top = stack[stack.length - 1]
    if (ch === '"') {
      let j = i + 1
      while (text[j] !== '"') j += text[j] === '\\' ? 2 : 1
      if (top?.obj && top.expectKey) {
        const key = JSON.parse(text.slice(i, j + 1)) as string
        if (top.keys.has(key)) return true
        top.keys.add(key)
        top.expectKey = false
      }
      i = j
    } else if (ch === '{') stack.push({ obj: true, keys: new Set(), expectKey: true })
    else if (ch === '[') stack.push({ obj: false, keys: new Set(), expectKey: false })
    else if (ch === '}' || ch === ']') stack.pop()
    else if (ch === ',' && top?.obj) top.expectKey = true
  }
  return false
}

const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/
function hasLoneSurrogate(v: unknown): boolean {
  if (typeof v === 'string') return LONE_SURROGATE.test(v)
  if (Array.isArray(v)) return v.some(hasLoneSurrogate)
  if (v && typeof v === 'object') return Object.entries(v).some(([k, x]) => LONE_SURROGATE.test(k) || hasLoneSurrogate(x))
  return false
}

// ---------- §1, §2: field checks ----------

const INT = /^(0|[1-9][0-9]*)$/
const OPAQUE = /^[\x21-\x7E]{1,80}$/
const WORD = /^[a-z_]{1,40}$/
// oxlint-disable-next-line no-control-regex -- format §2.1: fee labels must not contain control characters
const CONTROL = /[\x00-\x1F\x7F]/

class Problems {
  list: string[] = []
  add(m: string) {
    this.list.push(m)
  }
  /** only the listed keys, the required ones present */
  shape(o: unknown, where: string, required: string[], optional: string[] = []): o is Record<string, unknown> {
    if (!o || typeof o !== 'object' || Array.isArray(o)) {
      this.add(`${where}: must be an object`)
      return false
    }
    for (const k of Object.keys(o)) if (!required.includes(k) && !optional.includes(k)) this.add(`${where}: unknown field "${k}"`)
    for (const k of required) if (!(k in o)) this.add(`${where}: missing "${k}"`)
    return true
  }
  int(v: unknown, where: string, min: number, max: number): number | null {
    if (typeof v !== 'string' || !INT.test(v)) {
      this.add(`${where}: must be a whole number written as a string`)
      return null
    }
    const n = Number(v)
    if (!Number.isSafeInteger(n) || n < min || n > max) {
      this.add(`${where}: must be between ${min} and ${max}`)
      return null
    }
    return n
  }
  text(v: unknown, where: string, min: number, max: number): string | null {
    if (typeof v !== 'string' || v.length < min || v.length > max) {
      this.add(`${where}: must be text of ${min}–${max} characters`)
      return null
    }
    return v
  }
}

/**
 * Format v1 §2 and §5. `hash` is the hash recomputed by the caller (hashProjection) or null to skip that check in
 * tests of the other rules. The whole file is refused on any problem.
 */
export function parseRequest(
  text: string,
  ctx: { currency: Currency; currencyLocked: boolean; hash: string | null },
): ParseOutcome {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    return { ok: false, errors: ['The file is not valid JSON.'] }
  }
  if (hasDuplicateKey(text)) return { ok: false, errors: ['The file repeats a key inside one object (format §5).'] }
  if (hasLoneSurrogate(raw)) return { ok: false, errors: ['The file contains a broken character (a lone surrogate, format §5).'] }
  const P = new Problems()
  if (!P.shape(raw, 'file', ['format', 'handoff_id', 'deal_id', 'engine', 'projection_hash', 'projection', 'bookkeeping'])) return { ok: false, errors: P.list }
  const r = raw
  if (r.format !== REQUEST_FORMAT) return { ok: false, errors: [`Not an allocation request (format must be ${REQUEST_FORMAT}).`] }
  if (r.engine !== RULES_VERSION)
    return { ok: false, errors: [`This request needs engine ${String(r.engine)}; this copy of Goten runs ${RULES_VERSION}`] }
  const handoffId = typeof r.handoff_id === 'string' && OPAQUE.test(r.handoff_id) ? r.handoff_id : (P.add('handoff_id: 1–80 printable characters without spaces'), '')
  const dealId = typeof r.deal_id === 'string' && OPAQUE.test(r.deal_id) ? r.deal_id : (P.add('deal_id: 1–80 printable characters without spaces'), '')
  const hash = typeof r.projection_hash === 'string' && /^sha256:[0-9a-f]{64}$/.test(r.projection_hash) ? r.projection_hash : (P.add('projection_hash: must be sha256: and 64 lowercase hex digits'), '')

  const pj = r.projection
  const participants: HandoffParticipant[] = []
  const investors: AllocationInput['investors'] = []
  let input: AllocationInput | null = null
  if (P.shape(pj, 'projection', ['currency', 'instrument', 'minimum', 'deal_fees', 'participants'], ['share_price_micros', 'cap', 'platform_fee'])) {
    if (pj.currency !== 'GBP' && pj.currency !== 'EUR' && pj.currency !== 'USD') P.add('projection.currency: must be GBP, EUR or USD')
    else if (pj.currency !== ctx.currency) {
      const fix = ctx.currencyLocked
        ? `Reverse the active fee payer change first, then change the deal currency to ${pj.currency} and import again.`
        : `Change the deal currency to ${pj.currency} in Deal settings, then import again.`
      return { ok: false, errors: [`This request is in ${pj.currency}; this deal is in ${ctx.currency}. ${fix}`] }
    }
    const instrument = pj.instrument as Instrument
    if (instrument !== 'equity' && instrument !== 'convertible' && instrument !== 'fund_units') P.add('projection.instrument: must be equity, convertible or fund_units')
    let price: number | null = null
    if (instrument === 'equity') {
      if (!('share_price_micros' in pj)) P.add('projection.share_price_micros: required for equity')
      else price = P.int(pj.share_price_micros, 'projection.share_price_micros', 1, MAX_PRICE_MICROS)
    } else if ('share_price_micros' in pj) P.add('projection.share_price_micros: must be absent unless the instrument is equity')
    const cap = 'cap' in pj ? P.int(pj.cap, 'projection.cap', 1, MAX_MONEY) : null
    const minimum = P.int(pj.minimum, 'projection.minimum', 0, MAX_MONEY) ?? 0

    let platformFee: PlatformFee | null = null
    if ('platform_fee' in pj && P.shape(pj.platform_fee, 'projection.platform_fee', ['rate_bps', 'minimum', 'payer'], ['maximum', 'add_on_threshold', 'add_on_rate_bps'])) {
      const f = pj.platform_fee
      const payer = f.payer as FeePayer
      if (payer !== 'investors' && payer !== 'lead' && payer !== 'company') P.add('projection.platform_fee.payer: must be investors, lead or company')
      const threshold = 'add_on_threshold' in f ? P.int(f.add_on_threshold, 'projection.platform_fee.add_on_threshold', 0, MAX_MONEY) : null
      if ('add_on_threshold' in f && !('add_on_rate_bps' in f)) P.add('projection.platform_fee.add_on_rate_bps: required with an add-on threshold')
      const addOn = 'add_on_rate_bps' in f ? (P.int(f.add_on_rate_bps, 'projection.platform_fee.add_on_rate_bps', 0, 10_000) ?? 0) : 0
      if (!('add_on_threshold' in f) && addOn !== 0) P.add('projection.platform_fee.add_on_rate_bps: must be absent or "0" without a threshold')
      const min = P.int(f.minimum, 'projection.platform_fee.minimum', 0, MAX_MONEY) ?? 0
      const max = 'maximum' in f ? P.int(f.maximum, 'projection.platform_fee.maximum', 0, MAX_MONEY) : null
      if (max !== null && min > max) P.add('projection.platform_fee: minimum must not exceed the maximum')
      platformFee = { rateBps: P.int(f.rate_bps, 'projection.platform_fee.rate_bps', 0, 10_000) ?? 0, minimum: min, maximum: max, addOnThreshold: threshold, addOnBps: addOn, payer }
    }

    const fees: Fee[] = []
    if (!Array.isArray(pj.deal_fees)) P.add('projection.deal_fees: must be a list')
    else {
      if (pj.deal_fees.length > MAX_FEES) P.add(`projection.deal_fees: at most ${MAX_FEES}`)
      const ids = new Set<string>()
      const labels = new Set<string>()
      pj.deal_fees.forEach((x, i) => {
        const where = `projection.deal_fees[${i + 1}]`
        if (!P.shape(x, where, ['id', 'label', 'payer', 'kind', 'value'])) return
        const id = P.text(x.id, `${where}.id`, 1, 40)
        const label = P.text(x.label, `${where}.label`, 1, 60)
        if (label !== null && CONTROL.test(label)) P.add(`${where}.label: no control characters`)
        if (id !== null) {
          if (ids.has(id)) P.add(`${where}.id: duplicate "${id}"`)
          ids.add(id)
        }
        if (label !== null) {
          const k = label.replace(/^[ \t\r\n]+|[ \t\r\n]+$/g, '').toLowerCase()
          if (labels.has(k)) P.add(`${where}.label: duplicate "${label}"`)
          labels.add(k)
        }
        if (x.payer !== 'company' && x.payer !== 'lead') P.add(`${where}.payer: must be company or lead`)
        if (x.kind !== 'percent' && x.kind !== 'fixed') P.add(`${where}.kind: must be percent or fixed`)
        const value = x.kind === 'percent' ? P.int(x.value, `${where}.value`, 0, 10_000) : P.int(x.value, `${where}.value`, 1, MAX_MONEY)
        if (id !== null && label !== null && value !== null && (x.kind === 'percent' || x.kind === 'fixed'))
          fees.push({ id, label, payer: x.payer as FeePayer, kind: x.kind, value })
      })
    }

    // bookkeeping (not hashed): names, emails, money held
    const book = new Map<string, { name: string | null; email: string | null; moneyHeld: number | null }>()
    if (P.shape(r.bookkeeping, 'bookkeeping', ['participants']) && Array.isArray(r.bookkeeping.participants)) {
      r.bookkeeping.participants.forEach((x, i) => {
        const where = `bookkeeping.participants[${i + 1}]`
        if (!P.shape(x, where, ['id'], ['name', 'email', 'money_held'])) return
        const id = typeof x.id === 'string' ? x.id : ''
        if (book.has(id)) P.add(`${where}.id: duplicate "${id}"`)
        const name = 'name' in x ? P.text(x.name, `${where}.name`, 1, 256) : null
        const email = 'email' in x ? P.text(x.email, `${where}.email`, 1, 320) : null
        if (email !== null && !/^[^\s@]+@[^\s@]+$/.test(email)) P.add(`${where}.email: not an email address`)
        const moneyHeld = 'money_held' in x ? P.int(x.money_held, `${where}.money_held`, 0, MAX_MONEY) : null
        book.set(id, { name, email, moneyHeld })
      })
    } else if (r.bookkeeping && typeof r.bookkeeping === 'object') P.add('bookkeeping.participants: must be a list')

    if (!Array.isArray(pj.participants)) P.add('projection.participants: must be a list')
    else {
      if (pj.participants.length > MAX_INVESTORS) P.add(`projection.participants: at most ${MAX_INVESTORS}`)
      const seen = new Set<string>()
      pj.participants.forEach((x, i) => {
        const where = `projection.participants[${i + 1}]`
        const allocate = !!x && typeof x === 'object' && (x as Record<string, unknown>).decision === 'allocate'
        const ok = allocate
          ? P.shape(x, where, ['id', 'order', 'status', 'decision', 'terms', 'commitment', 'cash_due', 'allocation_amount', 'scheme'])
          : P.shape(x, where, ['id', 'order', 'status', 'decision'])
        if (!ok) return
        const id = P.text(x.id, `${where}.id`, 1, 40) ?? ''
        if (id !== '' && id.trim() === '') P.add(`${where}.id: must not be blank`) // every participant (Codex M7 r2 #5)
        if (seen.has(id)) P.add(`${where}.id: duplicate "${id}"`)
        seen.add(id)
        const order = P.int(x.order, `${where}.order`, 1, MAX_INVESTORS)
        if (order !== null && order !== i + 1) P.add(`${where}.order: participants must be sorted by order, 1 to n (found ${order} at position ${i + 1})`)
        if (typeof x.status !== 'string' || !WORD.test(x.status)) P.add(`${where}.status: 1–40 of a–z and _`)
        if (typeof x.decision !== 'string' || !WORD.test(x.decision)) P.add(`${where}.decision: 1–40 of a–z and _`)
        const b = book.get(id) ?? { name: null, email: null, moneyHeld: null }
        const p: HandoffParticipant = { id, order: order ?? i + 1, status: String(x.status), decision: String(x.decision), allocate, name: b.name, email: b.email, moneyHeld: b.moneyHeld, commitment: null, cashDue: null }
        participants.push(p)
        // format §2.2: every bookkeeping entry has a name, for everyone in the request (Codex M7 r2 #5)
        if (b.name === null || b.name.trim() === '') P.add(`${where}: no name in bookkeeping`)
        if (!allocate) return
        p.commitment = P.int(x.commitment, `${where}.commitment`, 0, MAX_MONEY)
        p.cashDue = P.int(x.cash_due, `${where}.cash_due`, 0, MAX_MONEY)
        const received = P.int(x.allocation_amount, `${where}.allocation_amount`, 0, MAX_MONEY)
        if (x.scheme !== 'none' && x.scheme !== 'SEIS' && x.scheme !== 'EIS') P.add(`${where}.scheme: must be none, SEIS or EIS`)
        const ownTerms = parseTerms(P, x.terms, `${where}.terms`)
        const carryBps = x.terms && typeof x.terms === 'object' ? P.int((x.terms as Record<string, unknown>).carry_bps, `${where}.terms.carry_bps`, 0, 10_000) : null
        if (ownTerms && received !== null)
          investors.push({ id, name: b.name ?? id, received, scheme: x.scheme as TaxScheme, ownTerms, carryBps })
      })
      for (const id of book.keys()) if (!seen.has(id)) P.add(`bookkeeping: "${id}" is not in projection.participants`)
    }
    // every person in a request carries complete own terms, so the deal default basis is never used
    input = { feeBasis: 'deducted', minimum, cap, priceMicros: price, instrument, platformFee, fees, investors }
  }
  // format §5: every Goten input rule applies too, exactly as for typed or imported inputs (e.g. blank-looking names)
  if (input) for (const e of validateAllocation(input)) P.add(`${e.where}: ${e.message}`)
  if (P.list.length || !input) return { ok: false, errors: P.list }
  if (ctx.hash !== null && ctx.hash !== hash) return { ok: false, errors: ['The file was changed after it was exported (projection_hash does not match).'] }
  return { ok: true, value: { handoffId, dealId, engine: RULES_VERSION, hash, projection: pj, participants, input } }
}

function parseTerms(P: Problems, t: unknown, where: string): OwnTerms | null {
  if (!P.shape(t, where, ['fee_mode', 'fee', 'carry_bps'])) return null
  const mode = t.fee_mode === 'on_top' ? 'onTop' : t.fee_mode === 'deducted' ? 'deducted' : (P.add(`${where}.fee_mode: must be on_top or deducted`), null)
  if (t.fee === null) return mode ? { mode, fee: null } : null
  if (!P.shape(t.fee, `${where}.fee`, ['kind'], ['rate_bps', 'amount'])) return null
  const f = t.fee
  if (f.kind === 'rate') {
    if ('amount' in f) P.add(`${where}.fee.amount: not with a rate`)
    const bps = P.int(f.rate_bps, `${where}.fee.rate_bps`, 0, mode === 'deducted' ? 9_999 : 10_000)
    return mode && bps !== null ? { mode, fee: { kind: 'percent', bps } } : null
  }
  if (f.kind === 'fixed') {
    if ('rate_bps' in f) P.add(`${where}.fee.rate_bps: not with a fixed amount`)
    const amount = P.int(f.amount, `${where}.fee.amount`, 1, MAX_MONEY)
    return mode && amount !== null ? { mode, fee: { kind: 'fixed', amount } } : null
  }
  P.add(`${where}.fee.kind: must be rate or fixed`)
  return null
}

/**
 * A saved request read back (reload, export): checked again in full, in its own currency, without recomputing the hash
 * (the import did that); the stated hash must be the one saved with it (Tech Design §10.2, Codex M7 #5).
 */
export function readSavedRequest(text: string, savedHash: string): ParseOutcome {
  let currency: Currency = 'GBP'
  try {
    const c = (JSON.parse(text) as { projection?: { currency?: unknown } }).projection?.currency
    if (c === 'GBP' || c === 'EUR' || c === 'USD') currency = c
  } catch {
    return { ok: false, errors: ['The saved request is not valid JSON.'] }
  }
  const o = parseRequest(text, { currency, currencyLocked: false, hash: null })
  if (o.ok && o.value.hash !== savedHash) return { ok: false, errors: ['The saved request does not match its saved hash.'] }
  return o
}

/** R-ALL-14 at export time: the allocation inputs now are exactly those the request gave (Codex M7 #1). */
export function requestMatches(req: AllocationInput, now: AllocationInput): boolean {
  const key = (x: AllocationInput) =>
    JSON.stringify([
      x.minimum,
      x.cap,
      x.priceMicros,
      x.instrument ?? 'equity',
      x.platformFee ?? null,
      x.fees.map((f) => [f.id, f.payer, f.kind, f.value]),
      x.investors.map((v) => [v.id, v.received, v.scheme, v.ownTerms ?? null, v.carryBps ?? null]),
    ])
  return key(req) === key(now)
}

// ---------- §3: result ----------

const s = (n: number | bigint) => String(n)

/** Format v1 §3. Blocked allocations give the status-report shape only. */
export function buildResult(req: Pick<ParsedRequest, 'handoffId' | 'engine' | 'hash' | 'participants' | 'input'>, r: AllocationResult): string {
  const head = { format: RESULT_FORMAT, handoff_id: req.handoffId, engine: req.engine, projection_hash: req.hash }
  if (r.blockers.length) {
    const blockers = [...r.blockers]
      .sort((a, b) => (a.code < b.code ? -1 : a.code > b.code ? 1 : 0))
      .map((b) => ({ code: b.code, ids: r.blockerIds[b.code] ?? [] }))
    return JSON.stringify({ ...head, can_close: false, blockers }, null, 2)
  }
  const rows = new Map(r.rows.map((x) => [x.id, x]))
  const participants = req.participants.map((p) => {
    const x = p.allocate ? rows.get(p.id) : undefined
    if (!x) return { id: p.id, allocated: false, exclusion: 'not-in-allocation' }
    if (!x.participating) return { id: p.id, allocated: false, exclusion: x.exclusion, refund: s(x.refund) }
    return {
      id: p.id,
      allocated: true,
      exclusion: null,
      target: s(x.preFeeInvested),
      own_fee: s(x.ownFee ?? 0),
      platform_fee_share: s(x.platformShare),
      invested: s(x.invested),
      refund: s(x.refund),
      ...(x.microShares !== null ? { micro_shares: s(x.microShares) } : {}),
    }
  })
  const t = r.totals
  const totals = {
    received: s(t.received),
    invested: s(t.invested),
    investor_fees: s(t.investorFees),
    ...(t.platformFee ? { platform_fee: s(t.platformFee.amount), platform_fee_payer: t.platformFee.payer } : {}),
    refunds: s(t.refunds),
    company_fees: s(t.companyFees ?? 0),
    lead_invoice: s(t.leadInvoice ?? 0),
    wire: s(t.wire ?? 0),
  }
  const deal_fees = r.feeTotals.filter((f) => f.payer !== 'investors').map((f) => ({ id: f.id, amount: s(f.amount ?? 0) }))
  return JSON.stringify({ ...head, can_close: true, blockers: [], participants, totals, deal_fees }, null, 2)
}
