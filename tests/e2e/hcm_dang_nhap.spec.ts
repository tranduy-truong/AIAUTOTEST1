import { test, expect } from '@playwright/test';

const E2E_CONFIG = {
  baseUrl: process.env.E2E_BASE_URL?.replace(/\/$/, ''),
  username: process.env.E2E_USERNAME,
  password: process.env.E2E_PASSWORD,
  wrongUsername: process.env.E2E_WRONG_USERNAME,
  wrongPassword: process.env.E2E_WRONG_PASSWORD,
  caseUsername: process.env.E2E_CASE_USERNAME,
};

test.describe('Đăng nhập', () => {
  test.beforeEach(() => {
    test.skip(
      Object.values(E2E_CONFIG).some(value => !value),
      'Thiếu cấu hình E2E trong file .env',
    );
  });

  test('TC_01 - Đăng nhập thành công với tài khoản hợp lệ', async ({ page }) => {
    await page.goto(`${E2E_CONFIG.baseUrl}/dang-nhap`);
    await page.getByPlaceholder('Nhập tên đăng nhập').fill(E2E_CONFIG.username!);
    await page.getByPlaceholder('Nhập mật khẩu').fill(E2E_CONFIG.password!);
    await page.getByRole('button', { name: 'Đăng nhập' }).click();
    await expect(page).not.toHaveURL(/.*(dang-nhap|login).*/i);
  });

  test('TC_02 - Đăng nhập thất bại vì sai mật khẩu', async ({ page }) => {
    await page.goto(`${E2E_CONFIG.baseUrl}/dang-nhap`);
    await page.getByPlaceholder('Nhập tên đăng nhập').fill(E2E_CONFIG.username!);
    await page.getByPlaceholder('Nhập mật khẩu').fill(E2E_CONFIG.wrongPassword!);
    await page.getByRole('button', { name: 'Đăng nhập' }).click();
    await expect(page.getByText('Thông tin đăng nhập không chính xác hoặc tài khoản không còn hoạt động.')).toBeVisible();
  });

  test('TC_03 - Đăng nhập thất bại vì sai username', async ({ page }) => {
    await page.goto(`${E2E_CONFIG.baseUrl}/dang-nhap`);
    await page.getByPlaceholder('Nhập tên đăng nhập').fill(E2E_CONFIG.wrongUsername!);
    await page.getByPlaceholder('Nhập mật khẩu').fill(E2E_CONFIG.password!);
    await page.getByRole('button', { name: 'Đăng nhập' }).click();
    await expect(page.getByText('Thông tin đăng nhập không chính xác hoặc tài khoản không còn hoạt động.')).toBeVisible();
  });

  test('TC_04 - Đăng nhập thất bại vì bỏ trống mật khẩu', async ({ page }) => {
    await page.goto(`${E2E_CONFIG.baseUrl}/dang-nhap`);
    await page.getByPlaceholder('Nhập tên đăng nhập').fill(E2E_CONFIG.username!);
    await page.getByRole('button', { name: 'Đăng nhập' }).click();
    await expect(page.getByText('Vui lòng nhập mật khẩu')).toBeVisible();
  });

  test('TC_05 - Đăng nhập thất bại vì bỏ trống username', async ({ page }) => {
    await page.goto(`${E2E_CONFIG.baseUrl}/dang-nhap`);
    await page.getByPlaceholder('Nhập mật khẩu').fill(E2E_CONFIG.password!);
    await page.getByRole('button', { name: 'Đăng nhập' }).click();
    await expect(page.getByText('Vui lòng nhập tên đăng nhập')).toBeVisible();
  });

  test('TC_06 - Đăng nhập thất bại vì sai username (Test chữ hoa)', async ({ page }) => {
    await page.goto(`${E2E_CONFIG.baseUrl}/dang-nhap`);
    await page.getByPlaceholder('Nhập tên đăng nhập').fill(E2E_CONFIG.caseUsername!);
    await page.getByPlaceholder('Nhập mật khẩu').fill(E2E_CONFIG.password!);
    await page.getByRole('button', { name: 'Đăng nhập' }).click();
    await expect(page.getByText('Thông tin đăng nhập không chính xác hoặc tài khoản không còn hoạt động.')).toBeVisible();
  });

  test('TC_07 - Đăng nhập thất bại vì bỏ trống cả 2 trường', async ({ page }) => {
    await page.goto(`${E2E_CONFIG.baseUrl}/dang-nhap`);
    await page.getByRole('button', { name: 'Đăng nhập' }).click();
    await expect(page.getByText('Vui lòng nhập tên đăng nhập')).toBeVisible();
    await expect(page.getByText('Vui lòng nhập mật khẩu')).toBeVisible();
  });

  test('TC_08 - Kiểm tra tính năng ẩn/hiện mật khẩu', async ({ page }) => {
    await page.goto(`${E2E_CONFIG.baseUrl}/dang-nhap`);
    const password = page.getByPlaceholder('Nhập mật khẩu');
    const eyeButton = page.locator('.lucide-eye, .lucide-eye-off, [data-align="inline-end"], [class*="eye"]').first();

    await password.fill(E2E_CONFIG.password!);
    await expect(password).toHaveAttribute('type', 'password');
    await expect(password).toHaveValue(E2E_CONFIG.password!);

    await eyeButton.click();
    await expect(password).toHaveAttribute('type', 'text');
    await expect(password).toHaveValue(E2E_CONFIG.password!);

    await eyeButton.click();
    await expect(password).toHaveAttribute('type', 'password');
    await expect(password).toHaveValue(E2E_CONFIG.password!);
  });

  test('TC_09 - Xử lý khoảng trắng thừa ở Username', async ({ page }) => {
    await page.goto(`${E2E_CONFIG.baseUrl}/dang-nhap`);
    await page.getByPlaceholder('Nhập tên đăng nhập').fill(` ${E2E_CONFIG.username} `);
    await page.getByPlaceholder('Nhập mật khẩu').fill(E2E_CONFIG.password!);
    await page.getByRole('button', { name: 'Đăng nhập' }).click();
    await expect(page).not.toHaveURL(/.*(dang-nhap|login).*/i);
  });

  test('TC_10 - Kiểm tra chống tấn công SQL Injection', async ({ page }) => {
    await page.goto(`${E2E_CONFIG.baseUrl}/dang-nhap`);
    await page.getByPlaceholder('Nhập tên đăng nhập').fill("OR '1'='1");
    await page.getByPlaceholder('Nhập mật khẩu').fill("OR '1'='1");
    await page.getByRole('button', { name: 'Đăng nhập' }).click();
    await expect(page.getByText('Thông tin đăng nhập không chính xác hoặc tài khoản không còn hoạt động.')).toBeVisible();
  });
});
