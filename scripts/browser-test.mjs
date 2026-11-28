// Optional browser QA. Supply PLAYWRIGHT_MODULE if Playwright is outside this project.
// Application start and API/unit tests do not require Playwright.
import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createApp } from '../server.mjs';

const engine = process.env.BROWSER_ENGINE || 'chromium';
assert.ok(['chromium', 'firefox', 'webkit'].includes(engine), `Unsupported BROWSER_ENGINE: ${engine}`);
const playwright = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const directory = await mkdtemp(join(tmpdir(), 'campus-browser-'));
const output = resolve('test-results/browser', engine);
await mkdir(output, { recursive: true });
let app, browser;
const errors = [], checks = [];
// Backdate the service clock, not records or page state, so retention can advance
// three days without waiting and finish aligned with the browser's real clock.
const present = new Date(), day = 86400000;
let clock = new Date(present.getTime() - 3 * day);
const reportDate = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Seoul' }).format(clock);
const check = (requirements, scenario) => checks.push({ requirements, scenario });
try {
  app = createApp({ dataDir: directory, now: () => new Date(clock) });
  await new Promise((done, reject) => { app.server.once('error', reject);app.server.listen(0, '127.0.0.1', done); });
  const base = `http://127.0.0.1:${app.server.address().port}`;
  browser = await playwright[engine].launch({ headless: true, ...(process.env.BROWSER_EXECUTABLE ? { executablePath: process.env.BROWSER_EXECUTABLE } : {}) });
  const memberContext = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const adminContext = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const externalContext = await browser.newContext({ viewport: { width: 390, height: 844 }, ...(engine === 'firefox' ? {} : { isMobile: true }), hasTouch: true });
  const finderContext = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const member = await memberContext.newPage(), admin = await adminContext.newPage(), external = await externalContext.newPage(), finder = await finderContext.newPage();
  for (const page of [member,admin,external,finder]) {
    page.setDefaultTimeout(10000);
    page.on('pageerror', error => errors.push(error.message));
  }
  async function login(page, email = 'minji@kaist.ac.kr', password = 'CampusDemo!24') {
    await page.goto(base);
    await page.locator('form[data-form=login] [name=email]').fill(email);
    await page.locator('form[data-form=login] [name=password]').fill(password);
    await page.locator('[data-testid=login-button]').click();
    await page.locator('.shell').waitFor();
  }
  const nav = async (page, id) => {
    const [response] = await Promise.all([
      page.waitForResponse(response => response.url() === `${base}/api/data` && response.request().method() === 'GET'),
      page.locator(`[data-action=nav][data-id="${id}"]`).filter({ visible: true }).first().click(),
    ]);
    await response.finished();
  };
  const close = page => page.locator('#modal [data-action=close]').first().click();
  const submit = page => page.locator('#modal button[type=submit]').click();
  async function noOverflow(page) {
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), `Horizontal page overflow at ${page.viewportSize().width}px`);
  }
  const data = async page => {
    const response = await page.request.get(`${base}/api/data`);
    assert.equal(response.status(), 200);
    return response.json();
  };
  async function createReport(page, kind, name, category, location) {
    await page.locator(`[data-action=report][data-id="${kind}"]`).filter({ visible: true }).first().click();
    await page.locator('#modal [name=name]').fill(name);
    await page.locator('#modal [name=category]').selectOption(category);
    await page.locator('#modal [name=location]').fill(location);
    await page.locator('#modal [name=date]').fill(reportDate());
    await page.locator('#modal [name=description]').fill(`${name} 공개 설명`);
    const [response] = await Promise.all([
      page.waitForResponse(response => response.url() === `${base}/api/items` && response.request().method() === 'POST'),
      submit(page),
    ]);
    assert.equal(response.status(), 201);
    const { item } = await response.json();
    await page.locator('#modal').waitFor({ state: 'hidden' });
    return item;
  }
  async function assertReadPair(page, openedId, untouchedId) {
    await page.locator(`.notification-row:not(.unread)[data-id="${openedId}"]`).waitFor();
    const notifications = (await data(page)).notifications;
    assert.equal(notifications.find(n => n.id === openedId)?.read, true);
    assert.equal(notifications.find(n => n.id === untouchedId)?.read, false);
    assert.equal(await page.locator(`.notification-row[data-id="${openedId}"].unread`).count(), 0);
    await page.locator(`.notification-row[data-id="${untouchedId}"].unread`).waitFor();
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
  check(['REQ-1.4'], '#5 invalid-password login retains feedback and denies access');

  await login(member);
  await member.screenshot({ path: join(output, 'desktop.png'), fullPage: true });
  await noOverflow(member);
  assert.ok(!await member.locator('body').textContent().then(text => text.includes('별 스티커')));
  check(['REQ-1.1','REQ-4.4'], 'desktop login and private-field filtering');
  await member.locator('[data-testid=new-report]').click();
  await member.locator('#modal [name=name]').fill('브라우저 검수 지갑');
  await member.locator('#modal [name=category]').selectOption('지갑·카드');
  await member.locator('#modal [name=location]').fill('학술문화관');
  await member.locator('#modal [name=date]').fill(reportDate());
  await member.locator('#modal [name=occurredTime]').fill('13:45');
  await member.locator('#modal [name=description]').fill('브라우저에서 등록한 분실 신고입니다.');
  await member.locator('#modal [name=image]').setInputFiles(resolve('public/icon-192.png'));
  await memberContext.setOffline(true);
  await submit(member);
  await member.locator('#modal .form-error').filter({ hasText: '인터넷 연결을 확인한 뒤 다시 시도해 주세요.' }).waitFor();
  assert.equal(await member.locator('#modal [name=name]').inputValue(), '브라우저 검수 지갑');
  assert.equal(await member.locator('#modal [name=occurredTime]').inputValue(), '13:45');
  await member.screenshot({ path: join(output, 'report-network-error.png') });
  await memberContext.setOffline(false);
  await member.waitForFunction(() => navigator.onLine);
  await submit(member);
  await member.locator('#modal').waitFor({ state: 'hidden' });
  await nav(member,'mine');
  await member.locator('.item-card').filter({ hasText: '브라우저 검수 지갑' }).click();
  assert.ok((await member.locator('#modal').textContent()).includes('13:45'));
  await close(member);
  check(['REQ-2.1','REQ-2.2','REQ-2.4','REQ-2.5'], 'report form with image and occurrence time');
  check(['REQ-2.4','SRS-3.4','SRS-5.4.2'], 'offline report submission shows connection feedback, preserves entered fields and permits real submission after reconnection');
  await nav(member, 'browse');
  await member.locator('.item-card').filter({ hasText: '습득물' }).filter({ hasText: '남색 장우산' }).click();
  await member.locator('[data-action=new-request]').click();
  assert.equal(await member.locator('#modal [name=identity]').inputValue(), '김민지 · minji@kaist.ac.kr');
  const editedIdentity = '김민지 · minji@kaist.ac.kr · 브라우저 검수 학번 20261234';
  await member.locator('#modal [name=identity]').fill(editedIdentity);
  await member.locator('#modal [name=evidence]').fill('손잡이 안쪽에 별 스티커');
  await member.locator('#modal [name=lostReportId]').selectOption('demo_lost_umbrella');
  await submit(member);
  await member.locator('#modal').waitFor({ state: 'hidden' });

  // A second report must discover an already-claimed item, not just a Stored one.
  const matchingLost = await createReport(member, 'lost', '반환 검토 중 우산 매칭 검수', '의류·잡화', '학술문화관');
  await nav(member, 'matches');
  const recoveryMatch = member.locator('.match-card').filter({ hasText: matchingLost.name });
  await recoveryMatch.locator('[data-action=detail][data-id=demo_found_umbrella]').waitFor();
  assert.equal((await data(member)).items.find(i => i.id === 'demo_found_umbrella').state, 'Recovery requested');
  await member.screenshot({ path: join(output, 'recovery-requested-match.png') });

  const memberNotifications = (await data(member)).notifications;
  const opened = memberNotifications.find(n => n.message.includes(matchingLost.name));
  const untouched = memberNotifications.find(n => n.id !== opened?.id && !n.read);
  assert.ok(opened && untouched, 'Two genuine match notifications are required');
  await nav(member, 'notifications');
  await member.locator(`.notification-row.unread[data-id="${opened.id}"]`).focus();
  await member.keyboard.press('Enter');
  await member.locator('#modal').waitFor({ state: 'visible' });
  await close(member);
  await assertReadPair(member, opened.id, untouched.id);
  await member.reload();
  await nav(member, 'notifications');
  await assertReadPair(member, opened.id, untouched.id);
  await member.screenshot({ path: join(output, 'notification-single-read.png') });
  check(['REQ-5.3','REQ-4.3'], '#28 keyboard-opening one of two real notifications persists only its read state across reload');

  await login(finder, 'finder@kaist.ac.kr');
  const ownLost = await createReport(finder, 'lost', '동일 신고자 우산 매칭 제외 검수', '의류·잡화', '학술문화관');
  await nav(finder, 'matches');
  assert.equal(await finder.locator('.match-card').filter({ hasText: ownLost.name }).count(), 0);
  const finderData = await data(finder);
  assert.ok(!finderData.matches.some(m => m.lostId === ownLost.id));
  assert.ok(!finderData.notifications.some(n => n.message.includes(ownLost.name)));
  await nav(finder, 'browse');
  await finder.locator('[data-action=detail][data-id=demo_found_umbrella]').click();
  assert.ok(!(await finder.locator('#modal').textContent()).includes(editedIdentity));
  assert.ok(!JSON.stringify(finderData).includes(editedIdentity));
  assert.equal(finderData.requests.length, 0);
  await close(finder);
  check(['REQ-5.1','REQ-5.3','REQ-5.5','REQ-4.2'], '#16 new lost report matches Recovery requested item without changing its state; same-owner pair creates neither candidate nor notification');

  await login(admin,'admin@kaist.ac.kr');
  await nav(admin,'admin-requests');
  await admin.getByText(editedIdentity, { exact: true }).waitFor();
  await admin.screenshot({ path: join(output, 'identity-admin-review.png') });
  check(['REQ-6.1','REQ-6.6','REQ-6.12'], '#19 identity name/email prefill stays editable, reaches administrator review and remains hidden from finder');
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
  check(['REQ-6.2','REQ-6.8','REQ-6.9','REQ-7.1','REQ-7.3','REQ-2.7'], 'administrator approval, audited pickup reveal, handover and linked lost closure');

  // Use the actual account-management UI to exercise delivery to every active admin.
  await nav(admin, 'admin-users');
  await admin.locator('tr').filter({ hasText: 'finder@kaist.ac.kr' }).locator('[data-action=user-role]').click();
  await submit(admin);
  await admin.locator('#modal').waitFor({ state: 'hidden' });
  await finder.reload();
  await finder.locator('[data-action=nav][data-id=admin-items]').waitFor();
  await nav(admin,'admin-items');
  await admin.locator('[data-action=detail][data-id=demo_found_umbrella]').click();
  await admin.locator('#modal [data-action=report-error]').click();
  await admin.locator('#modal [name=reason]').fill('오인도 정정 검수');
  await submit(admin);
  await admin.locator('#modal').waitFor({ state: 'hidden' });
  const activeAdminIds = (await data(admin)).users.filter(u => u.role === 'Administrator' && u.status === 'active').map(u => u.id).sort();
  assert.deepEqual(activeAdminIds, ['demo_admin', 'demo_finder']);
  for (const page of [admin, finder]) {
    await page.reload();
    await nav(page, 'notifications');
    const notification = (await data(page)).notifications.find(n => n.itemId === 'demo_found_umbrella' && n.message.includes('오인도 사고가 접수'));
    assert.ok(notification && !notification.read, 'Each active administrator receives the incident notification');
    await page.locator(`.notification-row.unread[data-id="${notification.id}"]`).click();
    await page.locator('#modal .form-error').filter({ hasText: '사고 처리 중' }).waitFor();
    await page.screenshot({ path: join(output, page === admin ? 'incident-admin-notification.png' : 'incident-second-admin-notification.png') });
    await close(page);
  }
  await nav(admin, 'admin-items');
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
  await member.locator('.request-card').filter({ hasText: '오인도 처리 중 정정한 우산' }).locator('[data-action=detail]').click();
  await member.locator('#modal .form-error').filter({ hasText: '사고 처리 중' }).waitFor();
  assert.equal(await member.locator('#modal [data-action=pickup]').count(), 0);
  assert.equal(await member.locator('#modal [data-action=new-request]').count(), 0);
  await close(member);
  check(['REQ-3.8','REQ-7.5'], '#13 administrator correction preserves the unresolved incident lock for users');
  await admin.locator('[data-action=detail][data-id=demo_found_umbrella]').click();
  await admin.locator('#modal [data-action=resolve]').click();
  await admin.locator('#modal [name=reason]').fill('인도 사고 검수 완료 및 관리자 해결');
  await submit(admin);
  await admin.locator('#modal').waitFor({ state: 'hidden' });
  await member.reload();
  await nav(member, 'requests');
  await member.locator('.request-card').filter({ hasText: '오인도 처리 중 정정한 우산' }).locator('[data-action=pickup]').click();
  await member.getByText('브라우저 검수 반환 창구', { exact: true }).waitFor();
  await close(member);
  assert.equal((await data(member)).items.find(i => i.id === 'demo_found_umbrella').blocked, false);
  check(['REQ-7.5','REQ-6.9'], '#23 incident reaches both active administrators through notifications UI; user actions stay blocked until actual resolution and then resume');

  // Service issues produce notifications with no item link: opening one must not
  // open an unrelated dialog or mark the other service issue read.
  for (const message of ['첫 번째 브라우저 서비스 문의', '두 번째 브라우저 서비스 문의']) {
    await nav(member, 'help');
    await member.locator('form[data-form=issue] [name=message]').fill(message);
    await Promise.all([
      member.waitForResponse(response => response.url() === `${base}/api/issues` && response.request().method() === 'POST'),
      member.locator('form[data-form=issue] button[type=submit]').click(),
    ]);
    await member.getByText('문의가 접수되었습니다.', { exact: true }).waitFor();
  }
  await admin.reload();
  await nav(admin, 'notifications');
  const serviceNotifications = (await data(admin)).notifications.filter(n => !n.itemId && n.message === '새 서비스 문의가 접수되었습니다.');
  assert.equal(serviceNotifications.length, 2);
  await admin.locator(`.notification-row.unread[data-id="${serviceNotifications[0].id}"]`).click();
  await assertReadPair(admin, serviceNotifications[0].id, serviceNotifications[1].id);
  assert.equal(await admin.locator('#modal').isVisible(), false);
  await admin.reload();
  await nav(admin, 'notifications');
  await assertReadPair(admin, serviceNotifications[0].id, serviceNotifications[1].id);
  await admin.screenshot({ path: join(output, 'notification-service-single-read.png') });
  await nav(admin, 'activity');
  await admin.getByText('첫 번째 브라우저 서비스 문의', { exact: true }).waitFor();
  await admin.getByText('두 번째 브라우저 서비스 문의', { exact: true }).waitFor();
  check(['REQ-1.3','REQ-5.3','SRS-2.2.7','SRS-2.6'], '#28 item-less service notifications preserve single-read behavior across reload; submitted service issues reach administrator activity');

  await member.locator('[data-testid=new-report]').click();
  await member.locator('#modal [name=name]').fill('만료된 세션 신고');
  await member.locator('#modal [name=location]').fill('도서관');
  await member.locator('#modal [name=description]').fill('세션 만료 시 로그인 안내 검수');
  await member.locator('#modal [name=date]').fill(reportDate());
  await member.request.post(`${base}/api/auth/logout`, { data: {} });
  await submit(member);
  await member.locator('form[data-form=login]').waitFor();
  await member.locator('#toast').filter({ hasText: '로그인이 필요합니다.' }).waitFor({ state: 'visible' });
  assert.equal(await member.locator('#modal').isVisible(), false);
  check(['REQ-1.3','REQ-1.4'], 'expired-session form submission returns to login with visible feedback');
  await login(member);

  await nav(admin,'settings');
  await admin.locator('[name=storedDays]').fill('42');
  await admin.locator('h1').click();
  await Promise.all([
    admin.waitForResponse(response => response.url() === `${base}/api/data`),
    admin.evaluate(() => document.dispatchEvent(new Event('visibilitychange'))),
  ]);
  assert.equal(await admin.locator('[name=storedDays]').inputValue(),'42');
  await admin.locator('[data-action=backup]').click();
  await admin.getByText('암호화 백업을 생성했습니다.', { exact: true }).waitFor();
  check(['REQ-1.3','SRS-2.5'], 'background draft preservation and manual backup');

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
  await submit(external);
  assert.equal(await external.locator('#modal [name=name]').evaluate(input => input.validity.valueMissing), true);
  assert.equal(await external.locator('#modal [name=name]').evaluate(input => input === document.activeElement), true);
  await external.locator('#modal [name=name]').fill('모바일 입력 확인');
  await external.locator('#modal [name=date]').fill(reportDate());
  await external.locator('#modal [name=location]').fill('모바일 검수 장소');
  await external.locator('#modal [name=description]').fill('모바일에서 제출 가능한 전체 양식');
  await external.locator('#modal button[type=submit]').scrollIntoViewIfNeeded();
  const dialogGeometry = await external.locator('#modal').evaluate(dialog => {
    const rect = dialog.getBoundingClientRect();
    return { left: rect.left, right: rect.right, width: innerWidth, scrollWidth: dialog.scrollWidth, clientWidth: dialog.clientWidth };
  });
  assert.ok(dialogGeometry.left >= 0 && dialogGeometry.right <= dialogGeometry.width + 1);
  assert.ok(dialogGeometry.scrollWidth <= dialogGeometry.clientWidth + 1);
  await external.screenshot({ path:join(output,'mobile-form.png') });
  await submit(external);
  await external.locator('#modal').waitFor({ state: 'hidden' });
  await nav(external, 'mine');
  await external.locator('.item-card').filter({ hasText: '모바일 입력 확인' }).click();
  await external.locator('#modal-title').filter({ hasText: '모바일 입력 확인' }).waitFor();
  await close(external);
  check(['REQ-1.1','REQ-1.3','REQ-2.3','REQ-2.4','SRS-2.4','SRS-3.2.2'], 'mobile required-field focus, usable scrollable dialog and real report submission; external document review and approval gates login');

  await nav(member, 'browse');
  const search = member.locator('form[data-form=search]');
  await search.locator('[name=q]').fill('브라우저 검수 지갑');
  await search.locator('[name=category]').selectOption('지갑·카드');
  await search.locator('[name=location]').fill('학술문화관');
  await search.locator('[name=date]').fill(reportDate());
  await search.locator('[name=q]').press('Enter');
  await member.locator('.item-card').filter({ hasText: '브라우저 검수 지갑' }).waitFor();
  assert.equal(await member.locator('.item-card').count(), 1);
  await search.locator('[name=q]').fill('절대 일치하지 않는 브라우저 검색어');
  await search.locator('[name=q]').press('Enter');
  await member.getByText('아직 일치하는 물건이 없어요.', { exact: true }).waitFor();
  await member.screenshot({ path: join(output, 'search-empty-keyboard.png') });
  await member.locator('[data-action=clear-search]').focus();
  await member.keyboard.press('Enter');
  await member.locator('.item-card').filter({ hasText: '브라우저 검수 지갑' }).waitFor();
  check(['REQ-4.1','REQ-4.5','SRS-3.2.1'], 'keyboard search combines category/place/date, shows empty feedback and resets filters');

  const agedLost = await createReport(member, 'lost', '유지 기간 초과 삭제 검수', '도서·문구', '기한 검수 분실 장소');
  const retentionItems = [];
  for (const [method, label] of [['dispose', '폐기'], ['donate', '기부']]) {
    const item = await createReport(member, 'found', `보관 만료 ${label} 검수`, '도서·문구', `기한 검수 ${label} 장소`);
    retentionItems.push({ ...item, method });
    await nav(admin, 'admin-items');
    await admin.locator(`[data-action=detail][data-id="${item.id}"]`).click();
    await admin.locator('#modal [data-action=intake]').click();
    await admin.locator('#modal [name=storageLocation]').fill(`공식 ${label} 검수 보관함`);
    await admin.locator('#modal [name=confidential]').fill(`${label} 검수 비공개 표식`);
    await submit(admin);
    await admin.locator('#modal').waitFor({ state: 'hidden' });
  }
  await nav(admin, 'settings');
  await admin.locator('[name=storedDays]').fill('2');
  await admin.locator('[name=lostDays]').fill('5');
  await admin.locator('form[data-form=settings] button[type=submit]').click();
  await admin.getByText('운영 설정을 저장했습니다.', { exact: true }).waitFor();
  await nav(admin, 'admin-items');
  for (const item of retentionItems) {
    await admin.locator(`[data-action=detail][data-id="${item.id}"]`).click();
    assert.equal(await admin.locator('#modal [data-action=dispose]').count(), 0);
    assert.ok(!(await admin.locator('#modal').textContent()).includes('보관 기간이 지난'));
    await close(admin);
  }
  await admin.locator(`[data-action=detail][data-id="${agedLost.id}"]`).click();
  assert.equal(await admin.locator('#modal [data-action=delete-item]').count(), 0);
  await close(admin);

  clock = new Date(present);
  await admin.reload();
  await nav(admin, 'settings');
  assert.equal(await admin.locator('[name=storedDays]').inputValue(), '2');
  assert.equal(await admin.locator('[name=lostDays]').inputValue(), '5');
  await admin.locator('[name=lostDays]').fill('2');
  await admin.locator('form[data-form=settings] button[type=submit]').click();
  await admin.getByText('운영 설정을 저장했습니다.', { exact: true }).waitFor();
  await admin.reload();
  await nav(admin, 'settings');
  assert.equal(await admin.locator('[name=lostDays]').inputValue(), '2');
  await nav(admin, 'admin-items');
  await admin.screenshot({ path: join(output, 'retention-unclaimed.png') });
  for (const item of retentionItems) {
    await admin.locator('tr').filter({ hasText: item.name }).getByText('장기 미수령', { exact: true }).waitFor();
    await admin.locator(`[data-action=detail][data-id="${item.id}"]`).click();
    await admin.locator('#modal [data-action=dispose]').click();
    assert.deepEqual(await admin.locator('#modal [name=method] option').allTextContents(), ['폐기', '기부']);
    await admin.locator('#modal [name=method]').selectOption(item.method);
    await admin.locator('#modal [name=reason]').fill(`보관 기한 경과 ${item.method} 기록`);
    await admin.screenshot({ path: join(output, `retention-${item.method}.png`) });
    await submit(admin);
    await admin.locator('#modal').waitFor({ state: 'hidden' });
    await admin.locator('tr').filter({ hasText: item.name }).getByText('처리 완료', { exact: true }).waitFor();
  }
  await admin.locator(`[data-action=detail][data-id="${agedLost.id}"]`).click();
  await admin.locator('#modal [data-action=delete-item]').click();
  await submit(admin);
  await admin.locator('#modal').waitFor({ state: 'hidden' });
  await admin.reload();
  assert.ok(!(await data(admin)).items.some(i => i.id === agedLost.id));
  const disposedData = await data(admin);
  for (const item of retentionItems) {
    const disposed = disposedData.items.find(i => i.id === item.id);
    assert.equal(disposed.state, 'Disposed');
    assert.equal(disposed.disposalMethod, item.method);
  }
  await member.reload();
  await nav(member, 'browse');
  for (const item of [...retentionItems, agedLost]) assert.equal(await member.locator(`.item-card[data-id="${item.id}"]`).count(), 0);
  check(['REQ-3.5','REQ-3.6','REQ-9.1','REQ-9.3','REQ-9.4','REQ-9.5'], '#27 saved retention settings plus server clock advancement expose unclaimed disposal/donation and aged lost deletion; actions persist and remove public search results');

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
  check(['SRS-2.4','SRS-3.2.2','SRS-3.4','SRS-5.4.2'], '320/390/768px width checks and offline shell with no cached API data');
  assert.deepEqual(errors,[]);
  const report = {
    engine, browser: await browser.version(), specification: 'Team10_SRS.pdf',
    mobileEmulation: engine === 'firefox' ? '390px viewport with touch; Firefox does not support isMobile emulation' : '390px mobile viewport with touch; not a physical-device run',
    browserCoverage: 'Engine coverage only; not a branded Chrome, Edge, or Safari certification',
    checks, pageErrors:errors, screenshotDirectory:output,
  };
  await writeFile(join(output,'report.json'),JSON.stringify(report,null,2));
  console.log(JSON.stringify(report,null,2));
} finally {
  await browser?.close();
  await app?.close();
  await rm(directory,{recursive:true,force:true});
}
