// PRD v0.9, decision J (Test Plan E2E-12, E2E-13, 〔M7〕).
import { readFileSync } from 'node:fs'
import { expect, test, type Page } from '@playwright/test'
import { watchConsole } from './helpers'

const ROSTER = [
  'investor_id,name,reference,cash_due,own_fee_mode,own_fee_rate,own_fee_fixed,carry,refunded,refund_only',
  'a,Ada Lane,NW-001,104000,on_top,4,,20,,',
  'b,Ben Park,NW-002,100000,deducted,,250,0,,',
  'c,Cai Ross,NW-003,50000,,,,10,1000,',
  'd,Dee Moss,NW-004,20000,,,,,,closed',
].join('\n')
const BANK = ['transaction_id,date,amount,payer,reference', 'T1,2026-10-05,104000,ADA LANE,NW-001', 'T2,2026-10-05,100000,BEN PARK,NW-002', 'T3,2026-10-06,51000,CAI ROSS,NW-003', 'T4,2026-10-06,20000,DEE MOSS,NW-004'].join('\n')

async function fresh(page: Page) {
  await page.goto('/')
  await page.getByRole('button', { name: 'I understand', exact: true }).click()
}
async function paste(page: Page, title: string, csv: string) {
  const box = page.locator('details.import', { has: page.getByText(title) })
  await box.locator('summary').click()
  await box.getByLabel('Paste CSV text (first line is the header)').fill(csv)
  await box.getByRole('button', { name: 'Import pasted text' }).click()
}
async function typeIn(page: Page, label: string, value: string) {
  const f = page.getByRole('textbox', { name: label, exact: true })
  await f.fill(value)
  await f.blur()
}

for (const width of [1280, 375]) {
  test(`E2E-12 at ${width}px own terms, refunds and a refund-only flag go through reconciliation, a pro-rata platform fee, and per-investor carry with two payees`, async ({ page }) => {
    const problems = watchConsole(page)
    await page.setViewportSize({ width, height: 900 })
    await fresh(page)
    await paste(page, 'Import investors (replaces the list)', ROSTER)
    await paste(page, 'Import bank statement', BANK)
    await expect(page.locator('[data-status="d"]')).toContainText('Closed — refund only')
    await expect(page.locator('[data-status="c"]')).toContainText('Paid in full') // £51,000 booked − £1,000 refunded = £50,000 due
    // the refund list names the refund-only flag, not an over-payment (G3 v1.5.0 walkthrough)
    await expect(page.getByTestId('rec-refunds')).toHaveText('Dee Moss: £20,000.00 (Refund only)')
    await page.getByRole('button', { name: 'Hand off to allocation' }).click()

    await page.getByRole('tab', { name: /Allocation/ }).click()
    await typeIn(page, 'Share price', '1')
    await page.getByRole('button', { name: 'Add a pro-rata platform fee' }).click()
    await typeIn(page, 'Platform fee rate', '2.5')
    await typeIn(page, 'Platform fee minimum', '40')
    await expect(page.getByTestId('platform-payer-note')).toHaveText("This changes each investor's amount invested. Get their consent as your process requires.")
    await expect(page.getByTestId('excess')).toContainText('Dee Moss: £20,000.00 (refund only)')
    await expect(page.locator('dl.totals')).toContainText('Pro-rata platform fee (investors)')

    // the confirmation names the own fees and the platform fee (TC-J-50)
    const allocFile = page.waitForEvent('download')
    await page.getByRole('button', { name: 'Export allocation CSV' }).click()
    const allocHead = readFileSync(await (await allocFile).path(), 'utf8').split(/\r?\n/)[0]
    expect(allocHead.endsWith(',own_fee_mode,own_fee_rate,own_fee_fixed,own_fee,carry,platform_fee,currency')).toBe(true)
    await page.getByRole('button', { name: 'Hand off to exit distribution' }).click()
    await page.getByRole('tab', { name: /Exit distribution/ }).click()
    await page.getByRole('heading', { name: /^Holdings \(3\)/ }).click() // the section starts closed after a hand-off
    await expect(page.getByRole('textbox', { name: 'Holding 1 carry' })).toHaveValue('20.00')
    // the holdings export keeps each person's carry, 0% included (Codex M7 #2, #7)
    const holdingsFile = page.waitForEvent('download')
    await page.getByRole('button', { name: 'Export holdings CSV' }).click()
    const holdingsCsv = readFileSync(await (await holdingsFile).path(), 'utf8').split(/\r?\n/)
    expect(holdingsCsv[0].endsWith(',carry,currency')).toBe(true)
    expect(holdingsCsv.slice(1, 4).map((l) => l.split(',').at(-2))).toEqual(['20.00', '0.00', '10.00'])
    await typeIn(page, 'Exit proceeds', '1000000')
    await typeIn(page, 'Years held', '1')
    await typeIn(page, 'Carry rate', '20')
    await expect(page.getByRole('table', { name: 'Per-investor waterfall' })).toBeVisible()
    // with different carry rates, multiples differ, and the page says so (G3 v1.5.0 walkthrough)
    await expect(page.getByText(/carry comes off at each investor’s own rate, so multiples can differ/)).toBeVisible()
    for (const [i, [name, share]] of [['Lead A', '70'], ['Lead B', '30']].entries()) {
      await page.getByRole('button', { name: 'Add payee' }).click()
      await typeIn(page, `Payee ${i + 1} name`, name)
      await typeIn(page, `Payee ${i + 1} share`, share)
    }
    await expect(page.getByRole('list', { name: 'Carry by payee' })).toContainText('Lead A')
    if (width === 375) expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(375)
    expect(problems).toEqual([])
  })
}

test('E2E-13 import an allocation hand-off request, export the result file, and an input edit disables the export', async ({ page }) => {
  const problems = watchConsole(page)
  const vectors = JSON.parse(readFileSync('docs/formats/allocation-handoff-v1.vectors.json', 'utf8')).vectors as { kind: string; request_text: string; expected_result: unknown }[]
  const v = vectors.find((x) => x.kind === 'result')!
  await fresh(page)
  await page.getByRole('tab', { name: /Allocation/ }).click()
  await page.getByLabel('Import hand-off request').setInputFiles({ name: 'request.json', mimeType: 'application/json', buffer: Buffer.from(v.request_text) })
  await expect(page.getByText(/^Imported hand-off /)).toBeVisible()
  const download = page.waitForEvent('download')
  await page.getByRole('button', { name: 'Export result' }).click()
  const file = await (await download).path()
  expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual(v.expected_result)
  await typeIn(page, 'Round cap', '1')
  await expect(page.getByRole('button', { name: 'Export result' })).toBeDisabled()
  expect(problems).toEqual([])
})
