#!/usr/bin/env node
// Usage: ui.mjs <outdir> [app-url]
// Drives the dev app in headless Chromium as the guest user:
//   1. Settings: sets and clears Claude Code, Codex (API key), OpenCode, and GitHub, checking the
//      status line after each, then creates and deletes a personal access token.
//   2. Sets OpenCode and GitHub for real, starts a flash agent from the New agent form, and waits
//      on the agent page until the live timeline shows "Agent succeeded" and the pull request link.
// Env: OPENCODE_API_KEY and GH_TOKEN (real values), PLAYWRIGHT (path to the playwright package,
// default "playwright"). Writes screenshots and ui-values.json (the dummy values typed, for leak greps).
import { writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';

const [out, app = 'http://localhost:3000'] = process.argv.slice(2);
const playwright = await import(process.env.PLAYWRIGHT ?? 'playwright');
const chromium = playwright.chromium ?? playwright.default.chromium;
const { OPENCODE_API_KEY, GH_TOKEN } = process.env;
if (!out || !OPENCODE_API_KEY || !GH_TOKEN) {
  console.error(
    'usage: OPENCODE_API_KEY=… GH_TOKEN=… ui.mjs <outdir> [app-url]',
  );
  process.exit(2);
}

function check(ok, message) {
  if (!ok) throw new Error(`FAIL ${message}`);
  console.log(`ok ${message}`);
}

const dummy = name => `ui-${name}-${randomBytes(12).toString('hex')}`;
const values = { claude: dummy('claude'), codex: dummy('codex') };
writeFileSync(`${out}/ui-values.json`, JSON.stringify(values));

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1400, height: 1000 } });
const shot = name =>
  page.screenshot({ path: `${out}/${name}.png`, fullPage: true });

try {
  await page.goto(`${app}/cloud-agents/settings`);
  const enter = page.getByRole('button', { name: /enter/i });
  const settings = page.getByText('Personal access tokens');
  await enter.or(settings).first().waitFor({ timeout: 60000 });
  if (await enter.isVisible()) await enter.click();
  await settings.waitFor({ timeout: 30000 });

  const card = title =>
    page
      .locator('form', { has: page.getByLabel(`${title} value`) })
      .locator('xpath=ancestor::div[contains(@class,"MuiCard-root")]');
  async function setCredential(title, value, expected) {
    await page.getByLabel(`${title} value`).fill(value);
    await card(title).getByRole('button', { name: 'Save' }).click();
    await card(title).getByText(expected).waitFor({ timeout: 15000 });
    check(true, `${title}: set, status shows "${expected}"`);
  }
  async function clearCredential(title, expected) {
    await card(title).getByRole('button', { name: 'Clear' }).click();
    await card(title)
      .getByText(expected, { exact: true })
      .waitFor({ timeout: 15000 });
    check(true, `${title}: cleared, status shows "${expected}"`);
  }

  for (const [title, unsetText] of [
    ['Claude Code', 'Not set'],
    ['Codex', 'Not set'],
    ['OpenCode Go', 'Not set'],
    ['GitHub', 'Not connected'],
  ]) {
    if (await card(title).getByRole('button', { name: 'Clear' }).isEnabled())
      await clearCredential(title, unsetText);
    else check(true, `${title}: starts unset`);
  }
  await setCredential('Claude Code', values.claude, /^Set/);
  await page.getByRole('radio', { name: 'API key' }).check();
  await setCredential('Codex', values.codex, /^Set as OpenAI API key/);
  await setCredential('OpenCode Go', OPENCODE_API_KEY, /^Set/);
  await setCredential('GitHub', GH_TOKEN, /^Connected as /);
  await shot('settings-all-set');
  check(
    !(await page.content()).includes(OPENCODE_API_KEY),
    'the page never shows a stored value',
  );
  await clearCredential('Claude Code', 'Not set');
  await clearCredential('Codex', 'Not set');
  await clearCredential('OpenCode Go', 'Not set');
  await clearCredential('GitHub', 'Not connected');
  await shot('settings-all-cleared');

  await page.getByLabel('Token name').fill('ui-check');
  await page.getByRole('button', { name: 'Create token' }).click();
  const token = await page.getByTestId('new-token').textContent();
  check(
    /^cat_/.test(token ?? ''),
    'a new token is shown once and starts with cat_',
  );
  await page.getByRole('button', { name: 'Delete token ui-check' }).click();
  await page
    .getByRole('button', { name: 'Delete token ui-check' })
    .waitFor({ state: 'detached' });
  check(true, 'the token is deleted');

  await setCredential('OpenCode Go', OPENCODE_API_KEY, /^Set/);
  await setCredential('GitHub', GH_TOKEN, /^Connected as /);

  await page.getByRole('tab', { name: 'New agent' }).click();
  const stamp = new Date().toISOString().replace(/\D/g, '').slice(0, 14);
  await page
    .getByLabel('Repository')
    .fill('alaborderie/cloud-agent-runner-sandbox');
  await page.getByLabel('Title').fill(`UI e2e ${stamp}`);
  await page
    .getByLabel('Prompt')
    .fill(
      `Create the file ui-e2e-${stamp}.txt containing "hello from the cloud-agents UI". Commit it, push the current branch, open a pull request against main with \`gh pr create --fill --base main\`, and reply with its URL.`,
    );
  await page.getByRole('button', { name: 'Start agent' }).click();
  await page.waitForURL(/\/cloud-agents\/agents\/ag_/, { timeout: 30000 });
  const agentUrl = page.url();
  console.log(`agent page ${agentUrl}`);
  await page.getByText(/Workspace ready/).waitFor({ timeout: 120000 });
  await shot('agent-running');
  check(true, 'the live timeline shows runner events while the agent runs');
  await page.getByText('Agent succeeded').waitFor({ timeout: 900000 });
  const prLink = page.locator('a[href*="/pull/"]').first();
  await prLink.waitFor({ timeout: 30000 });
  const prUrl = await prLink.getAttribute('href');
  await shot('agent-succeeded');
  check(
    /github\.com\/.+\/pull\/\d+/.test(prUrl ?? ''),
    `the agent shows its pull request ${prUrl}`,
  );
  writeFileSync(`${out}/ui-agent.json`, JSON.stringify({ agentUrl, prUrl }));

  await page.getByRole('tab', { name: 'Agents' }).click();
  await page.getByText(`UI e2e ${stamp}`).waitFor({ timeout: 15000 });
  await shot('agents-list');
  check(true, 'the agents list shows the agent');
} catch (error) {
  await shot('failure').catch(() => {});
  console.error(error.message);
  process.exitCode = 1;
} finally {
  await browser.close();
}
