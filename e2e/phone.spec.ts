// M-10 on a real iPhone (2026-11-26): focusing a field under 16px made iOS zoom the page and keep it zoomed.
// Emulated touch phone.
import { expect, test } from '@playwright/test'

test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true })

test('E2E-07 touch phone: no field is under 16px, so iOS does not zoom the page on focus', async ({ page }) => {
  await page.goto('/')
  const btn = page.getByRole('button', { name: 'I understand', exact: true })
  await expect(btn).toBeVisible()
  await btn.click()
  await page.getByRole('button', { name: 'Load sample deal' }).click()
  for (const tab of [/Reconciliation/, /Allocation/, /Exit distribution/]) {
    await page.getByRole('tab', { name: tab }).click()
    const small = await page.evaluate(() =>
      [...document.querySelectorAll('input:not([type=radio]):not([type=checkbox]), select, textarea')]
        .filter((e) => parseFloat(getComputedStyle(e).fontSize) < 16)
        .map((e) => e.getAttribute('aria-label') ?? e.tagName),
    )
    expect(small).toEqual([])
    // larger fields must not make the page itself scroll sideways (tables scroll inside their own box)
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390)
  }
})
