import { expect, test } from '@playwright/test'

test('home page shows Slack install success', async ({ page }) => {
  await page.goto('/?slack=installed&team=wevm')

  await expect(page.getByText('Tipbot installed for wevm', { exact: true })).toBeVisible()
  await expect(page.getByRole('link', { name: 'Add to Slack' })).toBeHidden()
})

test('home page opens Slack install flow', async ({ page }) => {
  await page.goto('/')

  await expect(page).toHaveTitle(/Tipbot/)
  await expect(page.getByRole('heading', { name: 'Tipbot' })).toBeVisible()
  await expect(page.locator('meta[name="slack-app-id"]')).toHaveAttribute(
    'content',
    process.env.PLAYWRIGHT_SLACK_APP_ID ?? '',
  )

  const addToSlack = page.getByRole('link', { name: 'Add to Slack' })
  await expect(addToSlack).toHaveAttribute('href', '/install/slack')

  await addToSlack.click()

  await page.waitForURL((url) => url.origin === process.env.PLAYWRIGHT_SLACK_URL)
  await expect(page.getByText('Sign in to Slack')).toBeVisible()
})
