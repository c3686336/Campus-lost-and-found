import { randomUUID, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { DemoIdentityProvider } from './identity-provider.mjs';

export class ApiError extends Error {
  constructor(status, message, code) { super(message); this.status = status; this.code = code; }
}
const fail = (message, status = 400, code) => { throw new ApiError(status, message, code); };
const text = (v, name, max = 2000) => {
  if (typeof v !== 'string' || !v.trim() || v.trim().length > max) fail(`${name}을(를) 올바르게 입력해 주세요. (최대 ${max}자)`);
  return v.trim();
};
const passwordHash = password => { const salt = randomBytes(16).toString('hex'); return `${salt}:${scryptSync(password, salt, 64).toString('hex')}`; };
const passwordMatches = (password, hash) => {
  const [salt, hex] = hash.split(':');
  const bytes = scryptSync(password, salt, 64);
  return timingSafeEqual(bytes, Buffer.from(hex, 'hex'));
};
export const publicUser = u => u ? ({ id: u.id, name: u.name, email: u.email, role: u.role, status: u.status }) : null;
const isWaiting = r => ['Pending', 'More proof'].includes(r.status);
const terminal = i => ['Recovered', 'Disposed'].includes(i.state);

function validImage(bytes, type) {
  if (type === 'image/png') {
    if (bytes.length < 57 || !bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) return false;
    let offset=8, header=false, pixels=false, end=false;
    while(offset+12<=bytes.length){const length=bytes.readUInt32BE(offset),kind=bytes.subarray(offset+4,offset+8).toString();if(length>bytes.length-offset-12)return false;
      if(!header){if(kind!=='IHDR'||length!==13||!bytes.readUInt32BE(offset+8)||!bytes.readUInt32BE(offset+12))return false;header=true;}
      if(kind==='IDAT'&&length>0)pixels=true;
      offset+=length+12;
      if(kind==='IEND'){if(length!==0||offset!==bytes.length)return false;end=true;break;}
    }
    return header&&pixels&&end;
  }
  if (type === 'image/jpeg') {
    if(bytes.length<25||bytes[0]!==255||bytes[1]!==216||bytes.at(-2)!==255||bytes.at(-1)!==217)return false;
    let offset=2,dimensions=false;
    while(offset+4<bytes.length){if(bytes[offset]!==255)return false;while(bytes[offset]===255)offset++;const marker=bytes[offset++];if(marker===0xDA)return dimensions;
      if(marker===0xD9)return false;const length=bytes.readUInt16BE(offset);if(length<2||offset+length>bytes.length)return false;
      if([0xC0,0xC1,0xC2,0xC3,0xC5,0xC6,0xC7,0xC9,0xCA,0xCB,0xCD,0xCE,0xCF].includes(marker)){if(length<8||!bytes.readUInt16BE(offset+3)||!bytes.readUInt16BE(offset+5))return false;dimensions=true;}
      offset+=length;
    }
    return false;
  }
  if(type==='image/gif')return bytes.length>=20&&['GIF87a','GIF89a'].includes(bytes.subarray(0,6).toString())&&bytes.readUInt16LE(6)>0&&bytes.readUInt16LE(8)>0&&bytes.includes(0x2C,13)&&bytes.at(-1)===0x3B;
  if(type==='image/webp')return bytes.length>=25&&bytes.subarray(0,4).toString()==='RIFF'&&bytes.readUInt32LE(4)+8===bytes.length&&bytes.subarray(8,12).toString()==='WEBP'&&['VP8 ','VP8L','VP8X'].includes(bytes.subarray(12,16).toString());
  return false;
}

export function validateFile(file, document = false) {
  if (!file || typeof file !== 'object') fail('파일을 첨부해 주세요.');
  const name = text(file.name, '파일 이름', 180);
  const data = file.data;
  const match = typeof data === 'string' && /^data:([^;,]+);base64,([A-Za-z0-9+/]*={0,2})$/.exec(data);
  if (!match) fail('올바른 파일 형식이 아닙니다.');
  const bytes = Buffer.from(match[2], 'base64');
  if (!bytes.length || bytes.length > 2 * 1024 * 1024) fail('파일 크기는 2MB 이하여야 합니다.');
  const type = match[1];
  const valid = validImage(bytes,type) ||
    (document && type === 'application/pdf' && bytes.subarray(0,5).toString() === '%PDF-');
  if (!valid || (file.type && type !== file.type)) fail('지원하는 파일은 PNG, JPEG, GIF, WebP' + (document ? ', PDF' : '') + '입니다.');
  return { name, type, data };
}

export class CampusService {
  constructor(store, { seed = true, now = () => new Date(), identityProvider = new DemoIdentityProvider() } = {}) {
    this.store = store; this.now = now; this.identity = identityProvider;
    this.state = store.read() || { users: [], items: [], requests: [], matches: [], notifications: [], audit: [], issues: [], settings: { storedDays: 30, lostDays: 90, dataRetentionDays: 180, dropoffLocation: '학생지원팀 분실물 접수처', department: '학생지원팀' } };
    this.maintenance = { backupError: null, lastBackupAt: null };
    this.nextMaintenance = 0;
    this.nextBackupAttempt = 0;
    if (!this.state.users.length && seed) this.seed();
    this.tx(() => {});
  }
  stamp() { return this.now().toISOString(); }
  id() { return randomUUID(); }
  tx(fn) {
    const prior = structuredClone(this.state);
    let result;
    try { this.cleanup(); result = fn(); this.store.write(this.state); }
    catch (error) { this.state = prior; throw error; }
    this.nextMaintenance = this.now().getTime() + 60000;
    // The data commit is final. A failed backup must never roll back memory alone.
    this.backup();
    return result;
  }
  backup(force = false) {
    if (!force && this.now().getTime() < this.nextBackupAttempt) return;
    try {
      const file = this.store.backup(this.now(), force);
      this.maintenance.backupError = null;
      this.maintenance.lastBackupAt = this.store.lastBackupAt || this.stamp();
      this.nextBackupAttempt = this.now().getTime() + 60000;
      return file;
    } catch (error) {
      this.maintenance.backupError = '백업을 생성하지 못했습니다. 데이터 폴더의 권한과 여유 공간을 확인한 뒤 다시 시도해 주세요.';
      this.nextBackupAttempt = this.now().getTime() + 60000;
      if (force) throw new ApiError(503, this.maintenance.backupError);
    }
  }
  maintain() {
    const now = this.now().getTime();
    if (now >= this.nextMaintenance || now < this.nextMaintenance - 60000) this.tx(() => {});
  }
  seed() {
    for (const [id, name, email, role] of [['demo_admin','관리자','admin@kaist.ac.kr','Administrator'],['demo_minji','김민지','minji@kaist.ac.kr','User'],['demo_finder','이준호','finder@kaist.ac.kr','User']]) this.state.users.push({ id, name, email, role, status: 'active', password: passwordHash('CampusDemo!24'), createdAt: this.stamp() });
    const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Seoul' }).format(this.now());
    const sample = (id, kind, name, category, location, description, ownerId, state) => ({ id, kind, name, category, location, date: today, description, ownerId, state, image: null, color: '', createdAt: this.stamp(), updatedAt: this.stamp(), specialHandling: false, blocked: false, unclaimed: false, notes: [] });
    this.state.items.push(sample('demo_lost_umbrella','lost','남색 장우산','의류·잡화','학술문화관','도서관 열람실 근처에서 남색 장우산을 잃어버렸어요.','demo_minji','Open'));
    this.state.items.push({ ...sample('demo_found_umbrella','found','남색 장우산','의류·잡화','학술문화관','1층 로비 의자 옆에서 발견한 남색 우산입니다.','demo_finder','Stored'), storageLocation: '학생지원팀 보관함 A-03', confidential: '손잡이 안쪽에 별 스티커', intakeAt: this.stamp(), color: '남색' });
    this.state.items.push({ ...sample('demo_found_earbuds','found','무선 이어폰 케이스','전자기기','학생회관','학생회관 카페 테이블에서 발견했습니다.','demo_finder','Stored'), storageLocation: '학생지원팀 보관함 B-01', confidential: '케이스 뒷면에 MJ 각인', intakeAt: this.stamp(), color: '흰색' });
    this.state.items.push(sample('demo_found_book','found','자료구조 교재','도서·문구','전산학동','강의실 앞 벤치에서 발견했습니다.','demo_finder','Registered'));
    this.generateMatches();
  }
  audit(user, action, targetId) { this.state.audit.push({ id: this.id(), actorId: user?.id || null, action, targetId, createdAt: this.stamp() }); }
  notify(userId, message, itemId) { this.state.notifications.push({ id: this.id(), userId, message, ...(itemId ? { itemId } : {}), read: false, createdAt: this.stamp() }); }
  notifyAdmins(message, itemId) { this.state.users.filter(u => u.role === 'Administrator' && u.status === 'active').forEach(u => this.notify(u.id, message, itemId)); }
  user(id) { const u = this.state.users.find(x => x.id === id); if (!u || u.status !== 'active') fail('로그인이 필요합니다.', 401); return u; }
  admin(u) { if (u.role !== 'Administrator') fail('관리자 권한이 필요합니다.', 403); }
  item(id) { const i = this.state.items.find(x => x.id === id); if (!i) fail('물품을 찾을 수 없습니다.', 404); return i; }
  request(id) { const r = this.state.requests.find(x => x.id === id); if (!r) fail('신청을 찾을 수 없습니다.', 404); return r; }
  usable(i) { if (i.blocked) fail('오인도 사고를 처리 중인 물품입니다.', 409); }
  requireState(i, states) { if (!states.includes(i.state)) fail('현재 상태에서는 처리할 수 없습니다.', 409); }
  age(date) { return (this.now().getTime() - Date.parse(date)) / 86400000; }
  refresh() {
    for (const i of this.state.items) i.unclaimed = i.kind === 'found' && i.state === 'Stored' && this.age(i.intakeAt) >= this.state.settings.storedDays && !this.state.requests.some(r => r.itemId === i.id && ['Approved','Completed'].includes(r.status));
  }
  cleanup() {
    this.refresh();
    const days = this.state.settings.dataRetentionDays;
    const purge = new Set(this.state.items.filter(i => (terminal(i) || ['Closed','Withdrawn'].includes(i.state)) && this.age(i.completedAt || i.updatedAt) >= days).map(i => i.id));
    this.state.items = this.state.items.filter(i => !purge.has(i.id));
    this.state.requests = this.state.requests.filter(r => !purge.has(r.itemId) && !(r.status === 'Rejected' && this.age(r.updatedAt) >= days));
    for (const r of this.state.requests) if (purge.has(r.lostReportId)) r.lostReportId = null;
    this.state.matches = this.state.matches.filter(m => !purge.has(m.lostId) && !purge.has(m.foundId));
    this.state.notifications = this.state.notifications.filter(n => this.age(n.createdAt) < days && !purge.has(n.itemId));
    this.state.audit = this.state.audit.filter(a => this.age(a.createdAt) < days);
    this.state.issues = this.state.issues.filter(a => this.age(a.createdAt) < days);
    for (const u of this.state.users) if (u.document && u.status !== 'pending_admin' && this.age(u.reviewedAt || u.createdAt) >= days) delete u.document;
  }
  generateMatches(forId) {
    const target = forId ? this.item(forId) : null;
    const lost = this.state.items.filter(i => i.kind === 'lost' && i.state === 'Open' && !i.blocked && (target?.kind !== 'lost' || i.id === forId));
    const found = this.state.items.filter(i => i.kind === 'found' && i.state === 'Stored' && !i.blocked && (target?.kind !== 'found' || i.id === forId));
    const byCategory = new Map();
    for (const f of found) { if (!byCategory.has(f.category)) byCategory.set(f.category, []);byCategory.get(f.category).push(f); }
    const existing = new Map(this.state.matches.map(m => [`${m.lostId}:${m.foundId}`, m]));
    for (const l of lost) for (const f of byCategory.get(l.category) || []) if (f.date >= l.date) this.addMatch(l, f, existing);
  }
  addMatch(l, f, existing) {
    const key = `${l.id}:${f.id}`;
    let m = existing ? existing.get(key) : this.state.matches.find(x => x.lostId === l.id && x.foundId === f.id);
    if (!m) { m = { id: this.id(), lostId: l.id, foundId: f.id, createdAt: this.stamp() }; this.state.matches.push(m);existing?.set(key,m);this.notify(l.ownerId, `${l.name}의 새 매칭 후보가 등록되었습니다.`, f.id); }
    return m;
  }
  sanitizeItem(i, u) {
    const { storageLocation, confidential, notes, handoverBy, errorReason, resolution, disposalReason, pickupLocation, department, ...safe } = i;
    if (u.role === 'Administrator') return structuredClone(i);
    return structuredClone(safe);
  }
  data(u) {
    this.maintain();
    const admin = u.role === 'Administrator';
    const requests = this.state.requests.filter(r => admin || r.userId === u.id).map(r => { const safe = structuredClone(r); if (!admin) { delete safe.pickupLocation; delete safe.department; } return safe; });
    const ids = new Set(requests.map(r => r.itemId));
    const items = this.state.items.filter(i => admin || i.ownerId === u.id || ids.has(i.id) || (i.kind === 'lost' ? i.state === 'Open' : ['Stored','Recovery requested'].includes(i.state))).map(i => this.sanitizeItem(i,u));
    const matches = this.state.matches.filter(m => { const l = this.state.items.find(i => i.id === m.lostId); const f = this.state.items.find(i => i.id === m.foundId); return l && f && (admin || l.ownerId === u.id) && l.state === 'Open' && ['Stored','Recovery requested'].includes(f.state); }).sort((a,b) => {
      const l = this.item(a.lostId), af = this.item(a.foundId), bf = this.item(b.foundId);
      return a.lostId.localeCompare(b.lostId) || Number(bf.location === l.location) - Number(af.location === l.location) || bf.date.localeCompare(af.date) || a.id.localeCompare(b.id);
    });
    return { user: publicUser(u), items, requests, matches, notifications: this.state.notifications.filter(n => n.userId === u.id).slice().reverse(), settings: this.state.settings, ...(admin ? { maintenance: { ...this.maintenance }, users: this.state.users.map(x => ({ ...publicUser(x), ...(x.document ? { document: x.document } : {}), createdAt: x.createdAt })), audit: this.state.audit.slice().reverse(), issues: this.state.issues.slice().reverse() } : {}) };
  }
  register(body) {
    return this.tx(() => {
      const name = text(body.name, '이름', 80), email = text(body.email, '이메일', 254).toLowerCase();
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) fail('이메일 형식이 올바르지 않습니다.');
      const password = text(body.password, '비밀번호', 128); if (password.length < 10) fail('비밀번호는 10자 이상이어야 합니다.');
      if (this.state.users.some(u => u.email === email)) fail('이미 가입된 이메일입니다.', 409);
      const kaist = email.endsWith('@kaist.ac.kr');
      const document = kaist ? undefined : validateFile(body.document, true);
      const challenge = kaist ? this.identity.issueEmailChallenge(email) : undefined;
      const u = { id: this.id(), name, email, password: passwordHash(password), role: 'User', status: kaist ? 'pending_email' : 'pending_admin', createdAt: this.stamp(), ...(document ? { document } : {}), ...(challenge ? { challenge, challengeAt: this.stamp(), challengeAttempts: 0 } : {}) };
      this.state.users.push(u); this.audit(u, '계정 가입 신청', u.id);
      if (!kaist) this.notifyAdmins(`${name}님의 외부 구성원 가입 승인 요청이 있습니다.`);
      return { message: kaist ? '데모 인증 코드를 입력해 이메일 확인을 완료해 주세요.' : '증빙 문서가 제출되었습니다. 관리자 승인 후 로그인할 수 있습니다.', ...(challenge ? { demoCode: challenge.code } : {}) };
    });
  }
  verify(body) {
    const email = text(body.email, '이메일', 254).toLowerCase();
    const u = this.state.users.find(x => x.email === email);
    if (!u || u.status !== 'pending_email') fail('확인 대기 중인 계정이 없습니다.');
    if (this.age(u.challengeAt) > 10/1440 || u.challengeAttempts >= 5) fail('인증 코드가 만료되었습니다. 관리자에게 문의해 주세요.');
    const correct = this.identity.verifyEmailChallenge(u.challenge, String(body.code));
    // Failed attempt counts must persist even when validation fails.
    if (!correct) { this.tx(() => { u.challengeAttempts++; }); fail('인증 코드가 올바르지 않습니다.'); }
    return this.tx(() => { u.status = 'active'; delete u.challenge; delete u.challengeAt; delete u.challengeAttempts; this.audit(u,'이메일 인증',u.id); return { message: '이메일 인증이 완료되었습니다. 로그인해 주세요.' }; });
  }
  login(body) {
    const email = text(body.email, '이메일', 254).toLowerCase(), password = text(body.password, '비밀번호',128);
    const u = this.state.users.find(x => x.email === email);
    if (!u || !passwordMatches(password,u.password)) fail('이메일 또는 비밀번호가 올바르지 않습니다.',401);
    if (u.status !== 'active') fail(u.status === 'pending_admin' ? '관리자 승인을 기다리고 있습니다.' : u.status === 'pending_email' ? '이메일 인증을 완료해 주세요.' : '접근이 제한된 계정입니다.',403);
    this.tx(() => this.audit(u,'로그인',u.id)); return u;
  }
  itemFields(body) {
    const date = text(body.date, '날짜', 10);
    const parsed = new Date(`${date}T00:00:00Z`);
    const today = new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Seoul'}).format(this.now());
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0,10) !== date || date > today) fail('날짜는 오늘 또는 이전의 유효한 날짜여야 합니다.');
    let image = body.image || null;
    if (image) image = validateFile(typeof image === 'string' ? { name:'photo',data:image } : image).data;
    const occurredTime = body.occurredTime == null ? '' : body.occurredTime;
    if (typeof occurredTime !== 'string' || (occurredTime !== '' && !/^([01]\d|2[0-3]):[0-5]\d$/.test(occurredTime))) fail('시각은 HH:mm 형식으로 입력해 주세요.');
    return { name: text(body.name,'물품 이름',120), category:text(body.category,'분류',80),location:text(body.location,'장소',160),date,occurredTime,description:text(body.description,'설명',3000),color:typeof body.color === 'string' ? body.color.trim().slice(0,60) : '',image };
  }
  createItem(u, body) {
    return this.tx(() => {
      if (!['lost','found'].includes(body.kind)) fail('신고 유형이 올바르지 않습니다.');
      const fields = this.itemFields(body);
      if (body.kind === 'found' && body.confirmDuplicate !== true && this.state.items.some(i => i.kind === 'found' && i.category === fields.category && i.location === fields.location && i.date === fields.date)) fail('같은 분류·장소·날짜의 습득 신고가 있습니다. 중복 여부를 확인해 주세요.',409,'DUPLICATE');
      const i = { id:this.id(),kind:body.kind,...fields,state:body.kind === 'lost' ? 'Open':'Registered',ownerId:u.id,createdAt:this.stamp(),updatedAt:this.stamp(),specialHandling:false,blocked:false,unclaimed:false,notes:[] };
      this.state.items.push(i); this.audit(u,'신고 등록',i.id); if (i.kind === 'lost') this.generateMatches(i.id);
      return { item:this.sanitizeItem(i,u), ...(i.kind === 'found' ? { dropoffLocation:this.state.settings.dropoffLocation } : {}) };
    });
  }
  editItem(u,id,body) {
    return this.tx(() => {
      const i = this.item(id); this.usable(i);
      if (!(i.kind === 'lost' && i.ownerId === u.id && i.state === 'Open') && !(i.kind === 'found' && u.role === 'Administrator')) fail('이 신고를 수정할 권한이 없습니다.',403);
      const fields = this.itemFields({...i,...body}); Object.assign(i,fields,{updatedAt:this.stamp()});
      if (i.kind === 'found' && body.storageLocation !== undefined) i.storageLocation = text(body.storageLocation,'보관 장소',200);
      if (i.kind === 'found' && body.confidential !== undefined) i.confidential = text(body.confidential,'비공개 특징',2000);
      this.state.matches = this.state.matches.filter(m => m.lostId !== i.id && m.foundId !== i.id); this.generateMatches(i.id);
      this.audit(u,'신고 수정',i.id); return {item:this.sanitizeItem(i,u)};
    });
  }
  itemAction(u,id,body) {
    return this.tx(() => {
      const i = this.item(id), action = body.action;
      if (action === 'withdraw') {
        this.usable(i); if (i.kind !== 'lost' || i.ownerId !== u.id) fail('본인의 분실 신고만 철회할 수 있습니다.',403); this.requireState(i,['Open']);
        for (const r of this.state.requests.filter(r => r.lostReportId === i.id)) { r.lostReportId=null;this.audit(u,'철회 신고와 반환 신청 연결 해제',r.id); }
        i.state='Withdrawn'; i.completedAt=this.stamp();
      } else {
        this.admin(u); if (!['report-error','resolve'].includes(action)) this.usable(i);
        if (action === 'delete') {
          if (i.kind !== 'lost' || i.state !== 'Open' || this.age(i.createdAt) < this.state.settings.lostDays) fail('보관 기간이 지난 Open 분실 신고만 삭제할 수 있습니다.',409);
          this.state.items = this.state.items.filter(x => x.id !== id); this.state.matches = this.state.matches.filter(m => m.lostId !== id && m.foundId !== id); for (const r of this.state.requests) if (r.lostReportId === id) r.lostReportId=null; this.audit(u,'장기 분실 신고 삭제',id); return {message:'삭제되었습니다.'};
        }
        if (i.kind !== 'found') fail('습득물에만 사용할 수 있는 기능입니다.');
        if (action === 'intake') { this.requireState(i,['Registered']); i.storageLocation=text(body.storageLocation,'보관 장소',200); i.confidential=text(body.confidential,'비공개 특징',2000); i.intakeAt=this.stamp(); i.state='Stored'; this.generateMatches(i.id); }
        else if (action === 'note') { this.requireState(i,['Stored']); i.notes.push({id:this.id(),note:text(body.note,'상태 기록',2000),createdAt:this.stamp(),adminId:u.id}); }
        else if (action === 'special') { if (terminal(i)) fail('처리 완료된 물품입니다.',409); if (typeof body.value !== 'boolean') fail('특별 처리 값을 확인해 주세요.'); i.specialHandling=body.value; }
        else if (action === 'dispose') {
          this.refresh(); if (terminal(i) || !(i.specialHandling || (i.state === 'Stored' && i.unclaimed))) fail('특별 처리 물품 또는 보관 기간이 지난 미수령 물품만 처리할 수 있습니다.',409);
          if (!['dispose','donate','authorities'].includes(body.method)) fail('처리 방법을 선택해 주세요.');
          if (body.method === 'authorities' && !i.specialHandling) fail('관계 기관 이관은 특별 처리 물품에만 가능합니다.');
          i.disposalReason=text(body.reason,'처리 사유',2000); i.disposalMethod=body.method; i.state='Disposed'; i.completedAt=this.stamp();
          for (const r of this.state.requests.filter(r => r.itemId === id && (isWaiting(r) || r.status === 'Approved'))) { r.status='Rejected'; r.reason='물품이 폐기·기부 또는 관계 기관 이관 처리되었습니다.';r.updatedAt=this.stamp();this.notify(r.userId,r.reason,id); }
        }
        else if (action === 'handover') {
          this.requireState(i,['Ownership verified']);
          const r=this.state.requests.find(r => r.itemId === id && r.status === 'Approved');
          if (!r) fail('승인된 신청이 없습니다.',409);
          const lost = r.lostReportId ? this.state.items.find(l => l.id === r.lostReportId) : null;
          if (r.lostReportId && (!lost || lost.kind !== 'lost' || lost.state !== 'Open' || lost.ownerId !== r.userId)) fail('연결된 분실 신고를 확인한 뒤 인도해 주세요.',409);
          i.state='Recovered';i.handoverBy=u.id;i.handoverAt=this.stamp();i.completedAt=this.stamp();r.status='Completed';r.updatedAt=this.stamp();
          if (lost) {
            lost.state='Closed';lost.updatedAt=this.stamp();lost.completedAt=this.stamp();
            // A completed lost report cannot remain the basis of another pending claim.
            for (const other of this.state.requests.filter(o => o.lostReportId === lost.id && o.id !== r.id && isWaiting(o))) {
              other.status='Rejected';other.reason='연결된 분실 신고의 물품 반환이 완료되었습니다.';other.updatedAt=this.stamp();
              this.notify(other.userId,other.reason,other.itemId);
              const found=this.item(other.itemId);
              if (found.state === 'Recovery requested' && !this.state.requests.some(o => o.itemId === found.id && isWaiting(o))) { found.state='Stored';found.updatedAt=this.stamp();this.generateMatches(found.id); }
            }
          }
          this.notify(r.userId,'물품 수령이 완료되었습니다.',id);
        }
        else if (action === 'report-error') { this.requireState(i,['Recovered']); if(i.blocked) fail('이미 사고가 접수되었습니다.',409); i.blocked=true;i.errorReason=text(body.reason,'오인도 사유',2000);this.notifyAdmins('오인도 사고가 접수되어 물품을 잠금 처리했습니다.',id); }
        else if (action === 'resolve') { if(!i.blocked)fail('처리 중인 사고가 없습니다.',409);i.resolution=text(body.reason,'해결 내용',2000);i.blocked=false;this.notifyAdmins('오인도 사고가 해결 처리되었습니다.',id); }
        else fail('지원하지 않는 작업입니다.');
      }
      i.updatedAt=this.stamp();this.refresh();this.audit(u,`물품 ${action}`,id);return {item:this.sanitizeItem(i,u)};
    });
  }
  createRequest(u,body) {
    return this.tx(() => {
      const i=this.item(body.itemId);this.usable(i);if(i.kind!=='found')fail('습득물에만 반환 신청할 수 있습니다.');this.requireState(i,['Stored','Recovery requested']);
      if(i.ownerId===u.id)fail('본인이 습득 신고한 물품은 반환 신청할 수 없습니다.',403);
      if(this.state.requests.some(r=>r.itemId===i.id&&r.userId===u.id&&(isWaiting(r)||r.status==='Approved')))fail('이미 진행 중인 반환 신청이 있습니다.',409);
      if(body.lostReportId){const l=this.item(body.lostReportId);if(l.kind!=='lost'||l.ownerId!==u.id||l.state!=='Open')fail('본인의 Open 분실 신고만 연결할 수 있습니다.',403);this.requireUnreservedLost(l.id);}
      const r={id:this.id(),itemId:i.id,userId:u.id,lostReportId:body.lostReportId||null,identity:text(body.identity,'신원 정보',2000),evidence:text(body.evidence,'물품 식별 증거',3000),status:'Pending',createdAt:this.stamp(),updatedAt:this.stamp()};this.state.requests.push(r);i.state='Recovery requested';i.updatedAt=this.stamp();this.notifyAdmins(`${i.name} 반환 신청이 접수되었습니다.`,i.id);this.audit(u,'반환 신청',r.id);return{request:r};
    });
  }
  requestAction(u,id,body) {
    return this.tx(() => {
      const r=this.request(id),i=this.item(r.itemId);this.usable(i);
      if(body.action==='supplement') {if(r.userId!==u.id)fail('본인의 신청만 보완할 수 있습니다.',403);if(r.status!=='More proof')fail('추가 증빙 요청 상태가 아닙니다.',409);r.evidence += '\n\n[추가 증빙] '+text(body.evidence,'추가 증빙',3000);if(r.evidence.length>15000)fail('증빙 내용이 너무 깁니다.');r.status='Pending';this.notifyAdmins('반환 신청의 추가 증빙이 제출되었습니다.',i.id);}
      else {
        this.admin(u);if(!isWaiting(r))fail('대기 중인 신청만 처리할 수 있습니다.',409);this.requireState(i,['Recovery requested']);
        if(body.action==='approve') {
          const pickupLocation=text(body.pickupLocation,'수령 장소',200),department=text(body.department,'담당 부서',120);
          if(r.lostReportId){const l=this.state.items.find(l=>l.id===r.lostReportId);if(!l||l.state!=='Open'||l.ownerId!==r.userId)fail('연결된 분실 신고가 유효하지 않습니다. 신청을 거절 후 다시 접수해 주세요.',409);this.requireUnreservedLost(l.id);}
          r.status='Approved';r.pickupLocation=pickupLocation;r.department=department;i.state='Ownership verified';
          for(const other of this.state.requests.filter(o=>o.itemId===i.id&&o.id!==r.id&&isWaiting(o))){other.status='Rejected';other.reason='다른 신청자의 소유권이 확인되었습니다.';other.updatedAt=this.stamp();this.notify(other.userId,other.reason,i.id);}
          this.notify(r.userId,'반환 신청이 승인되었습니다. 수령 장소를 확인해 주세요.',i.id);
        }
        else if(body.action==='reject'){r.status='Rejected';r.reason=text(body.reason,'거절 사유',2000);this.notify(r.userId,'반환 신청 거절: '+r.reason,i.id);if(!this.state.requests.some(o=>o.itemId===i.id&&o.id!==r.id&&isWaiting(o))){i.state='Stored';this.generateMatches(i.id);}}
        else if(body.action==='more-proof'){if(r.status!=='Pending')fail('이미 추가 증빙을 요청했습니다.',409);r.status='More proof';r.reason=text(body.reason,'추가 증빙 요청 사유',2000);this.notify(r.userId,'추가 증빙 요청: '+r.reason,i.id);}
        else fail('지원하지 않는 작업입니다.');
      }
      r.updatedAt=this.stamp();i.updatedAt=this.stamp();this.audit(u,`반환 신청 ${body.action}`,id);return{request:r};
    });
  }
  match(u,body,id) {
    this.admin(u);return this.tx(()=>{if(id){const m=this.state.matches.find(m=>m.id===id);if(!m)fail('후보를 찾을 수 없습니다.',404);this.state.matches=this.state.matches.filter(m=>m.id!==id);this.audit(u,'매칭 후보 삭제',id);return{message:'후보를 삭제했습니다.'};}
      const l=this.item(body.lostId),f=this.item(body.foundId);this.usable(l);this.usable(f);if(l.kind!=='lost'||f.kind!=='found'||l.state!=='Open'||f.state!=='Stored')fail('Open 분실 신고와 Stored 습득물만 연결할 수 있습니다.',409);const m=this.addMatch(l,f);this.audit(u,'매칭 후보 추가',m.id);return{match:m};});
  }
  requireUnreservedLost(id) {
    if (this.state.requests.some(r => r.lostReportId === id && ['Approved','Completed'].includes(r.status))) fail('이미 소유권이 확인된 반환 신청에 연결된 분실 신고입니다.',409);
  }
  pickup(u, id) {
    return this.tx(() => {
      const r=this.request(id), i=this.item(r.itemId);
      this.usable(i);
      if (r.userId !== u.id || !['Approved','Completed'].includes(r.status)) fail('승인된 신청자만 수령 장소를 확인할 수 있습니다.',403);
      this.audit(u,'수령 장소 열람',r.id);
      return {pickupLocation:r.pickupLocation,department:r.department};
    });
  }
  userAction(actor,id,body) {
    this.admin(actor);return this.tx(()=>{
      const u=this.state.users.find(u=>u.id===id);if(!u)fail('사용자를 찾을 수 없습니다.',404);
      const last=u.role==='Administrator'&&u.status==='active'&&this.state.users.filter(x=>x.role==='Administrator'&&x.status==='active').length===1;
      if(last&&((body.action==='role'&&body.role==='User')||body.action==='block'))fail('마지막 활성 관리자의 권한은 제거할 수 없습니다.',409);
      if(body.action==='approve'){if(u.status!=='pending_admin')fail('문서 승인 대기 계정이 아닙니다.',409);if(!this.identity.reviewDocument(u.document,true))fail('신원 증빙 문서를 확인해 주세요.');u.status='active';u.reviewedAt=this.stamp();}
      else if(body.action==='reject'){if(u.status!=='pending_admin')fail('문서 승인 대기 계정이 아닙니다.',409);u.status='rejected';u.reviewedAt=this.stamp();u.reviewReason=text(body.reason,'거절 사유',2000);}
      else if(body.action==='block'){if(u.status!=='active')fail('활성 계정만 차단할 수 있습니다.',409);u.status='blocked';}
      else if(body.action==='unblock'){if(u.status!=='blocked')fail('차단된 계정이 아닙니다.',409);u.status='active';}
      else if(body.action==='role'){if(!['User','Administrator'].includes(body.role))fail('지원하는 역할이 아닙니다.');if(u.status!=='active')fail('활성 계정만 권한을 변경할 수 있습니다.',409);u.role=body.role;}
      else fail('지원하지 않는 작업입니다.');
      this.audit(actor,`계정 ${body.action}`,id);return{user:publicUser(u)};
    });
  }
  settings(u,body){this.admin(u);return this.tx(()=>{for(const key of ['storedDays','lostDays','dataRetentionDays'])if(body[key]!==undefined){if(!Number.isInteger(body[key])||body[key]<1||body[key]>3650)fail('보관 기간은 1~3650일의 정수여야 합니다.');this.state.settings[key]=body[key];}for(const key of ['dropoffLocation','department'])if(body[key]!==undefined)this.state.settings[key]=text(body[key],key,200);this.refresh();this.audit(u,'운영 설정 변경','settings');return{settings:this.state.settings};});}
  profile(u,body){return this.tx(()=>{if(body.name!==undefined)u.name=text(body.name,'이름',80);if(body.password!==undefined){if(!body.currentPassword||!passwordMatches(String(body.currentPassword),u.password))fail('현재 비밀번호가 올바르지 않습니다.',403);const p=text(body.password,'새 비밀번호',128);if(p.length<10)fail('비밀번호는 10자 이상이어야 합니다.');u.password=passwordHash(p);}this.audit(u,'본인 정보 수정',u.id);return{user:publicUser(u)};});}
  readNotifications(u){return this.tx(()=>{this.state.notifications.filter(n=>n.userId===u.id).forEach(n=>n.read=true);return{message:'알림을 읽음 처리했습니다.'};});}
  issue(u,body){return this.tx(()=>{const i={id:this.id(),userId:u.id,message:text(body.message,'문의 내용',3000),createdAt:this.stamp()};this.state.issues.push(i);this.notifyAdmins('새 서비스 문의가 접수되었습니다.');this.audit(u,'서비스 문의',i.id);return{message:'문의가 접수되었습니다.'};});}
}
