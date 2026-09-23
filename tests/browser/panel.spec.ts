import { test, expect, type Page } from '@playwright/test';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
async function api(page: Page, url: string, method = 'GET', body?: any) {
  return page.evaluate(async ({ url, method, body }) => {
    const me = await fetch('/api/me').then(r => r.json());
    const response = await fetch(`/api${url}`, { method, headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': me.csrf }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: response.status, data: await response.json() };
  }, { url, method, body });
}
test('agent panel switches models, resets conversations, and excludes the active document', async ({ page }) => {
  await page.goto('/'); await page.getByLabel('Username', { exact: true }).fill('admin'); await page.getByLabel('Password', { exact: true }).fill('ed-test-password-2026'); await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page.locator('#menu-button')).toBeVisible();
  const original = (await api(page, '/settings')).data;
  const dir = await mkdtemp(path.join(os.tmpdir(), 'garnet-panel-')); const executable = path.join(dir, 'agent');
  await writeFile(executable, `#!${process.execPath}
if (process.argv.includes('app-server') || process.argv.includes('--input-format')) process.exit(0);
process.stdin.resume(); process.stdin.on('end', () => {
  console.log(JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'Selected model: ' + process.argv[process.argv.indexOf('--model') + 1] } }));
});
`, { mode: 0o700 });
  const configured = { ...original, agent: { ...original.agent, provider: 'claude', claudePath: executable, codexPath: executable, claudeModel: 'claude-default', codexModel: 'codex-default' } };
  try {
    expect((await api(page, '/settings', 'PUT', configured)).status).toBe(200);
    await page.route('**/api/agent-models', route => {
      const { provider } = route.request().postDataJSON();
      return route.fulfill({ json: { models: [{ id: `${provider}-one`, name: `${provider} One` }, { id: `${provider}-two`, name: `${provider} Two` }] } });
    });
    await page.locator('#menu-button').click(); await page.locator('#new-doc').click();
    await expect(page.getByLabel('Document title')).toHaveValue('Untitled'); await page.getByLabel('Document title').fill('Panel context one');
    const first = new URL(page.url()).hash.slice(1);
    await page.keyboard.press('Alt+n'); await expect(page).not.toHaveURL(new RegExp(`${first}$`));
    await expect(page.getByLabel('Document title')).toHaveValue('Untitled'); await page.getByLabel('Document title').fill('Panel context two');
    const second = new URL(page.url()).hash.slice(1);
    await page.locator('.ai-button').click();
    await expect(page.locator('#new-chat')).toHaveCount(0);
    await expect(page.locator('#ai-model option')).toHaveCount(3);
    await expect(page.locator('#ai-model option').first()).toHaveText('Default · claude-default');
    await expect(page.locator(`#ai-scope option[value="${second}"]`)).toHaveCount(0);
    await expect(page.locator(`#ai-scope option[value="${first}"]`)).toHaveCount(1);
    await page.locator('#menu-button').click(); await page.locator(`[data-id="${first}"]`).click();
    await expect(page.locator(`#ai-scope option[value="${first}"]`)).toHaveCount(0);
    await expect(page.locator(`#ai-scope option[value="${second}"]`)).toHaveCount(1);
    await expect(page.locator('#ai-scope')).toHaveValue('current');
    const send = async (message: string, expected: string) => {
      await page.locator('#ai-prompt').fill(message); await page.locator('#send-prompt').click();
      await expect(page.locator('#ai-status')).toHaveText('completed');
      await expect(page.locator('.agent-message').last()).toHaveText(`Selected model: ${expected}`);
      return page.locator('#conversation').inputValue();
    };
    await page.locator('#ai-model').selectOption('claude-two');
    const claudeConversation = await send('Claude override', 'claude-two');
    let jobs = (await api(page, `/conversations/${claudeConversation}/jobs`)).data;
    expect(jobs[0].model).toBe('claude-two'); expect(jobs[0].modelOverride).toBe('claude-two'); expect(jobs[0].docId).toBe(first);
    await expect(page.locator('#ai-provider')).toBeDisabled();
    await page.locator('#conversation').selectOption('');
    await expect(page.locator('#ai-transcript')).toBeEmpty(); await expect(page.locator('#ai-status')).toBeEmpty();
    await expect(page.locator('#ai-provider')).toBeEnabled(); await expect(page.locator('#ai-prompt')).toBeFocused();
    await page.locator('#ai-provider').selectOption('codex');
    await expect(page.locator('#ai-model option[value=codex-one]')).toHaveCount(1);
    await expect(page.locator('#ai-model option[value=claude-two]')).toHaveCount(0);
    await page.locator('#ai-model').selectOption('codex-one');
    await send('Codex override', 'codex-one');
    await page.locator('#ai-model').selectOption('');
    const codexConversation = await send('Configured default on follow-up', 'codex-default');
    jobs = (await api(page, `/conversations/${codexConversation}/jobs`)).data;
    expect(jobs.map((j: any) => j.model)).toEqual(['codex-one', 'codex-default']);
    expect((await api(page, '/settings')).data.agent).toEqual(configured.agent);
    await page.locator('#conversation').selectOption(claudeConversation);
    await expect(page.locator('#ai-provider')).toHaveValue('claude'); await expect(page.locator('#ai-model')).toHaveValue('claude-two');
    await expect(page.locator('.agent-message')).toHaveText('Selected model: claude-two');
    await page.screenshot({ path: 'test-results/agent-panel.png' });
    expect((await api(page, '/jobs', 'POST', { prompt: 'Invalid model', model: {} })).status).toBe(400);
  } finally { await api(page, '/settings', 'PUT', original); await rm(dir, { recursive: true, force: true }); }
});
