import { expect, test } from '@playwright/test'

test('home page opens Slack install flow', async ({ page }) => {
  await page.route('**/slack/install', async (route) => {
    await route.fulfill({
      body: 'Slack install started',
      contentType: 'text/plain',
      status: 200,
    })
  })

  await page.goto('/')

  await expect(page).toHaveTitle(/Tipbot/)
  await expect(page.getByRole('heading', { name: 'Tipbot' })).toBeVisible()

  const addToSlack = page.getByRole('link', { name: 'Add to Slack' })
  await expect(addToSlack).toHaveAttribute('href', '/slack/install')

  await addToSlack.click()

  await expect(page).toHaveURL('/slack/install')
  await expect(page.getByText('Slack install started')).toBeVisible()
})
