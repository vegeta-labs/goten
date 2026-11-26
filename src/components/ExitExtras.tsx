// v0.9 (decision J) parts of the exit page: carry payees and the per-investor table (C-DIS-8, C-DIS-9, R-DIS-08, R-DIS-09).
import type { Dispatch } from 'react'
import type { WaterfallResult } from '../lib/waterfall'
import type { Action, PayeeRow } from '../state'
import { Cell, Term } from './common'

export function PayeesSection({ payees, dispatch }: { payees: PayeeRow[]; dispatch: Dispatch<Action> }) {
  return (
    <>
      <h4>
        <Term term="carry payee">Carry payees</Term>
      </h4>
      {payees.length === 0 ? (
        <p className="hint">No list: the lead receives all the carry.</p>
      ) : (
        <div className="table-wrap">
          <table className="grid" aria-label="Carry payees">
            <thead>
              <tr>
                <th>Payee</th>
                <th>Share (%)</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {payees.map((p, i) => (
                <tr key={p.id}>
                  <td>
                    <Cell label={`Payee ${i + 1} name`} value={p.name} onCommit={(value) => dispatch({ type: 'editPayee', index: i, rowId: p.id, field: 'name', value })} />
                  </td>
                  <td>
                    <Cell
                      className="cell num"
                      label={`Payee ${i + 1} share`}
                      value={p.share}
                      onCommit={(value) => dispatch({ type: 'editPayee', index: i, rowId: p.id, field: 'share', value })}
                    />
                  </td>
                  <td>
                    <button type="button" className="link danger" aria-label={`Delete payee ${i + 1}`} onClick={() => dispatch({ type: 'deletePayee', index: i })}>
                      Delete
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <button type="button" onClick={() => dispatch({ type: 'addPayee' })}>
        Add payee
      </button>
      <p className="hint">Shares add up to 100%. The carry is split by largest remainder; an equal remainder goes to the payee higher in the list.</p>
    </>
  )
}

export function PerInvestorCarry({ r, m }: { r: WaterfallResult; m: (v: number) => string }) {
  return (
    <>
      {r.tieredNote !== null && <p className="hint">Tiered table used instead of each investor's carry of {(r.tieredNote / 100).toFixed(2).replace(/\.?0+$/, '')}%.</p>}
      {r.perInvestor && (
        <>
          <h4>Each investor’s own waterfall</h4>
          <p className="hint">Carry rates differ, so proceeds are split by amount invested first and each investor’s carry is worked out on their share.</p>
          <div className="table-wrap">
            <table className="grid read" aria-label="Per-investor waterfall">
              <thead>
                <tr>
                  <th>Name</th>
                  <th className="num">Carry rate</th>
                  <th className="num">Share of proceeds</th>
                  <th className="num">Capital back</th>
                  <th className="num">Hurdle</th>
                  <th className="num">Catch-up to lead</th>
                  <th className="num">Carry</th>
                  <th className="num">To investor</th>
                </tr>
              </thead>
              <tbody>
                {r.perInvestor.map((p) => (
                  <tr key={p.id}>
                    <td>{p.name}</td>
                    <td className="num">{(p.carryBps / 100).toFixed(2)}%</td>
                    <td className="num">{m(p.share)}</td>
                    <td className="num">{m(p.returnOfCapital)}</td>
                    <td className="num">{m(p.hurdlePaid)}</td>
                    <td className="num">{m(p.catchUpToLead)}</td>
                    <td className="num">{m(p.carry)}</td>
                    <td className="num">{m(p.distribution)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
      {r.carry > 0 && (
        <ul className="plain" aria-label="Carry by payee">
          {r.payees.map((p, i) => (
            <li key={i}>
              {p.name}: {m(p.amount)}
            </li>
          ))}
        </ul>
      )}
    </>
  )
}
