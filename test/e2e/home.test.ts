import { expect, test } from '@playwright/test'

test('home page opens Slack install flow', async ({ page }) => {
  await page.goto('/')

  await expect(page).toHaveTitle(/Tipbot/)
  await expect(page.getByRole('heading', { name: 'Tipbot' })).toBeVisible()

  const addToSlack = page.getByRole('link', { name: 'Add to Slack' })
  await expect(addToSlack).toHaveAttribute('href', '/api/chat/slack/install')

  await addToSlack.click()

  await page.waitForURL((url) => url.origin === process.env.PLAYWRIGHT_SLACK_URL)
  await expect(page.getByText('Sign in to Slack')).toBeVisible()
})
