import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../server.mjs';
import { validateFile } from '../lib/service.mjs';

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
  assert.equal((await admin(`/api/items/${umbrella.id}/action`,'POST',{action:'resolve',reason:'소유자 확인 완료'})).status,200);
  assert.ok((await admin('/api/data')).body.audit.some(a=>a.action==='물품 handover'));
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

test('image upload rejects signature-only and truncated files but accepts a complete PNG',()=>{
  for(const [type,bytes]of [['image/png',Buffer.from([137,80,78,71,13,10,26,10])],['image/jpeg',Buffer.from([255,216,255])],['image/webp',Buffer.from('RIFF0000WEBP')]])assert.throws(()=>validateFile({name:'fake',type,data:`data:${type};base64,${bytes.toString('base64')}`}));
  const data='data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aYfQAAAAASUVORK5CYII=';
  assert.equal(validateFile({name:'one.png',type:'image/png',data}).data,data);
});
