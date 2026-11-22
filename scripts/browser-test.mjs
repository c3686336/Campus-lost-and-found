// Optional browser QA. Supply PLAYWRIGHT_MODULE if Playwright is outside this project.
// Application start and API/unit tests do not require Playwright.
import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createApp } from '../server.mjs';

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const directory = await mkdtemp(join(tmpdir(), 'campus-browser-'));
const output = resolve('test-results/browser');
await mkdir(output, { recursive: true });
let app, browser;
const errors = [], checks = [];
try {
  app = createApp({ dataDir: directory });
  await new Promise((done, reject) => { app.server.once('error', reject);app.server.listen(0, '127.0.0.1', done); });
  const base = `http://127.0.0.1:${app.server.address().port}`;
  browser = await chromium.launch({ headless: true, ...(process.env.BROWSER_EXECUTABLE ? { executablePath: process.env.BROWSER_EXECUTABLE } : {}) });
  const memberContext = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const adminContext = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const externalContext = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const member = await memberContext.newPage(), admin = await adminContext.newPage(), external = await externalContext.newPage();
  for (const page of [member,admin,external]) page.on('pageerror', error => errors.push(error.message));
  async function login(page, email = 'minji@kaist.ac.kr', password = 'CampusDemo!24') {
    await page.goto(base);
    await page.locator('form[data-form=login] [name=email]').fill(email);
    await page.locator('form[data-form=login] [name=password]').fill(password);
    await page.locator('[data-testid=login-button]').click();
    await page.locator('.shell').waitFor();
  }
  const nav = (page, id) => page.locator(`[data-action=nav][data-id="${id}"]`).first().click();
  const close = page => page.locator('#modal [data-action=close]').first().click();
  const submit = page => page.locator('#modal button[type=submit]').click();
  async function noOverflow(page) {
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), `Horizontal page overflow at ${page.viewportSize().width}px`);
  }

  await member.goto(base);
  await member.locator('form[data-form=login] [name=email]').fill('minji@kaist.ac.kr');
  await member.locator('form[data-form=login] [name=password]').fill('WrongPassword!24');
  await member.locator('[data-testid=login-button]').click();
  const loginError = member.locator('form[data-form=login] .form-error');
  await loginError.waitFor({ state: 'visible' });
  assert.equal(await loginError.textContent(), '이메일 또는 비밀번호가 올바르지 않습니다.');
  assert.equal(await member.locator('form[data-form=login] [name=email]').inputValue(), 'minji@kaist.ac.kr');
  assert.equal(await member.locator('.shell').count(), 0);
  assert.equal((await (await member.request.get(`${base}/api/session`)).json()).user, null);
  await member.screenshot({ path: join(output, 'login-error.png') });
  checks.push('invalid-password login retains visible feedback and denies access');

  await login(member);
  await member.screenshot({ path: join(output, 'desktop.png'), fullPage: true });
  await noOverflow(member);
  assert.ok(!await member.locator('body').textContent().then(text => text.includes('별 스티커')));
  checks.push('desktop login and private-field filtering');
  await member.locator('[data-testid=new-report]').click();
  await member.locator('#modal [name=name]').fill('브라우저 검수 지갑');
  await member.locator('#modal [name=category]').selectOption('지갑·카드');
  await member.locator('#modal [name=location]').fill('학술문화관');
  await member.locator('#modal [name=occurredTime]').fill('13:45');
  await member.locator('#modal [name=description]').fill('브라우저에서 등록한 분실 신고입니다.');
  await member.locator('#modal [name=image]').setInputFiles(resolve('public/icon-192.png'));
  await submit(member);
  await member.locator('#modal').waitFor({ state: 'hidden' });
  await nav(member,'mine');
  await member.locator('.item-card').filter({ hasText: '브라우저 검수 지갑' }).click();
  assert.ok((await member.locator('#modal').textContent()).includes('13:45'));
  await close(member);
  checks.push('report form with image and occurrence time');
  await nav(member, 'browse');
  await member.locator('.item-card').filter({ hasText: '습득물' }).filter({ hasText: '남색 장우산' }).click();
  await member.locator('[data-action=new-request]').click();
  await member.locator('#modal [name=identity]').fill('김민지, 브라우저 시연 사용자');
  await member.locator('#modal [name=evidence]').fill('손잡이 안쪽에 별 스티커');
  await member.locator('#modal [name=lostReportId]').selectOption('demo_lost_umbrella');
  await submit(member);
  await member.locator('#modal').waitFor({ state: 'hidden' });

  await login(admin,'admin@kaist.ac.kr');
  await nav(admin,'admin-requests');
  await admin.locator('[data-action=request-approve]').click();
  await admin.locator('#modal [name=pickupLocation]').fill('브라우저 검수 반환 창구');
  await submit(admin);
  await admin.locator('#modal').waitFor({ state: 'hidden' });
  await member.reload();
  await nav(member,'requests');
  assert.ok(!(await member.locator('.request-card').textContent()).includes('브라우저 검수 반환 창구'));
  await member.locator('[data-action=pickup]').click();
  await member.getByText('브라우저 검수 반환 창구',{ exact: true }).waitFor();
  await member.screenshot({ path: join(output,'pickup.png') });
  await close(member);
  await nav(admin,'activity');
  await admin.getByText('수령 장소 열람',{exact:true}).first().waitFor();
  await nav(admin,'admin-requests');
  await admin.locator('[data-action=handover]').click();
  await submit(admin);
  await admin.locator('#modal').waitFor({ state: 'hidden' });
  await member.reload();
  await nav(member,'mine');
  assert.ok((await member.locator('.item-card').filter({ hasText: '남색 장우산' }).textContent()).includes('찾았어요'));
  checks.push('request, administrator approval, audited pickup reveal, handover and linked lost closure');

  await nav(admin,'admin-items');
  await admin.locator('[data-action=detail][data-id=demo_found_umbrella]').click();
  await admin.locator('#modal [data-action=report-error]').click();
  await admin.locator('#modal [name=reason]').fill('오인도 정정 검수');
  await submit(admin);
  await admin.locator('#modal').waitFor({ state: 'hidden' });
  await admin.locator('[data-action=detail][data-id=demo_found_umbrella]').click();
  await admin.locator('#modal [data-action=edit]').click();
  await admin.locator('#modal [name=name]').fill('오인도 처리 중 정정한 우산');
  await submit(admin);
  await admin.locator('#modal').waitFor({ state: 'hidden' });
  await admin.locator('[data-action=detail][data-id=demo_found_umbrella]').click();
  assert.equal(await admin.locator('#modal-title').textContent(), '오인도 처리 중 정정한 우산');
  await admin.locator('#modal [data-action=resolve]').waitFor();
  const incidentData = await (await admin.request.get(`${base}/api/data`)).json();
  const incidentItem = incidentData.items.find(item => item.id === 'demo_found_umbrella');
  assert.equal(incidentItem.blocked, true);
  assert.equal(incidentItem.state, 'Recovered');
  await admin.screenshot({ path: join(output, 'incident-correction.png') });
  await close(admin);
  await member.reload();
  await nav(member,'requests');
  assert.equal(await member.locator('[data-action=pickup]').count(), 0);
  checks.push('administrator correction during an unresolved incident preserves the user lock');

  await member.locator('[data-testid=new-report]').click();
  await member.locator('#modal [name=name]').fill('만료된 세션 신고');
  await member.locator('#modal [name=location]').fill('도서관');
  await member.locator('#modal [name=description]').fill('세션 만료 시 로그인 안내 검수');
  await member.request.post(`${base}/api/auth/logout`, { data: {} });
  await submit(member);
  await member.locator('form[data-form=login]').waitFor();
  await member.locator('#toast').filter({ hasText: '로그인이 필요합니다.' }).waitFor({ state: 'visible' });
  assert.equal(await member.locator('#modal').isVisible(), false);
  checks.push('expired-session form submission returns to login with visible feedback');
  await login(member);

  await nav(admin,'settings');
  await admin.locator('[name=storedDays]').fill('42');
  await admin.locator('h1').click();
  await admin.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  await admin.waitForResponse(response => response.url().endsWith('/api/data'));
  assert.equal(await admin.locator('[name=storedDays]').inputValue(),'42');
  await admin.locator('[data-action=backup]').click();
  await admin.getByText('암호화 백업을 생성했습니다.', { exact: true }).waitFor();
  checks.push('background draft preservation and manual backup');

  await external.goto(base);
  await noOverflow(external);
  await external.locator('[data-action=register]').click();
  await external.locator('#modal [name=name]').fill('외부 검수 사용자');
  await external.locator('#modal [name=email]').fill('browser@example.com');
  await external.locator('#modal [name=password]').fill('BrowserPass!24');
  await external.locator('#modal [name=document]').setInputFiles(resolve('public/icon-192.png'));
  await submit(external);
  await external.locator('#modal').waitFor({ state:'hidden' });
  await external.locator('form[data-form=login] [name=email]').fill('browser@example.com');
  await external.locator('form[data-form=login] [name=password]').fill('BrowserPass!24');
  await external.locator('[data-testid=login-button]').click();
  await external.getByText('관리자 승인을 기다리고 있습니다.', { exact:true }).waitFor();
  await nav(admin,'admin-users');
  const userRow = admin.locator('tr').filter({ hasText:'browser@example.com' });
  await userRow.locator('[data-action=document]').click();
  await admin.locator('#modal img.document-image').waitFor();
  await close(admin);
  await userRow.locator('[data-action=user-approve]').click();
  await submit(admin);
  await admin.locator('#modal').waitFor({ state:'hidden' });
  await external.locator('[data-testid=login-button]').click();
  await external.locator('.shell').waitFor();
  await noOverflow(external);
  await external.screenshot({ path:join(output,'mobile.png'),fullPage:true });
  await external.locator('[data-testid=new-report]').click();
  await external.locator('#modal [name=name]').fill('모바일 입력 확인');
  await external.screenshot({ path:join(output,'mobile-form.png') });
  await close(external);
  checks.push('external document registration, login denial until approval, administrator document review and approval');

  for (const width of [320,390,768]) { await member.setViewportSize({width,height:900});await noOverflow(member); }
  await member.evaluate(async () => { await navigator.serviceWorker.ready; });
  await member.waitForFunction(() => Boolean(navigator.serviceWorker.controller));
  await memberContext.setOffline(true);
  await member.reload();
  await member.getByText('오프라인입니다. 연결 후 다시 시도해 주세요. 변경사항은 전송되지 않습니다.',{exact:true}).waitFor();
  const cached = await member.evaluate(async () => {
    const keys = await caches.keys();
    return (await Promise.all(keys.filter(key=>key.startsWith('campus-shell-')).map(async key => (await (await caches.open(key)).keys()).map(r=>new URL(r.url).pathname)))).flat();
  });
  assert.ok(cached.includes('/app.js'));
  assert.ok(!cached.some(path=>path.startsWith('/api/')));
  checks.push('320/390/768px width checks and offline shell with no cached API data');
  assert.deepEqual(errors,[]);
  const report = { browser: await browser.version(), checks, pageErrors:errors, screenshotDirectory:output };
  await writeFile(join(output,'report.json'),JSON.stringify(report,null,2));
  console.log(JSON.stringify(report,null,2));
} finally {
  await browser?.close();
  await app?.close();
  await rm(directory,{recursive:true,force:true});
}
