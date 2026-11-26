import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { allocate } from './allocation'
import { buildResult, canonicalJson, hashProjection, parseRequest } from './handoff'
import type { Currency } from './money'

interface Vector {
  name: string
  kind: 'canonical' | 'accept' | 'refuse' | 'result'
  projection?: unknown
  canonical_utf8_hex?: string
  projection_hash?: string
  request_text?: string
  reason?: string
  expected_result?: Record<string, unknown>
}
const vectors: Vector[] = JSON.parse(readFileSync('docs/formats/allocation-handoff-v1.vectors.json', 'utf8')).vectors
const hex = (s: string) => Buffer.from(s, 'utf8').toString('hex')

/** The full import path: hash the projection as sent, then parse and check everything. */
async function importText(text: string, currency: Currency = 'GBP', currencyLocked = false) {
  let hash: string | null = null
  try {
    const raw = JSON.parse(text) as { projection?: unknown }
    if (raw && typeof raw === 'object' && 'projection' in raw) hash = await hashProjection(raw.projection)
  } catch {
    /* parseRequest reports invalid JSON */
  }
  return parseRequest(text, { currency, currencyLocked, hash })
}

describe('allocation hand-off format v1 (shared vectors)', () => {
  it('TC-J-41 canonical JSON bytes and projection hashes match the shared vectors', async () => {
    const canon = vectors.filter((v) => v.kind === 'canonical')
    expect(canon.length).toBeGreaterThanOrEqual(3)
    for (const v of canon) {
      expect(hex(canonicalJson(v.projection)), v.name).toBe(v.canonical_utf8_hex)
      expect(await hashProjection(v.projection), v.name).toBe(v.projection_hash)
    }
  })

  it('TC-J-41 every accept vector imports and every refuse vector is refused', async () => {
    for (const v of vectors.filter((x) => x.kind === 'accept')) {
      const o = await importText(v.request_text!)
      expect(o.ok ? 'ok' : o.errors.join(' | '), v.name).toBe('ok')
    }
    for (const v of vectors.filter((x) => x.kind === 'refuse')) {
      const o = await importText(v.request_text!)
      expect(o.ok, `${v.name} should be refused (${v.reason})`).toBe(false)
    }
  })

  it('TC-J-45 the result vector: imported request → allocation → result file', async () => {
    const v = vectors.find((x) => x.kind === 'result')!
    const o = await importText(v.request_text!)
    if (!o.ok) throw new Error(o.errors.join('; '))
    const a = allocate(o.value.input)
    if (!a.ok) throw new Error('allocation failed')
    expect(JSON.parse(buildResult(o.value, a.result))).toEqual(v.expected_result)
  })
})

// ---------- TC-J-42, 43, 44, 52, 56, 59: built from the base request vector, with the hash recomputed ----------

type Req = { engine: string; projection: Record<string, unknown> & { participants: Record<string, unknown>[] }; bookkeeping: { participants: Record<string, unknown>[] } } & Record<string, unknown>
const baseText = vectors.find((v) => v.name === 'accept_base_request')!.request_text!
async function build(change: (r: Req) => void, rehash = true): Promise<string> {
  const r = JSON.parse(baseText) as Req
  change(r)
  if (rehash) r.projection_hash = await hashProjection(r.projection)
  return JSON.stringify(r)
}
const errorsOf = async (text: string, currency: Currency = 'GBP', locked = false) => {
  const o = await importText(text, currency, locked)
  return o.ok ? [] : o.errors
}

describe('allocation hand-off format v1 (decision J cases)', () => {
  it('TC-J-42 another engine version is refused', async () => {
    expect(await errorsOf(await build((r) => (r.engine = 'goten-rules/0.8')))).toEqual([
      'This request needs engine goten-rules/0.8; this copy of Goten runs goten-rules/0.9',
    ])
  })

  it('TC-J-43 a hashed field changed without a new hash is refused; bookkeeping is not hashed', async () => {
    const tampered = await build((r) => (r.projection.participants[0].allocation_amount = '1000000'), false)
    expect(await errorsOf(tampered)).toEqual(['The file was changed after it was exported (projection_hash does not match).'])
    const renamed = await build((r) => (r.bookkeeping.participants[0].name = 'Ada King'), false)
    const o = await importText(renamed)
    expect(o.ok && o.value.input.investors[0].name).toBe('Ada King')
  })

  it('TC-J-44 every malformed request is refused whole', async () => {
    const cases: ((r: Req) => void)[] = [
      (r) => (r.projection.participants[1].terms = r.projection.participants[0].terms),
      (r) => delete r.bookkeeping.participants[0].name,
      (r) => delete r.projection.share_price_micros,
      (r) => (r.projection.instrument = 'convertible'),
      (r) => (r.projection.participants[1].order = '1'),
      (r) => r.projection.participants.reverse(),
      (r) => (r.projection.vat = '2000'),
      (r) => delete r.projection.minimum,
      (r) => (r.projection.cap = null),
      (r) => delete r.bookkeeping.participants[1].name, // Codex M7 r2 #5: excluded people need a name too
    ]
    for (const [i, c] of cases.entries()) expect((await errorsOf(await build(c))).length, `case ${i}`).toBeGreaterThan(0)
    const dup = baseText.replace('"deal_id": "deal_vec_001",', '"deal_id": "deal_vec_001", "deal_id": "deal_vec_002",')
    expect(await errorsOf(dup)).toEqual(['The file repeats a key inside one object (format §5).'])
    const lone = baseText.replace('"Charles Babbage"', '"Charles \\ud800"')
    expect(await errorsOf(lone)).toEqual(['The file contains a broken character (a lone surrogate, format §5).'])
  })

  it('TC-J-52 allocation amount 0, a 256-character name, and a decision outside a–z/_', async () => {
    const zero = await importText(await build((r) => (r.projection.participants[0].allocation_amount = '0')))
    if (!zero.ok) throw new Error(zero.errors.join('; '))
    const a = allocate(zero.value.input)
    if (!a.ok) throw new Error('allocation failed')
    const out = JSON.parse(buildResult(zero.value, a.result)) as { can_close: boolean; blockers: { code: string }[] }
    expect([zero.value.input.investors[0].received, a.result.rows[0].exclusion, out.blockers.map((b) => b.code)]).toEqual([0, 'no-funds', ['no-participants']])
    expect((await importText(await build((r) => (r.bookkeeping.participants[0].name = 'n'.repeat(256))))).ok).toBe(true)
    expect((await importText(await build((r) => (r.projection.participants[1].decision = 'Refund')))).ok).toBe(false)
  })

  it('TC-J-56 a request in another currency names the way out, also when the currency is locked', async () => {
    const eur = await build((r) => (r.projection.currency = 'EUR'))
    expect(await errorsOf(eur, 'GBP')).toEqual(['This request is in EUR; this deal is in GBP. Change the deal currency to EUR in Deal settings, then import again.'])
    expect(await errorsOf(eur, 'GBP', true)).toEqual([
      'This request is in EUR; this deal is in GBP. Reverse the active fee payer change first, then change the deal currency to EUR and import again.',
    ])
  })

  it('TC-J-59 a blocked allocation exports a status report only', async () => {
    const o = await importText(
      await build((r) => {
        r.projection.platform_fee = { rate_bps: '0', minimum: '60000', payer: 'investors' }
        r.projection.minimum = '0'
        r.projection.participants[0].terms = { fee_mode: 'on_top', fee: null, carry_bps: '0' }
        r.projection.participants[0].allocation_amount = '50000'
      }),
    )
    if (!o.ok) throw new Error(o.errors.join('; '))
    const a = allocate(o.value.input)
    if (!a.ok) throw new Error('allocation failed')
    const out = JSON.parse(buildResult(o.value, a.result))
    expect(Object.keys(out).sort()).toEqual(['blockers', 'can_close', 'engine', 'format', 'handoff_id', 'projection_hash'])
    expect([out.can_close, out.blockers]).toEqual([false, [{ code: 'platform-fee-exceeds', ids: ['p_001'] }]])
  })
})
