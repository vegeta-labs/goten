// @vitest-environment jsdom
// PRD v0.8.8: R-X-01.3 (Load sample deal asks first) and R-REC-01.3 (an investor list import that would void something asks first).
import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import App from './App'
import { initialState, makeReducer, saveState, STORAGE_KEY, type Action, type AppState } from './state'
import { deriveReconcile } from './derive'
import { decide, reconcile } from './lib/reconcile'

class MemoryStorage implements Storage {
  private m = new Map<string, string>()
  get length() {
    return this.m.size
  }
  clear() {
    this.m.clear()
  }
  getItem(k: string) {
    return this.m.has(k) ? this.m.get(k)! : null
  }
  key(i: number) {
    return [...this.m.keys()][i] ?? null
  }
  removeItem(k: string) {
    this.m.delete(k)
  }
  setItem(k: string, v: string) {
    this.m.set(k, v)
  }
}

afterEach(cleanup)

const QUESTION = 'Replace the current deal with the sample? This cannot be undone.'
const reducer = makeReducer(() => ({ epochMs: Date.UTC(2026, 9, 26), offsetMinutes: 0 }))
const run = (s: AppState, ...actions: Action[]) => actions.reduce(reducer, s)
const click = (name: string | RegExp) => fireEvent.click(screen.getByRole('button', { name }))
const button = (name: string) => screen.getByRole('button', { name }) as HTMLButtonElement
const saved = (storage: Storage) => JSON.parse(storage.getItem(STORAGE_KEY)!) as AppState
const investorIds = () => screen.getAllByLabelText(/^Investor \d+ ID$/).map((e) => (e as HTMLInputElement).value)

function confirmed(s: AppState, txn: string, investorId: string): AppState {
  const d = deriveReconcile(s)
  const o = reconcile(d.input!)
  if (!o.ok) throw new Error('reconcile failed')
  const line = o.result.lines.find((l) => l.line.txnId === txn)!
  const who = o.result.commitments.find((c) => c.commitment.id === investorId)!.commitment
  return reducer(s, { type: 'decide', lineId: line.line.id, decision: decide(line.line, who), via: 'candidate', prevStatus: line.status })
}

/** The sample with one confirmed match and one withdrawal, already saved, so the page opens on it. */
function seeded() {
  let s = run({ ...initialState(new Date('2026-10-20T12:00:00Z')), disclaimerAccepted: true }, { type: 'loadSample' })
  s = confirmed(s, 't03', 'c03')
  s = run(s, { type: 'markWithdrawn', investorId: 'c12', on: '2026-10-16', consent: true })
  const storage = new MemoryStorage()
  saveState(storage, s)
  return { s, storage }
}

const csv = (s: AppState, id: (c: AppState['commitments'][number]) => string) =>
  [
    'investor_id,name,email,reference,cash_due,scheme',
    ...s.commitments.map((c) => `${id(c)},${c.name},${c.email},${c.reference},${c.cashDue},${c.scheme}`),
  ].join('\n')

function pasteInvestors(text: string) {
  fireEvent.change(screen.getAllByLabelText('Paste CSV text (first line is the header)')[0], { target: { value: text } })
  const btn = screen.getAllByRole('button', { name: 'Import pasted text' })[0]
  btn.focus()
  fireEvent.click(btn)
  return btn
}

describe('Load sample deal asks first (R-X-01.3)', () => {
  it('TC-X-21 a fresh page and a page holding only the sample load at once', () => {
    const storage = new MemoryStorage()
    render(<App storage={storage} />)
    click('Load sample deal')
    expect(screen.queryByRole('alertdialog')).toBeNull()
    expect(saved(storage).commitments.length).toBe(12)
    click('Load sample deal')
    expect(screen.queryByRole('alertdialog')).toBeNull()
    expect(saved(storage).log.entries.map((e) => e.event)).toEqual(['sample_loaded'])
  })

  it('TC-X-22 with data on the page it asks, with focus on Cancel; Cancel changes nothing', () => {
    const { s, storage } = seeded()
    render(<App storage={storage} />)
    const before = storage.getItem(STORAGE_KEY)
    click('Load sample deal')
    expect(screen.getByRole('alertdialog').textContent).toContain(QUESTION)
    expect(document.activeElement).toBe(button('Cancel'))
    expect(button('Load sample deal').disabled).toBe(true)
    click('Cancel')
    expect(screen.queryByRole('alertdialog')).toBeNull()
    expect(storage.getItem(STORAGE_KEY)).toBe(before)
    expect(saved(storage).decisions).toEqual(JSON.parse(JSON.stringify(s.decisions)))
    expect(document.activeElement).toBe(button('Load sample deal'))
  })

  it('TC-X-22 Replace with sample does what the direct load did', () => {
    const { s, storage } = seeded()
    render(<App storage={storage} />)
    click('Load sample deal')
    click('Replace with sample')
    expect(screen.queryByRole('alertdialog')).toBeNull()
    const after = saved(storage)
    const direct = JSON.parse(JSON.stringify(run(s, { type: 'loadSample' })))
    expect({ ...after, log: null }).toEqual({ ...direct, log: null })
    expect(after.log.entries.map((e) => e.event)).toEqual(['sample_loaded'])
    expect(document.activeElement).toBe(button('Load sample deal'))
  })

  it('TC-X-22 a value typed and not yet committed counts as something to lose', () => {
    const storage = new MemoryStorage()
    render(<App storage={storage} />)
    click('Load sample deal')
    fireEvent.change(screen.getByLabelText('Bank line 1 amount'), { target: { value: '1' } })
    click('Load sample deal')
    expect(screen.getByRole('alertdialog').textContent).toContain(QUESTION)
  })

  it('TC-X-23 only the log differs: a decision made and undone on the sample still asks', () => {
    const storage = new MemoryStorage()
    render(<App storage={storage} />)
    click('Load sample deal')
    click('Confirm Chloe Martin')
    click('Undo decision on t03')
    click('Load sample deal')
    expect(screen.getByRole('alertdialog').textContent).toContain(QUESTION)
  })

  it('TC-X-23 during the tour the button still restarts the tour and this question does not appear', () => {
    render(<App storage={new MemoryStorage()} />)
    click('I understand — take the 3-minute tour')
    click('Next')
    click('Do this for me')
    click('Load sample deal')
    expect(screen.getByTestId('tour-start')).toBeTruthy()
    expect(screen.queryByRole('alertdialog')).toBeNull()
  })

  it('TC-X-23 starting the tour closes the question', () => {
    const { storage } = seeded()
    render(<App storage={storage} />)
    click('Load sample deal')
    click('Take the tour')
    click('Start')
    expect(screen.queryByRole('alertdialog')).toBeNull()
  })

  it('TC-X-23 Clear everything closes the question', () => {
    const { storage } = seeded()
    render(<App storage={storage} />)
    click('Load sample deal')
    click('Clear all data')
    click('Clear everything')
    expect(screen.queryByRole('alertdialog')).toBeNull()
    expect(button('Load sample deal').disabled).toBe(false)
  })
})

describe('Investor list import asks first (R-REC-01.3)', () => {
  it('TC-REC-56 blank IDs: the warning states the counts and the cause, with focus on Cancel', () => {
    const { s, storage } = seeded()
    render(<App storage={storage} />)
    pasteInvestors(csv(s, () => ''))
    expect(screen.getByRole('alertdialog').textContent).toContain(
      'This import will void 1 decision and 1 withdrawal mark (rows with a blank investor_id get new IDs). This cannot be undone.',
    )
    expect(document.activeElement).toBe(button('Cancel'))
  })

  it('TC-REC-56 Cancel changes nothing and returns focus to the import button', () => {
    const { s, storage } = seeded()
    render(<App storage={storage} />)
    const before = storage.getItem(STORAGE_KEY)
    const origin = pasteInvestors(csv(s, () => ''))
    click('Cancel')
    expect(screen.queryByRole('alertdialog')).toBeNull()
    expect(storage.getItem(STORAGE_KEY)).toBe(before)
    expect(investorIds()).toEqual(s.commitments.map((c) => c.id))
    expect(document.activeElement).toBe(origin)
  })

  it('TC-REC-56 Import anyway does what the direct import did, void entries included', () => {
    const { s, storage } = seeded()
    render(<App storage={storage} />)
    const origin = pasteInvestors(csv(s, (c) => `x-${c.id}`))
    click('Import anyway')
    expect(screen.queryByRole('alertdialog')).toBeNull()
    expect(screen.getByText('Imported 12 investors. Amounts read as GBP.')).toBeTruthy()
    const after = saved(storage)
    expect(after.commitments.map((c) => c.id)).toEqual(s.commitments.map((c) => `x-${c.id}`))
    expect(Object.keys(after.withdrawals)).toEqual([])
    expect(after.log.entries.map((e) => e.event)).toEqual(expect.arrayContaining(['import', 'decision_voided', 'withdrawal_voided']))
    expect(document.activeElement).toBe(origin)
  })

  it('TC-REC-57 nothing to void: it imports at once', () => {
    const { s, storage } = seeded()
    render(<App storage={storage} />)
    pasteInvestors(csv(s, (c) => c.id))
    expect(screen.queryByRole('alertdialog')).toBeNull()
    expect(screen.getByText('Imported 12 investors. Amounts read as GBP.')).toBeTruthy()
  })

  it('TC-REC-57 a change to the data while the warning is open closes it and imports nothing', () => {
    const { s, storage } = seeded()
    render(<App storage={storage} />)
    pasteInvestors(csv(s, () => ''))
    click('Undo decision on t03')
    expect(screen.queryByRole('alertdialog')).toBeNull()
    expect(saved(storage).commitments.map((c) => c.id)).toEqual(s.commitments.map((c) => c.id))
  })

  it('TC-REC-57 a second import that fails closes the warning and shows its errors; nothing is imported', () => {
    const { s, storage } = seeded()
    render(<App storage={storage} />)
    pasteInvestors(csv(s, () => ''))
    expect(screen.getByRole('alertdialog')).toBeTruthy()
    pasteInvestors('investor_id,name,email,reference,cash_due,scheme\nx1,Only B,,BB-1,notmoney,none')
    expect(screen.queryByRole('alertdialog')).toBeNull()
    expect(screen.queryByRole('button', { name: 'Import anyway' })).toBeNull()
    expect(document.body.textContent).toContain('cash_due')
    expect(saved(storage).commitments.map((c) => c.id)).toEqual(s.commitments.map((c) => c.id))
  })

  it('TC-REC-57 editing the pasted text closes the warning; nothing is imported', () => {
    const { s, storage } = seeded()
    render(<App storage={storage} />)
    pasteInvestors(csv(s, () => ''))
    fireEvent.change(screen.getAllByLabelText('Paste CSV text (first line is the header)')[0], { target: { value: 'investor_id,name' } })
    expect(screen.queryByRole('alertdialog')).toBeNull()
    expect(saved(storage).commitments.map((c) => c.id)).toEqual(s.commitments.map((c) => c.id))
  })
})
