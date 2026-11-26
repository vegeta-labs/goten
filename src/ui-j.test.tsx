// @vitest-environment jsdom
// PRD v0.9 decision J interface (〔M7〕): the hand-off request section's asynchronous steps (Codex M7 round 3 #1, #3, #4).
import { readFileSync } from 'node:fs'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import App from './App'
import { STORAGE_KEY } from './state'

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

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

const vectors = JSON.parse(readFileSync('docs/formats/allocation-handoff-v1.vectors.json', 'utf8')).vectors as { kind: string; request_text: string }[]
const REQUEST = vectors.find((x) => x.kind === 'result')!.request_text
const click = (name: string | RegExp) => fireEvent.click(screen.getByRole('button', { name }))
const toAllocation = () => fireEvent.click(screen.getByRole('tab', { name: /Allocation/ }))
const choose = (text: () => Promise<string>) => {
  const input = screen.getByLabelText('Import hand-off request')
  Object.defineProperty(input, 'files', { value: [{ name: 'request.json', text }], configurable: true })
  fireEvent.change(input)
}
const settle = () => act(async () => new Promise((r) => setTimeout(r, 20)))

describe('decision J — hand-off request, asynchronous steps', () => {
  it('TC-J-44 (Codex r3 #1) a request read that finishes after the sample was loaded imports nothing', async () => {
    const storage = new MemoryStorage()
    render(<App storage={storage} />)
    click('I understand')
    toAllocation()
    let finish!: (t: string) => void
    choose(() => new Promise<string>((r) => (finish = r)))
    click('Load sample deal') // a fresh page loses nothing, so the sample loads at once
    await act(async () => finish(REQUEST))
    await settle()
    expect(screen.queryByText(/^Imported hand-off /)).toBeNull()
    expect(storage.getItem(STORAGE_KEY) ?? '').not.toContain('ho_TCJ45')
  })

  it('TC-J-48 (Codex r3 #3) a restored request whose content no longer hashes to its saved hash is not shown or exported', async () => {
    const storage = new MemoryStorage()
    render(<App storage={storage} />)
    click('I understand')
    toAllocation()
    choose(() => Promise.resolve(REQUEST))
    await waitFor(() => expect(screen.getByTestId('handoff-request')).toBeTruthy())
    cleanup()
    const saved = storage.getItem(STORAGE_KEY)!
    // the first commitment doubled, both hashes left as they were
    storage.setItem(STORAGE_KEY, saved.replace('\\"commitment\\": \\"10000000\\"', '\\"commitment\\": \\"20000000\\"'))
    expect(storage.getItem(STORAGE_KEY)).not.toBe(saved)
    render(<App storage={storage} />)
    toAllocation()
    await screen.findByText('The saved request does not match its hash. Import it again.')
    expect(screen.queryByTestId('handoff-request')).toBeNull()
    expect((screen.getByRole('button', { name: 'Export result' }) as HTMLButtonElement).disabled).toBe(true)
    expect(screen.getByText('The saved request does not match its hash. Import it again.')).toBeTruthy()
  })

  it('TC-J-44 (Codex r3 #4) an export whose hash finishes after "Clear all data" downloads nothing and logs nothing', async () => {
    const created: Blob[] = []
    vi.spyOn(URL, 'createObjectURL').mockImplementation((b) => (created.push(b as Blob), 'blob:x'))
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined)
    const storage = new MemoryStorage()
    render(<App storage={storage} />)
    click('I understand')
    toAllocation()
    choose(() => Promise.resolve(REQUEST))
    // the import and the saved-request check have both finished: the export is available
    await waitFor(() => expect((screen.getByRole('button', { name: 'Export result' }) as HTMLButtonElement).disabled).toBe(false))
    const real = crypto.subtle.digest.bind(crypto.subtle)
    let finish!: () => void
    vi.spyOn(crypto.subtle, 'digest').mockImplementation(
      (alg, data) => new Promise((r) => (finish = () => r(real(alg as AlgorithmIdentifier, data as BufferSource)))),
    )
    click('Export result')
    click('Clear all data')
    click('Clear everything')
    await act(async () => finish())
    await settle()
    expect(created).toEqual([])
    expect(storage.getItem(STORAGE_KEY) ?? '').not.toContain('ho_TCJ45')
  })

  it('TC-J-22 (G3 v1.5.0) the reconciliation refund list names a refund-only flag, not an over-payment', () => {
    render(<App storage={new MemoryStorage()} />)
    click('I understand')
    const boxes = screen.getAllByLabelText('Paste CSV text (first line is the header)')
    const imports = screen.getAllByRole('button', { name: 'Import pasted text' })
    fireEvent.change(boxes[0], { target: { value: 'investor_id,name,reference,cash_due,refund_only\nd,Dee Moss,NW-004,20000,closed\ne,Eve Cole,NW-005,1000,' } })
    fireEvent.click(imports[0])
    fireEvent.change(boxes[1], { target: { value: 'transaction_id,date,amount,payer,reference\nT4,2026-10-06,20000,DEE MOSS,NW-004\nT5,2026-10-06,1500,EVE COLE,NW-005' } })
    fireEvent.click(imports[1])
    expect(screen.getByTestId('rec-refunds').textContent).toBe('Dee Moss: £20,000.00 (Refund only)Eve Cole: £500.00 (Over-paid)')
  })
})
