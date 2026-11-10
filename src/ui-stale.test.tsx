// @vitest-environment jsdom
// PRD v0.8.9 (Test Plan §2.5, 〔M6〕): a page marked out of date cannot send figures on; no mixed figures after a fee
// payer change; the reminder and the copied message only say what is true.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import App from './App'

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

const click = (name: string | RegExp) => fireEvent.click(screen.getByRole('button', { name }))
const tab = (name: RegExp) => fireEvent.click(screen.getByRole('tab', { name }))
const button = (name: string) => screen.getByRole('button', { name }) as HTMLButtonElement
function type(label: string, value: string) {
  const el = screen.getByLabelText(label)
  fireEvent.change(el, { target: { value } })
  fireEvent.blur(el)
}
function reviewSample() {
  render(<App storage={new MemoryStorage()} />)
  click('Load sample deal')
  click('Confirm Chloe Martin')
  click('Confirm Elena Rossi')
  click('Confirm Kavya Iyer')
  click('Mark t11 as not part of this deal')
  click('Mark t14 as not part of this deal')
}
/** the reviewed sample at a £970 minimum, handed off, platform fee moved to the company */
function applied() {
  reviewSample()
  tab(/Deal settings/)
  type('Minimum commitment', '970')
  tab(/Reconciliation/)
  click('Hand off to allocation')
  const panel = screen.getByRole('region', { name: /Change who pays a fee/ })
  fireEvent.click(within(panel).getByLabelText('Consent evidence received'))
  fireEvent.click(within(panel).getByRole('button', { name: /^Apply:/ }))
}
/** handed on to the exit page with terms that give a distribution */
function onExit() {
  reviewSample()
  click('Hand off to allocation')
  click('Hand off to exit distribution')
  type('Exit proceeds', '300000')
  type('Years held', '3')
  type('Carry rate', '20')
}
const handOffAgain = () => click(/^Hand off again/)
const held = () => screen.getByTestId('fee-change-held')
const noFigures = () => {
  expect(screen.queryByTestId('alloc-totals')).toBeNull()
  expect(screen.queryByTestId('confirmation')).toBeNull()
  expect(screen.queryByRole('region', { name: 'Checks' })).toBeNull()
  expect(screen.queryByTestId('excess')).toBeNull()
}

describe('out-of-date pages cannot send figures on (R-X-07)', () => {
  it('TC-ALL-50 out of date: copy, export and hand-off to exit are off and the page says why; a new hand-off brings them back', () => {
    reviewSample()
    click('Hand off to allocation')
    const names = ['Copy closing confirmation', 'Export allocation CSV', 'Hand off to exit distribution']
    expect(names.map((n) => button(n).disabled)).toEqual([false, false, false])
    expect(screen.queryByTestId('stale-actions')).toBeNull()
    tab(/Reconciliation/)
    click('Undo decision on t14')
    tab(/Allocation/)
    expect(screen.getByTestId('stale')).toBeTruthy()
    expect(names.map((n) => button(n).disabled)).toEqual([true, true, true])
    expect(screen.getByTestId('stale-actions').textContent).toBe(
      'Copy, export and hand-off to exit are disabled until you hand off again, so old figures are not sent on.',
    )
    // the figures themselves stay: nothing about this change mixes them
    expect(screen.getByTestId('alloc-totals')).toBeTruthy()
    tab(/Reconciliation/)
    click('Mark t14 as not part of this deal')
    tab(/Allocation/)
    handOffAgain()
    expect(screen.queryByTestId('stale')).toBeNull()
    expect(names.map((n) => button(n).disabled)).toEqual([false, false, false])
  })

  it('TC-ALL-50 with the allocation out of date the holdings are too: exit is marked, exports off, no hand-off, says to deal with the allocation first', () => {
    onExit()
    expect(screen.queryByTestId('exit-stale')).toBeNull()
    tab(/Reconciliation/)
    click('Undo decision on t14')
    expect(screen.getByRole('tab', { name: /Exit distribution/ }).textContent).toContain('out of date')
    tab(/Exit distribution/)
    expect(screen.getByTestId('exit-stale').textContent).toBe('Out of date: reconciliation has changed since the allocation behind these holdings.')
    expect(['Export holdings CSV', 'Export distribution CSV'].map((n) => button(n).disabled)).toEqual([true, true])
    expect(screen.queryByRole('button', { name: /^Hand off again/ })).toBeNull()
    expect(document.body.textContent).toContain('Resolve the allocation first, then hand off again.')
  })

  it('TC-ALL-50 the tour does not hand on past an edit that is still being typed', () => {
    render(<App storage={new MemoryStorage()} />)
    click('I understand — take the 3-minute tour')
    fireEvent.click(screen.getByRole('button', { name: 'Jump to Allocation (steps 8–11)' }))
    click('Next')
    click('Next')
    click('Next')
    fireEvent.change(screen.getByLabelText('Round cap'), { target: { value: '80000' } }) // typed, not yet committed
    click('Do this for me')
    expect(screen.getByTestId('tour-card').textContent).not.toContain('Handed off')
    expect(screen.getByRole('button', { name: 'Do this for me' })).toBeTruthy()
  })

  it('TC-DIS-32 out of date: both exit exports are off and the page says why; a new hand-off brings them back', () => {
    onExit()
    const names = ['Export holdings CSV', 'Export distribution CSV']
    expect(names.map((n) => button(n).disabled)).toEqual([false, false])
    expect(screen.queryByTestId('exit-stale-actions')).toBeNull()
    tab(/Allocation/)
    type('Share price', '20')
    tab(/Exit distribution/)
    expect(screen.getByTestId('exit-stale')).toBeTruthy()
    expect(names.map((n) => button(n).disabled)).toEqual([true, true])
    expect(screen.getByTestId('exit-stale-actions').textContent).toBe('Export is disabled until you hand off again, so old figures are not sent on.')
    expect(document.body.textContent).toContain('Export is disabled until you hand off again, so old holdings are not sent on.')
    handOffAgain()
    expect(screen.queryByTestId('exit-stale')).toBeNull()
    expect(names.map((n) => button(n).disabled)).toEqual([false, false])
  })

  it('TC-DIS-32 holdings imported while the allocation is out of date are not out of date either', () => {
    onExit()
    tab(/Reconciliation/)
    click('Undo decision on t14')
    tab(/Exit distribution/)
    expect(screen.getByTestId('exit-stale')).toBeTruthy()
    fireEvent.change(screen.getAllByLabelText('Paste CSV text (first line is the header)')[0], {
      target: { value: 'investor_id,name,capital\na,Ann,1000.00\nb,Bob,2000.00' },
    })
    fireEvent.click(screen.getAllByRole('button', { name: 'Import pasted text' })[0])
    expect(screen.queryByTestId('exit-stale')).toBeNull()
    expect(button('Export holdings CSV').disabled).toBe(false)
    expect(button('Export distribution CSV').disabled).toBe(false)
  })

  it('TC-DIS-32 imported holdings are not out of date and their exports stay on', () => {
    onExit()
    fireEvent.change(screen.getAllByLabelText('Paste CSV text (first line is the header)')[0], {
      target: { value: 'investor_id,name,capital\na,Ann,1000.00\nb,Bob,2000.00' },
    })
    fireEvent.click(screen.getAllByRole('button', { name: 'Import pasted text' })[0])
    expect(screen.queryByTestId('exit-stale')).toBeNull()
    expect(button('Export holdings CSV').disabled).toBe(false)
    expect(button('Export distribution CSV').disabled).toBe(false)
  })
})

describe('no mixed figures after a fee payer change (C-ALL-11)', () => {
  it('TC-ALL-51 applied or reversed: no figures until a new hand-off, which shows the right ones', () => {
    applied()
    noFigures()
    expect(held().textContent).toContain('No figures until you hand off again')
    handOffAgain()
    const totals = () => screen.getByTestId('alloc-totals').textContent!
    expect(screen.queryByTestId('fee-change-held')).toBeNull()
    expect(totals()).toContain('Total invested£100,455.00')
    expect(totals()).toContain('Company-paid fees£4,513.65')
    expect(totals()).toContain('Wire to company£95,941.35')
    expect(document.querySelector('[data-tour="alloc-c01"]')!.textContent).toContain('£9,700.00')
    click('Reverse')
    noFigures()
    expect(held()).toBeTruthy()
    handOffAgain()
    expect(screen.queryByTestId('fee-change-held')).toBeNull()
    expect(totals()).toContain('Total invested£100,395.00')
    expect(totals()).toContain('Wire to company£98,895.00')
  })

  it('TC-ALL-51 a later change to reconciliation on a deal with a change on record also holds the figures back', () => {
    applied()
    handOffAgain()
    expect(screen.getByTestId('alloc-totals')).toBeTruthy()
    tab(/Reconciliation/)
    click('Undo decision on t14')
    tab(/Allocation/)
    noFigures()
    expect(held()).toBeTruthy()
  })

  it('TC-ALL-42 the reminder no longer points at a preview, because none is shown while a change is active', () => {
    applied()
    handOffAgain()
    tab(/Deal settings/)
    type('Minimum commitment', '1000')
    tab(/Allocation/)
    expect(screen.getByTestId('settings-changed').textContent).toBe('Allocation settings changed since this fee payer change — any problems are listed here')
    expect(screen.queryByTestId('fee-payer-preview')).toBeNull()
  })
})

describe('reminders say only what is true', () => {
  it('TC-REC-58 a line marked not part of this deal loses the reminder and the badge; undoing the mark brings them back', () => {
    render(<App storage={new MemoryStorage()} />)
    click('Load sample deal')
    const line = () => document.querySelector('[data-line="t11"]')!.textContent!
    const page = () => document.body.textContent!
    expect(line()).toContain('Needs review: unmatched for 13 days')
    expect(page()).toMatch(/not matched for 13 days/)
    click('Mark t11 as not part of this deal')
    expect(line()).not.toContain('unmatched for')
    expect(page()).not.toMatch(/not matched for 13 days/)
    click('Undo decision on t11')
    expect(line()).toContain('Needs review: unmatched for 13 days')
  })

  it('TC-ALL-52 the copied message goes when a blocker appears, and does not come back by itself', async () => {
    Object.defineProperty(navigator, 'clipboard', { value: { writeText: vi.fn(() => Promise.resolve()) }, configurable: true })
    reviewSample()
    click('Hand off to allocation')
    click('Copy closing confirmation')
    expect(await screen.findByText('Copied to the clipboard.')).toBeTruthy()
    type('Round cap', '80000')
    expect(screen.getByTestId('blockers')).toBeTruthy()
    expect(screen.queryByText('Copied to the clipboard.')).toBeNull()
    type('Round cap', '')
    expect(screen.queryByTestId('blockers')).toBeNull()
    expect(screen.queryByText('Copied to the clipboard.')).toBeNull()
  })

  it('TC-ALL-52 the copied message goes when the allocation goes out of date on the page', async () => {
    Object.defineProperty(navigator, 'clipboard', { value: { writeText: vi.fn(() => Promise.resolve()) }, configurable: true })
    reviewSample()
    tab(/Deal settings/)
    type('Minimum commitment', '970')
    tab(/Reconciliation/)
    click('Hand off to allocation')
    click('Copy closing confirmation')
    expect(await screen.findByText('Copied to the clipboard.')).toBeTruthy()
    const panel = screen.getByRole('region', { name: /Change who pays a fee/ })
    fireEvent.click(within(panel).getByLabelText('Consent evidence received'))
    fireEvent.click(within(panel).getByRole('button', { name: /^Apply:/ }))
    expect(screen.getByTestId('stale')).toBeTruthy()
    expect(screen.queryByText('Copied to the clipboard.')).toBeNull()
  })

  it('TC-ALL-52 the copied message goes while an edit is pending, before the text has changed', async () => {
    Object.defineProperty(navigator, 'clipboard', { value: { writeText: vi.fn(() => Promise.resolve()) }, configurable: true })
    reviewSample()
    click('Hand off to allocation')
    const before = screen.getByTestId('confirmation').textContent
    click('Copy closing confirmation')
    expect(await screen.findByText('Copied to the clipboard.')).toBeTruthy()
    fireEvent.change(screen.getByLabelText('Share price'), { target: { value: '20' } }) // typed, not yet committed
    expect(screen.getByTestId('confirmation').textContent).toBe(before)
    expect(screen.queryByText('Copied to the clipboard.')).toBeNull()
  })

  it('TC-ALL-52 a copy that finishes after the confirmation changed does not say it copied the text now on the page', async () => {
    let finish = () => {}
    const writeText = vi.fn(() => new Promise<void>((resolve) => (finish = resolve)))
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
    reviewSample()
    click('Hand off to allocation')
    click('Copy closing confirmation')
    type('Share price', '20')
    await act(async () => finish())
    expect(writeText).toHaveBeenCalledTimes(1)
    expect(button('Copy closing confirmation').disabled).toBe(false)
    expect(screen.queryByText('Copied to the clipboard.')).toBeNull()
  })

  it('TC-ALL-52 a failed copy message goes when a blocker appears', async () => {
    Object.defineProperty(navigator, 'clipboard', { value: { writeText: vi.fn(() => Promise.reject(new Error('denied'))) }, configurable: true })
    reviewSample()
    click('Hand off to allocation')
    click('Copy closing confirmation')
    const text = 'Could not copy. Select the text above and copy it yourself.'
    expect(await screen.findByText(text)).toBeTruthy()
    type('Round cap', '80000')
    expect(screen.queryByText(text)).toBeNull()
  })

  it('TC-ALL-52 the copied message goes when the confirmation text changes', async () => {
    Object.defineProperty(navigator, 'clipboard', { value: { writeText: vi.fn(() => Promise.resolve()) }, configurable: true })
    reviewSample()
    click('Hand off to allocation')
    click('Copy closing confirmation')
    expect(await screen.findByText('Copied to the clipboard.')).toBeTruthy()
    type('Share price', '20')
    await waitFor(() => expect(screen.queryByText('Copied to the clipboard.')).toBeNull())
  })
})
