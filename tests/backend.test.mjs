import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../server.mjs';
import { validateFile } from '../lib/service.mjs';
import { images, invalidImages, oversizedImage } from './fixtures/images.mjs';

async function fixture(t) {
  const dataDir=await mkdtemp(join(tmpdir(),'campus-backend-'));
  let clock=new Date('2026-11-05T03:00:00Z');
  const app=createApp({dataDir,now:()=>clock});
  await new Promise(resolve=>app.server.listen(0,'127.0.0.1',resolve));
  const origin=`http://127.0.0.1:${app.server.address().port}`;
  t.after(async()=>{await app.close();await rm(dataDir,{recursive:true,force:true});});
  const client=()=>{let cookie='';return async(path,method='GET',body,extra={})=>{const res=await fetch(origin+path,{method,headers:{...(cookie?{cookie}:{}),...(method!=='GET'?{'Content-Type':'application/json',Origin:origin}:{}),...extra},body:method==='GET'?undefined:JSON.stringify(body||{})});if(res.headers.get('set-cookie'))cookie=res.headers.get('set-cookie').split(';')[0];return{status:res.status,body:await res.json(),headers:res.headers};};};
  const admin=client(),minji=client(),finder=client();
  for(const [c,email]of [[admin,'admin@kaist.ac.kr'],[minji,'minji@kaist.ac.kr'],[finder,'finder@kaist.ac.kr']])assert.equal((await c('/api/auth/login','POST',{email,password:'CampusDemo!24'})).status,200);
  return{app,dataDir,admin,minji,finder,client,advance:days=>{clock=new Date(clock.getTime()+days*86400000);}};
}

test('complete ownership workflow, competing claims, privacy, wrong handover and audit',async t=>{
  const{admin,minji,finder,client}=await fixture(t);
  const user=client();
  const registered=await user('/api/auth/register','POST',{name:'다른 소유 주장자',email:'other@kaist.ac.kr',password:'AnotherPass!24'});
  assert.equal(registered.status,201);
  assert.equal((await user('/api/auth/login','POST',{email:'other@kaist.ac.kr',password:'AnotherPass!24'})).status,403);
  assert.equal((await user('/api/auth/verify','POST',{email:'other@kaist.ac.kr',code:registered.body.demoCode})).status,200);
  assert.equal((await user('/api/auth/login','POST',{email:'other@kaist.ac.kr',password:'AnotherPass!24'})).status,200);
  const data=(await minji('/api/data')).body;
  assert.ok(data.matches.some(m=>m.foundId==='demo_found_umbrella'));
  const umbrella=data.items.find(i=>i.id==='demo_found_umbrella');
  assert.equal(umbrella.confidential,undefined);assert.equal(umbrella.storageLocation,undefined);assert.equal(data.users,undefined);
  assert.equal((await finder('/api/requests','POST',{itemId:umbrella.id,identity:'학생',evidence:'특징'})).status,403);
  assert.equal((await minji('/api/items/'+umbrella.id,'PATCH',{name:'가로채기'})).status,403);
  const first=await minji('/api/requests','POST',{itemId:umbrella.id,lostReportId:'demo_lost_umbrella',identity:'학생증',evidence:'손잡이의 별 스티커'});
  assert.equal(first.status,201);const rid=first.body.request.id;
  assert.equal((await minji('/api/requests','POST',{itemId:umbrella.id,identity:'학생증',evidence:'특징'})).status,409);
  const second=await user('/api/requests','POST',{itemId:umbrella.id,identity:'신분증',evidence:'내 것'});assert.equal(second.status,201);
  assert.equal((await finder('/api/data')).body.requests.length,0);
  assert.equal((await admin(`/api/requests/${rid}/action`,'POST',{action:'more-proof',reason:'스티커 모양을 설명해 주세요.'})).status,200);
  assert.equal((await minji(`/api/requests/${rid}/action`,'POST',{action:'supplement',evidence:'노란 별'})).status,200);
  assert.equal((await admin(`/api/items/${umbrella.id}/action`,'POST',{action:'handover'})).status,409);
  assert.equal((await admin(`/api/requests/${rid}/action`,'POST',{action:'approve',pickupLocation:'학생지원팀 창구',department:'학생지원팀'})).status,200);
  assert.equal((await minji('/api/data')).body.items.find(i=>i.id===umbrella.id).pickupLocation,undefined);
  assert.equal((await minji(`/api/requests/${rid}/pickup`,'POST')).body.pickupLocation,'학생지원팀 창구');
  const other=(await user('/api/data')).body;assert.equal(other.requests[0].status,'Rejected');assert.equal(other.items.find(i=>i.id===umbrella.id)?.pickupLocation,undefined);
  assert.equal((await admin(`/api/items/${umbrella.id}/action`,'POST',{action:'handover'})).status,200);
  assert.equal((await minji('/api/data')).body.items.find(i=>i.id==='demo_lost_umbrella').state,'Closed');
  assert.equal((await admin(`/api/items/${umbrella.id}/action`,'POST',{action:'report-error',reason:'수령자 재확인'})).status,200);
  assert.equal((await minji('/api/data')).body.items.find(i=>i.id===umbrella.id).pickupLocation,undefined);
  const corrected=await admin(`/api/items/${umbrella.id}`,'PATCH',{name:'오인도 확인 중인 우산',storageLocation:'사고 조사 보관함',confidential:'노란 별 스티커 확인'});
  assert.equal(corrected.status,200);
  assert.equal(corrected.body.item.name,'오인도 확인 중인 우산');
  assert.equal(corrected.body.item.storageLocation,'사고 조사 보관함');
  assert.equal(corrected.body.item.confidential,'노란 별 스티커 확인');
  assert.equal(corrected.body.item.blocked,true);
  assert.equal(corrected.body.item.errorReason,'수령자 재확인');
  assert.equal(corrected.body.item.state,'Recovered');
  assert.equal((await minji(`/api/items/${umbrella.id}`,'PATCH',{name:'권한 없는 수정'})).status,403);
  assert.equal((await finder(`/api/items/${umbrella.id}`,'PATCH',{name:'습득자 수정'})).status,403);
  assert.equal((await minji(`/api/requests/${rid}/pickup`,'POST')).status,409);
  assert.equal((await admin(`/api/items/${umbrella.id}/action`,'POST',{action:'handover'})).status,409);
  assert.equal((await admin(`/api/items/${umbrella.id}/action`,'POST',{action:'special',value:true})).status,409);
  assert.equal((await admin('/api/data')).body.items.find(i=>i.id===umbrella.id).blocked,true);
  assert.equal((await admin(`/api/items/${umbrella.id}/action`,'POST',{action:'resolve',reason:'소유자 확인 완료'})).status,200);
  assert.ok((await admin('/api/data')).body.audit.some(a=>a.action==='물품 handover'));
});

test('#28 / SRS §5.3.2–5.3.3: individual notification reads are private, isolated and persistent',async t=>{
  const{app,admin,minji,finder,client}=await fixture(t);
  assert.equal((await minji('/api/requests','POST',{itemId:'demo_found_earbuds',identity:'김민지',evidence:'MJ 각인'})).status,201);
  assert.equal((await minji('/api/issues','POST',{message:'알림 읽음 상태 검수'})).status,201);
  const before=(await admin('/api/data')).body.notifications;
  const target=before.find(n=>n.itemId==='demo_found_earbuds');
  const unrelated=before.find(n=>!n.itemId);
  assert.ok(target&&!target.read&&unrelated&&!unrelated.read);
  const path=`/api/notifications/${target.id}/read`;
  assert.equal((await client()(path,'POST',{})).status,401);
  assert.equal((await minji(path,'POST',{})).status,404);
  assert.equal((await finder(path,'POST',{})).status,404);
  assert.equal((await admin('/api/notifications/missing/read','POST',{})).status,404);
  assert.deepEqual((await admin('/api/data')).body.notifications,before);
  assert.equal((await admin(path,'POST',{})).status,200);
  assert.equal((await admin(path,'POST',{})).status,200);
  const after=(await admin('/api/data')).body.notifications;
  assert.equal(after.find(n=>n.id===target.id).read,true);
  assert.equal(after.find(n=>n.id===unrelated.id).read,false);
  assert.equal(app.store.read().notifications.find(n=>n.id===target.id).read,true);
  assert.equal((await admin(`/api/notifications/${unrelated.id}/read`,'POST',{})).status,200);
  assert.equal((await admin('/api/data')).body.notifications.find(n=>n.id===unrelated.id).read,true);
  assert.equal((await minji('/api/data')).body.notifications.find(n=>n.id===target.id),undefined);
});

test('intake, duplicate warning, validation, finder restriction, manual matches and hazardous disposal',async t=>{
  const{admin,minji,finder}=await fixture(t);
  const item={kind:'found',name:'초록 노트',category:'도서·문구',location:'전산학동',date:'2026-11-05',description:'책상 위 노트'};
  assert.equal((await finder('/api/items','POST',{...item,date:'2026-02-30'})).status,400);
  assert.equal((await finder('/api/items','POST',{...item,date:'2026-11-06'})).status,400);
  assert.equal((await finder('/api/items','POST',{...item,image:'data:image/png;base64,SGVsbG8='})).status,400);
  const duplicate=await finder('/api/items','POST',item);assert.equal(duplicate.status,409);assert.equal(duplicate.body.code,'DUPLICATE');
  const created=await finder('/api/items','POST',{...item,confirmDuplicate:true});assert.equal(created.status,201);const id=created.body.item.id;
  assert.equal((await finder('/api/items/'+id,'PATCH',{name:'바꾸기'})).status,403);
  assert.equal((await finder(`/api/items/${id}/action`,'POST',{action:'intake',storageLocation:'A',confidential:'글씨'})).status,403);
  assert.equal((await admin(`/api/items/${id}/action`,'POST',{action:'intake',storageLocation:'A'})).status,400);
  assert.equal((await admin(`/api/items/${id}/action`,'POST',{action:'intake',storageLocation:'A',confidential:'첫장 이름'})).status,200);
  const lost=await minji('/api/items','POST',{...item,kind:'lost',name:'노트 분실'});const lid=lost.body.item.id;
  const candidate=(await minji('/api/data')).body.matches.find(m=>m.lostId===lid&&m.foundId===id);assert.ok(candidate);
  assert.equal((await admin('/api/matches/'+candidate.id,'DELETE')).status,200);
  assert.equal((await admin('/api/matches','POST',{lostId:lid,foundId:id})).status,201);
  assert.equal((await admin(`/api/items/${id}/action`,'POST',{action:'note',note:'포장 상태 양호'})).status,200);
  assert.equal((await admin(`/api/items/${id}/action`,'POST',{action:'dispose',method:'dispose',reason:'아직 보관 중'})).status,409);
  assert.equal((await admin(`/api/items/${id}/action`,'POST',{action:'special',value:true})).status,200);
  assert.equal((await admin(`/api/items/${id}/action`,'POST',{action:'dispose',method:'authorities',reason:'관계 기관 인계'})).status,200);
  assert.equal((await minji('/api/requests','POST',{itemId:id,identity:'본인',evidence:'특징'})).status,409);
  assert.equal((await admin('/api/items/'+id,'PATCH',{name:'기관 이관 노트'})).status,200);
});

test('external document approval, role guards, session revocation, origin protection and encrypted persistence',async t=>{
  const{admin,client,dataDir}=await fixture(t);
  const external=client();
  const document={name:'proof.pdf',type:'application/pdf',data:'data:application/pdf;base64,'+Buffer.from('%PDF-1.4\nMembership proof').toString('base64')};
  assert.equal((await external('/api/auth/register','POST',{name:'외부 구성원',email:'staff@example.org',password:'ExternalPass!24'})).status,400);
  assert.equal((await external('/api/auth/register','POST',{name:'외부 구성원',email:'staff@example.org',password:'ExternalPass!24',document})).status,201);
  assert.equal((await external('/api/auth/login','POST',{email:'staff@example.org',password:'ExternalPass!24'})).status,403);
  const uid=(await admin('/api/data')).body.users.find(u=>u.email==='staff@example.org').id;
  assert.equal((await admin(`/api/users/${uid}/action`,'POST',{action:'approve'})).status,200);
  assert.equal((await external('/api/auth/login','POST',{email:'staff@example.org',password:'ExternalPass!24'})).status,200);
  assert.equal((await external('/api/data')).body.users,undefined);
  assert.equal((await admin('/api/users/demo_admin/action','POST',{action:'role',role:'User'})).status,409);
  assert.equal((await admin('/api/users/demo_admin/action','POST',{action:'block'})).status,409);
  assert.equal((await admin(`/api/users/${uid}/action`,'POST',{action:'block'})).status,200);
  assert.equal((await external('/api/data')).status,401);
  assert.equal((await admin('/api/settings','PATCH',{storedDays:0})).status,400);
  assert.equal((await admin('/api/settings','PATCH',{storedDays:45}, {Origin:'https://evil.example'})).status,403);
  const raw=await readFile(join(dataDir,'campus.sqlite'));
  assert.equal(raw.includes(Buffer.from('staff@example.org')),false);
  assert.equal(raw.includes(Buffer.from('ExternalPass!24')),false);
  assert.equal(raw.includes(Buffer.from('Membership proof')),false);
});

test('retention, unclaimed marker, disposal and deletion policy',async t=>{
  const{admin,minji,advance}=await fixture(t);
  assert.equal((await admin('/api/settings','PATCH',{storedDays:1,lostDays:1,dataRetentionDays:3})).status,200);
  const lost=await minji('/api/items','POST',{kind:'lost',name:'장기 신고',category:'기타',location:'강의실',date:'2026-11-05',description:'분실'});
  assert.equal((await admin(`/api/items/${lost.body.item.id}/action`,'POST',{action:'delete'})).status,409);
  advance(2);
  assert.equal((await admin('/api/data')).body.items.find(i=>i.id==='demo_found_earbuds').unclaimed,true);
  assert.equal((await admin('/api/items/demo_found_earbuds/action','POST',{action:'dispose',method:'donate',reason:'보관 기한 경과'})).status,200);
  assert.equal((await admin(`/api/items/${lost.body.item.id}/action`,'POST',{action:'delete'})).status,200);
  advance(4);
  assert.equal((await admin('/api/data')).body.items.some(i=>i.id==='demo_found_earbuds'),false);
});

test('#27 / REQ-9.3–9.5, §5.5.5–5.5.6: policy boundaries protect approved items and restrict disposal and deletion',async t=>{
  const{admin,minji,finder,advance}=await fixture(t);
  assert.equal((await admin('/api/settings','PATCH',{storedDays:1,lostDays:1})).status,200);
  const request=(await minji('/api/requests','POST',{itemId:'demo_found_earbuds',identity:'김민지',evidence:'각인'})).body.request;
  assert.equal((await admin(`/api/requests/${request.id}/action`,'POST',{action:'approve',pickupLocation:'공식 창구',department:'학생지원팀'})).status,200);
  const lost=(await minji('/api/items','POST',{kind:'lost',name:'기한 검수',category:'기타',location:'검수동',date:'2026-11-05',description:'기한 전 삭제 금지'})).body.item;
  advance(0.99);
  assert.equal((await admin('/api/data')).body.items.find(i=>i.id==='demo_found_umbrella').unclaimed,false);
  assert.equal((await admin('/api/items/demo_found_umbrella/action','POST',{action:'dispose',method:'dispose',reason:'기한 전'})).status,409);
  assert.equal((await admin(`/api/items/${lost.id}/action`,'POST',{action:'delete'})).status,409);
  advance(0.02);
  const items=(await admin('/api/data')).body.items;
  assert.equal(items.find(i=>i.id==='demo_found_umbrella').unclaimed,true);
  assert.equal(items.find(i=>i.id==='demo_found_earbuds').unclaimed,false);
  assert.equal((await admin('/api/items/demo_found_earbuds/action','POST',{action:'dispose',method:'donate',reason:'승인된 물품'})).status,409);
  assert.equal((await finder('/api/items/demo_found_umbrella/action','POST',{action:'dispose',method:'dispose',reason:'습득자'})).status,403);
  assert.equal((await finder(`/api/items/${lost.id}/action`,'POST',{action:'delete'})).status,403);
  assert.equal((await admin('/api/items/demo_found_umbrella/action','POST',{action:'dispose',method:'dispose',reason:'기한 경과'})).status,200);
  assert.ok(!(await finder('/api/data')).body.matches.some(m=>m.foundId==='demo_found_umbrella'));
  assert.ok(!(await minji('/api/data')).body.items.some(i=>i.id==='demo_found_umbrella'));
  assert.equal((await admin(`/api/items/${lost.id}/action`,'POST',{action:'delete'})).status,200);
  assert.ok(!(await admin('/api/data')).body.items.some(i=>i.id===lost.id));
});

test('image validation decodes supported static and animated formats and rejects corrupt or oversized content',async()=>{
  for(const file of invalidImages)await assert.rejects(validateFile(file),{status:400});
  for(const file of images)assert.deepEqual(await validateFile(file),file);
  await assert.rejects(validateFile(oversizedImage),{status:400});
  await assert.rejects(validateFile({...images[0],type:'image/jpeg'}),{status:400});
  await assert.rejects(validateFile({...images[0],data:images[0].data.replace('image/png','image/jpeg')}),{status:400});
});

test('invalid image uploads fail without saving items, edits, documents or audit entries',async t=>{
  const{app,admin,minji,client}=await fixture(t);
  const item={kind:'lost',name:'사진 검증',category:'기타',location:'강의실',date:'2026-11-05',description:'사진이 첨부된 신고'};
  const before=structuredClone(app.service.state);
  const external=client();
  for(const image of [...invalidImages,oversizedImage]){
    assert.equal((await minji('/api/items','POST',{...item,image})).status,400);
    assert.equal((await admin('/api/items/demo_found_umbrella','PATCH',{name:'저장되면 안 됨',image})).status,400);
    assert.equal((await external('/api/auth/register','POST',{name:'외부 구성원',email:'invalid-image@example.org',password:'ExternalPass!24',document:image})).status,400);
    assert.deepEqual(app.service.state,before);
  }
});

test('valid image uploads retain original static and animated bytes through creation and correction',async t=>{
  const{admin,minji,client}=await fixture(t);
  const item={kind:'lost',name:'사진 검증',category:'기타',location:'강의실',date:'2026-11-05',description:'사진이 첨부된 신고'};
  for(const image of images){
    const created=await minji('/api/items','POST',{...item,image});
    assert.equal(created.status,201);
    assert.equal(created.body.item.image,image.data);
    const edited=await admin('/api/items/demo_found_umbrella','PATCH',{image});
    assert.equal(edited.status,200);
    assert.equal(edited.body.item.image,image.data);
    assert.equal((await admin('/api/items/demo_found_umbrella','PATCH',{description:'사진을 유지하는 설명 수정'})).body.item.image,image.data);
  }
  const external=client();
  assert.equal((await external('/api/auth/register','POST',{name:'외부 구성원',email:'image-proof@example.org',password:'ExternalPass!24',document:images[0]})).status,201);
});

test('async image validation rechecks live users, roles and item state before committing',async t=>{
  const{app}=await fixture(t);
  const service=app.service,admin=service.user('demo_admin'),member=service.user('demo_minji');
  const image=images[0];
  const before=structuredClone(service.state.items);
  const creating=service.createItem(()=>member.id,{kind:'lost',name:'차단 중 업로드',category:'기타',location:'강의실',date:'2026-11-05',description:'저장되면 안 됨',image});
  service.userAction(admin,member.id,{action:'block'});
  await assert.rejects(creating,{status:401});
  assert.deepEqual(service.state.items,before);
  service.userAction(admin,member.id,{action:'unblock'});

  service.userAction(admin,'demo_finder',{action:'role',role:'Administrator'});
  const editingAdmin=service.user('demo_finder');
  const foundBefore=structuredClone(service.item('demo_found_umbrella'));
  const editing=service.editItem(()=>editingAdmin.id,foundBefore.id,{name:'권한 회수 중 수정',image});
  service.userAction(admin,editingAdmin.id,{action:'role',role:'User'});
  await assert.rejects(editing,{status:403});
  assert.deepEqual(service.item(foundBefore.id),foundBefore);

  const lostId='demo_lost_umbrella';
  const closing=service.editItem(()=>member.id,lostId,{name:'철회 중 수정',image});
  service.itemAction(service.user(member.id),lostId,{action:'withdraw'});
  const withdrawn=structuredClone(service.item(lostId));
  await assert.rejects(closing,{status:403});
  assert.deepEqual(service.item(lostId),withdrawn);
});

test('async image correction merges the current item and registration checks uniqueness after decoding',async t=>{
  const{app}=await fixture(t);
  const service=app.service,admin=service.user('demo_admin'),image=images[0];
  const correcting=service.editItem(()=>admin.id,'demo_found_umbrella',{image});
  await service.editItem(()=>admin.id,'demo_found_umbrella',{name:'동시에 정정된 이름',storageLocation:'새 보관함'});
  const corrected=await correcting;
  assert.equal(corrected.item.name,'동시에 정정된 이름');
  assert.equal(corrected.item.storageLocation,'새 보관함');
  assert.equal(corrected.item.image,image.data);

  const account={name:'외부 구성원',email:'concurrent@example.org',password:'ExternalPass!24',document:image};
  const registrations=await Promise.allSettled([service.register(account),service.register(account)]);
  assert.equal(registrations.filter(r=>r.status==='fulfilled').length,1);
  const rejected=registrations.find(r=>r.status==='rejected');
  assert.equal(rejected.reason.status,409);
  assert.equal(service.state.users.filter(u=>u.email===account.email).length,1);
});
test('#23 / REQ-7.5, §5.2.3: every active admin gets one incident notice and resolution restores access',async t=>{
  const{app:{service}}=await fixture(t);
  const admin=service.user('demo_admin'),member=service.user('demo_minji'),finder=service.user('demo_finder');
  service.userAction(admin,finder.id,{action:'role',role:'Administrator'});
  const request=service.createRequest(member,{itemId:'demo_found_umbrella',identity:'김민지',evidence:'별 스티커'}).request;
  service.requestAction(admin,request.id,{action:'approve',pickupLocation:'공식 창구',department:'학생지원팀'});
  service.itemAction(admin,'demo_found_umbrella',{action:'handover'});
  const before=new Set(service.state.notifications.map(n=>n.id));
  service.itemAction(admin,'demo_found_umbrella',{action:'report-error',reason:'수령자 재확인'});
  const notices=service.state.notifications.filter(n=>!before.has(n.id));
  assert.deepEqual(notices.map(n=>n.userId).sort(),[admin.id,finder.id].sort());
  assert.ok(notices.every(n=>n.itemId==='demo_found_umbrella'&&!n.read&&n.message.includes('오인도')));
  assert.throws(()=>service.pickup(member,request.id),{status:409});
  assert.throws(()=>service.itemAction(admin,'demo_found_umbrella',{action:'report-error',reason:'중복 신고'}),{status:409});
  assert.deepEqual(service.state.notifications.filter(n=>!before.has(n.id)),notices);
  service.userAction(admin,finder.id,{action:'block'});
  const resolvedBefore=new Set(service.state.notifications.map(n=>n.id));
  service.itemAction(admin,'demo_found_umbrella',{action:'resolve',reason:'소유자 확인 완료'});
  assert.deepEqual(service.state.notifications.filter(n=>!resolvedBefore.has(n.id)).map(n=>n.userId),[admin.id]);
  assert.deepEqual(service.pickup(member,request.id),{pickupLocation:'공식 창구',department:'학생지원팀'});
});

