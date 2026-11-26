// v0.9 (decision J) parts of the allocation page: instrument, pro-rata platform fee, own terms on the investor table, and the
// allocation hand-off request/result (R-DEAL-06, R-ALL-13, R-DEAL-05, R-ALL-14). No money is worked out here.
import { useEffect, useId, useRef, useState, type Dispatch } from 'react'
import { PLATFORM_PAYER_NOTE, type AllocationResult, type FeePayer, type Instrument } from '../lib/allocation'
import { buildResult, hashProjection, parseRequest, readSavedRequest, requestMatches } from '../lib/handoff'
import { deriveAllocation } from '../derive'
import { plainMoney, type Currency } from '../lib/money'
import { plainPrice } from '../lib/exports'
import { investorRow, ownTermsLocked, OWN_TERMS_LOCKED_TEXT, type Action, type AppState, type InvestorRow, type PlatformFeeRow } from '../state'
import { Cell, ErrorList, Notice, Term } from './common'
import { download } from './download'

const pct = (bps: number) => (bps / 100).toFixed(2)
const EMPTY_PLATFORM_FEE: PlatformFeeRow = { rate: '', minimum: '', maximum: '', threshold: '', addOnRate: '', payer: 'investors' }

export function InstrumentField({ value, dispatch }: { value: Instrument; dispatch: Dispatch<Action> }) {
  return (
    <label>
      Instrument
      <select
        className="field"
        aria-label="Instrument"
        value={value}
        onChange={(e) => {
          const instrument = e.target.value as Instrument
          // R-DEAL-06: only equity has a share price, so the price is cleared for the others
          dispatch({ type: 'setAllocation', patch: instrument === 'equity' ? { instrument } : { instrument, price: '' } })
        }}
      >
        <option value="equity">Equity (shares)</option>
        <option value="convertible">Convertible (no shares yet)</option>
        <option value="fund_units">Fund units (no shares)</option>
      </select>
    </label>
  )
}

export function PlatformFeeSection({ value, sym, dispatch }: { value: PlatformFeeRow | null; sym: string; dispatch: Dispatch<Action> }) {
  // the aria-label hides the visible label, so the currency and the meaning of a blank go in descriptions (Codex M7 r2 #8)
  const ccy = useId()
  const noCap = useId()
  const noAddOn = useId()
  const set = (patch: Partial<PlatformFeeRow>) => dispatch({ type: 'setAllocation', patch: { platformFee: { ...(value ?? EMPTY_PLATFORM_FEE), ...patch } } })
  return (
    <>
      <h3>
        <Term term="pro-rata platform fee">Pro-rata platform fee</Term>
      </h3>
      {value === null ? (
        <button type="button" onClick={() => set({})}>
          Add a pro-rata platform fee
        </button>
      ) : (
        <>
          <span id={ccy} hidden>
            In {sym}
          </span>
          <span id={noCap} hidden>
            In {sym}; blank means no cap
          </span>
          <span id={noAddOn} hidden>
            In {sym}; blank means no add-on
          </span>
          <div className="form-grid">
            <label>
              Rate (%)
              <Cell className="field" label="Platform fee rate" value={value.rate} onCommit={(v) => set({ rate: v })} />
            </label>
            <label>
              Minimum ({sym})
              <Cell className="field" label="Platform fee minimum" describedBy={ccy} value={value.minimum} onCommit={(v) => set({ minimum: v })} />
            </label>
            <label>
              Maximum ({sym}, blank = no cap)
              <Cell className="field" label="Platform fee maximum" describedBy={noCap} value={value.maximum} onCommit={(v) => set({ maximum: v })} />
            </label>
            <label>
              Add-on above ({sym}, blank = none)
              <Cell className="field" label="Platform fee add-on threshold" describedBy={noAddOn} value={value.threshold} onCommit={(v) => set({ threshold: v })} />
            </label>
            <label>
              Add-on rate (%)
              <Cell className="field" label="Platform fee add-on rate" value={value.addOnRate} onCommit={(v) => set({ addOnRate: v })} />
            </label>
            <label>
              Paid by
              <select className="field" aria-label="Platform fee paid by" value={value.payer} onChange={(e) => set({ payer: e.target.value as FeePayer })}>
                <option value="investors">Investors, pro rata</option>
                <option value="lead">The lead (invoice)</option>
                <option value="company">The company (from the wire)</option>
              </select>
            </label>
          </div>
          <p className="hint">Worked out on the total of everyone’s amount after fees, minimum and scale-back. Nobody’s cash due changes.</p>
          <p className="hint" data-testid="platform-payer-note">
            {PLATFORM_PAYER_NOTE}
          </p>
          <button type="button" className="link danger" onClick={() => dispatch({ type: 'setAllocation', patch: { platformFee: null } })}>
            Remove the platform fee
          </button>
        </>
      )}
    </>
  )
}

/** R-DEAL-05: own terms on one allocation investor row. */
export function InvestorTermsCells({ v, i, dispatch, state }: { v: InvestorRow; i: number; dispatch: Dispatch<Action>; state: AppState }) {
  const edit = (field: keyof InvestorRow) => (value: string) => dispatch({ type: 'editInvestor', index: i, rowId: v.id, field, value })
  // C-ALL-10: locked for people an active fee payer change covers (Codex M7 r2 #1)
  if (ownTermsLocked(state, v.id))
    return (
      <>
        <td colSpan={3}>
          <span className="hint">
            {v.ownFeeMode || 'Deal default'} · {OWN_TERMS_LOCKED_TEXT}
          </span>
        </td>
        <td>
          <Cell className="cell num" label={`Allocation investor ${i + 1} carry`} value={v.carry} onCommit={edit('carry')} />
        </td>
      </>
    )
  return (
    <>
      <td>
        <select className="cell" aria-label={`Allocation investor ${i + 1} own fee mode`} value={v.ownFeeMode} onChange={(e) => edit('ownFeeMode')(e.target.value)}>
          <option value="">Deal default</option>
          <option value="on_top">On top</option>
          <option value="deducted">Deducted from the wire</option>
        </select>
      </td>
      <td>
        <Cell className="cell num" label={`Allocation investor ${i + 1} own fee rate`} value={v.ownFeeRate} onCommit={edit('ownFeeRate')} />
      </td>
      <td>
        <Cell className="cell num" label={`Allocation investor ${i + 1} own fixed fee`} value={v.ownFeeFixed} onCommit={edit('ownFeeFixed')} />
      </td>
      <td>
        <Cell className="cell num" label={`Allocation investor ${i + 1} carry`} value={v.carry} onCommit={edit('carry')} />
      </td>
    </>
  )
}

/** R-ALL-14: import a request, export its result; the file never leaves the browser. */
export function HandoffRequestSection({
  state,
  dispatch,
  result,
  pending,
}: {
  state: AppState
  dispatch: Dispatch<Action>
  result: AllocationResult | null
  pending: boolean
}) {
  const [msg, setMsg] = useState<{ ok: true; text: string } | { ok: false; errors: string[] } | null>(null)
  const cur: Currency = state.deal.currency
  // a file read or hash that finishes after this section is gone ("Clear all data"), after the investor list was replaced
  // (the sample, a CSV or another request) or after the currency changed must not bring data back, use the old currency or
  // log an export (Codex M7 r2 #2, r3 #1 #4, as the CSV importer). The gate is taken before the first await.
  const alive = useRef(true)
  const gateKey = `${state.tables.investors}:${cur}`
  const gate = useRef(gateKey)
  useEffect(() => {
    gate.current = gateKey
  })
  useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
    }
  }, [])
  const req = state.allocation.handoffRequest
  const locked = state.feePayerChanges.some((c) => c.status === 'active')

  const read = async (text: string) => {
    let hash: string | null = null
    try {
      const raw = JSON.parse(text) as { projection?: unknown }
      if (raw && typeof raw === 'object' && 'projection' in raw) hash = await hashProjection(raw.projection)
    } catch {
      /* parseRequest says the file is not JSON */
    }
    return { hash, parsed: parseRequest(text, { currency: cur, currencyLocked: locked, hash }) }
  }

  const onFile = async (file: File) => {
    const start = gate.current
    const text = await file.text()
    const { hash, parsed } = await read(text)
    if (!alive.current || gate.current !== start) return
    if (!parsed.ok || hash === null) return setMsg({ ok: false, errors: parsed.ok ? ['The file has no projection.'] : parsed.errors })
    const r = parsed.value
    const x = r.input
    const pf = x.platformFee
    dispatch({
      type: 'importHandoffRequest',
      text,
      hash,
      handoffId: r.handoffId,
      participants: r.participants.length,
      rows: x.investors.map(investorRow),
      minimum: x.minimum ? plainMoney(x.minimum) : '',
      allocation: {
        price: x.priceMicros === null ? '' : plainPrice(x.priceMicros),
        cap: x.cap === null ? '' : plainMoney(x.cap),
        instrument: x.instrument ?? 'equity',
        platformFee: pf
          ? {
              rate: pct(pf.rateBps),
              minimum: plainMoney(pf.minimum),
              maximum: pf.maximum === null ? '' : plainMoney(pf.maximum),
              threshold: pf.addOnThreshold === null ? '' : plainMoney(pf.addOnThreshold),
              addOnRate: pf.addOnThreshold === null ? '' : pct(pf.addOnBps),
              payer: pf.payer,
            }
          : null,
        fees: x.fees.map((f) => ({ id: f.id, label: f.label, payer: f.payer, kind: f.kind, value: f.kind === 'percent' ? pct(f.value) : plainMoney(f.value) })),
      },
    })
    const out = r.participants.filter((p) => !p.allocate).length
    setMsg({ ok: true, text: `Imported hand-off ${r.handoffId}: ${x.investors.length} investors to allocate${out ? `, ${out} not in this allocation` : ''}.` })
  }

  // a restored request is shown and used only once its projection hashes to the saved hash (Codex M7 r3 #3): loading a save
  // is synchronous and Web Crypto is not, so this check runs here, before anything from the request is displayed
  const [verified, setVerified] = useState<{ text: string; hash: string; ok: boolean } | null>(null)
  useEffect(() => {
    if (!req) return
    let live = true
    void read(req.text).then(({ hash }) => live && setVerified({ text: req.text, hash: req.hash, ok: hash === req.hash }))
    return () => {
      live = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only the saved request decides the result
  }, [req?.text, req?.hash])
  const check = req && verified?.text === req.text && verified.hash === req.hash ? verified.ok : null
  const saved = req && check ? readSavedRequest(req.text, req.hash) : null
  const current = req ? deriveAllocation(state).input : null
  const exportBlock = !req
    ? null
    : check === null
      ? 'Checking the saved request…'
      : !check || !saved?.ok
        ? 'The saved request does not match its hash. Import it again.'
        : state.allocation.editedSinceRequest || (current && !requestMatches(saved.value.input, current))
          ? 'An allocation input or the currency changed after the import. The sender only accepts a result for the inputs it sent: import the request again.'
          : pending || !result
            ? 'No result yet: fix the input errors first.'
            : null
  const latestExport = useRef({ block: exportBlock, hash: req?.hash, result })
  useEffect(() => {
    latestExport.current = { block: exportBlock, hash: req?.hash, result }
  })

  const onExport = async () => {
    if (!req || exportBlock || !result) return
    const start = gate.current
    const { parsed } = await read(req.text)
    // after the await: still here, same data, and still exportable for the same request and result (Codex M7 r3 #4)
    const now = latestExport.current
    if (!alive.current || gate.current !== start || now.block !== null || now.hash !== req.hash || now.result !== result) return
    if (!parsed.ok || parsed.value.hash !== req.hash) return setMsg({ ok: false, errors: parsed.ok ? ['The saved request changed. Import it again.'] : parsed.errors })
    download(`allocation_result_${parsed.value.handoffId}.json`, buildResult(parsed.value, result))
    dispatch({ type: 'handoffResultExported', handoffId: parsed.value.handoffId, hash: req.hash })
  }

  return (
    <>
      <h3>Allocation hand-off (JSON)</h3>
      <p className="hint">
        Import a request from Bulma or another tool: it replaces every allocation input. The result goes back as a file. Nothing is sent anywhere.
      </p>
      <label>
        Import hand-off request
        <input
          type="file"
          accept=".json,application/json"
          aria-label="Import hand-off request"
          onChange={(e) => {
            const f = e.target.files?.[0]
            e.target.value = '' // the same file can be chosen again after an edit (Codex M7 #4)
            if (f) void onFile(f)
          }}
        />
      </label>
      {msg && (msg.ok ? <Notice kind="ok">{msg.text}</Notice> : <ErrorList errors={msg.errors.map((m) => ({ where: 'Hand-off request', message: m }))} title="Nothing was imported" />)}
      {saved?.ok && (
        <div data-testid="handoff-request">
          <p>
            Hand-off <code>{saved.value.handoffId}</code> for deal <code>{saved.value.dealId}</code>: {saved.value.participants.filter((p) => p.allocate).length} to
            allocate.
          </p>
          <ul className="plain" aria-label="Sent with the request">
            {saved.value.participants
              .filter((p) => p.allocate)
              .map((p) => (
                <li key={p.id}>
                  {p.name}: commitment {p.commitment === null ? '—' : plainMoney(p.commitment)} {cur}, cash due {p.cashDue === null ? '—' : plainMoney(p.cashDue)} {cur}
                  {p.moneyHeld !== null && (
                    <>
                      , money held {plainMoney(p.moneyHeld)} {cur}
                    </>
                  )}
                </li>
              ))}
          </ul>
          {saved.value.participants.some((p) => !p.allocate) && (
            <>
              <h4>Not in this allocation</h4>
              <ul className="plain" aria-label="Not in this allocation">
                {saved.value.participants
                  .filter((p) => !p.allocate)
                  .map((p) => (
                    <li key={p.id}>
                      {p.name ?? p.id} ({p.decision.replace(/_/g, ' ')})
                    </li>
                  ))}
              </ul>
            </>
          )}
        </div>
      )}
      {req && (
        <p>
          <button type="button" disabled={exportBlock !== null} onClick={() => void onExport()}>
            Export result
          </button>{' '}
          {exportBlock && <span className="hint">{exportBlock}</span>}
        </p>
      )}
    </>
  )
}
