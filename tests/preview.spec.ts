import { expect, test } from '@playwright/test';

test('browser preview cannot pretend native recording or model saving succeeded', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto('/');
  await expect(page.getByText('浏览器预览', { exact: false })).toBeVisible();
  await expect(page.getByRole('button', { name: '开始录音', exact: true })).toBeDisabled();
  await page.getByRole('button', { name: '模型服务', exact: true }).click();
  await expect(page.getByRole('button', { name: '保存模型设置', exact: true })).toBeDisabled();
  await expect(page.getByRole('button', { name: '下载 SenseVoice 模型', exact: true })).toBeDisabled();
  await page.getByRole('button', { name: '偏好设置', exact: true }).click();
  await expect(page.getByRole('button', { name: '保存偏好设置', exact: true })).toBeDisabled();
  expect(errors).toEqual([]);
});

test('editing a result survives visiting model settings without saving it to browser storage', async ({ page }) => {
  await page.goto('/');
  const draft = '请帮我整理本周计划：先验证离线识别，再测试云端润色。';
  await page.getByRole('button', { name: '＋ 手动输入', exact: true }).click();
  const editor = page.getByRole('textbox', { name: '听写文字，可编辑' });
  await editor.fill(draft);
  await page.getByRole('button', { name: '模型服务', exact: true }).click();
  await page.getByRole('button', { name: '工作台', exact: true }).click();
  await expect(editor).toHaveValue(draft);
  await page.reload();
  await expect(page.getByRole('textbox', { name: '听写文字，可编辑' })).toHaveCount(0);
});

test('minimum desktop window remains navigable without horizontal overflow', async ({ page }) => {
  await page.setViewportSize({ width: 880, height: 640 });
  await page.goto('/');
  for (const destination of ['模型服务', '偏好设置', '工作台']) {
    await page.getByRole('button', { name: destination, exact: true }).click();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  }
});

test.describe('Windows platform preview', () => {
  test.use({ userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36' });

  test('shows Windows shortcuts and no macOS permission panel', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('kbd')).toHaveText('Ctrl + Shift + 空格');
  await page.getByRole('button', { name: '偏好设置', exact: true }).click();
  await expect(page.getByText('macOS 跨应用输入需要辅助功能权限')).toHaveCount(0);
  await expect(page.getByText(/Ctrl、Alt、Shift 或 Win 修饰键/)).toBeVisible();
  const recorder = page.getByRole('button', { name: '全局录音快捷键：Ctrl + Shift + 空格', exact: true });
  await recorder.click();
  await page.keyboard.press('Control+Shift+KeyJ');
  await expect(page.getByRole('button', { name: '全局录音快捷键：Ctrl + Shift + J', exact: true })).toBeVisible();
  });
});
