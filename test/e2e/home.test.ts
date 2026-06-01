import { expect, test } from './fixture.ts'

test('visitor starts slack install from the home page', async ({ app, page }) => {
  await page.goto(app.url({ to: '/' }))

  await expect(page).toHaveTitle(/Tipbot/)
  await expect(page.getByRole('heading', { name: 'Tipbot' })).toBeVisible()
  await expect(page.locator('meta[name="slack-app-id"]')).toHaveAttribute('content', app.slackAppId)

  const addToSlack = page.getByRole('link', { name: 'Add to Slack' })
  await expect(addToSlack).toHaveAttribute('href', '/install/slack')
  await expect(page.getByRole('link', { name: 'Connect X' })).toHaveAttribute('href', '/link/x')

  await addToSlack.click()

  await page.waitForURL((url) => url.origin === app.slackUrl)
  await expect(page.getByText('Sign in to Slack')).toBeVisible()
})

test('visitor returns after installing tipbot in slack', async ({ app, page }) => {
  await page.goto(app.url({ search: { slack: 'installed', team: 'wevm' }, to: '/' }))

  await expect(page.getByText('Installed for wevm', { exact: true })).toBeVisible()
  await expect(page.getByRole('link', { name: 'Add to Slack' })).toBeHidden()
  await expect(page.getByRole('link', { name: 'Connect X' })).toBeVisible()
})
