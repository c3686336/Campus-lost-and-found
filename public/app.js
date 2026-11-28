const $=s=>document.querySelector(s);
const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const stateLabel={Open:'신고 중',Closed:'반환 완료',Withdrawn:'철회됨',Registered:'접수 대기',Stored:'보관 중','Recovery requested':'반환 검토 중','Ownership verified':'수령 대기',Recovered:'반환 완료',Disposed:'처리 완료',Pending:'검토 대기','More proof':'추가 증빙 요청',Approved:'승인',Rejected:'거절',Completed:'수령 완료',active:'이용 중',pending_email:'이메일 확인 대기',pending_admin:'가입 승인 대기',blocked:'이용 정지',rejected:'가입 거절'};
const emptyState=()=>({user:null,items:[],requests:[],matches:[],notifications:[],settings:{},users:[],audit:[],issues:[]});
let S={user:null,items:[],requests:[],matches:[],notifications:[],settings:{},users:[],audit:[],issues:[]}, view='browse', filter={kind:'all',q:'',category:'',location:'',date:'',color:'',state:''}, installPrompt=null, modalContext={}, refreshId=0, submitting=0;
const categories=()=>[...new Set(['전자기기','지갑·카드','의류·잡화','도서·문구','열쇠','기타',...S.items.map(x=>x.category)])];
const isAdmin=()=>S.user?.role==='Administrator';
const isMine=i=>i.ownerId===S.user?.id;
const date=v=>v?new Date(v).toLocaleDateString('ko-KR',{month:'short',day:'numeric'}):'-';
const dateTime=v=>v?new Date(v).toLocaleString('ko-KR'):'-';
const today=()=>new Date(Date.now()+9*3600000).toISOString().slice(0,10);
const itemBy=id=>S.items.find(x=>x.id===id);
const userName=id=>S.users?.find(x=>x.id===id)?.name||'신청자';
const ico=(name,size=20)=>{const p={search:'<circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 4 4"/>',grid:'<rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/>',box:'<path d="m3 7 9-4 9 4-9 4zM3 7v10l9 4 9-4V7M12 11v10"/>',link:'<path d="m10 13 4-4M8 15l-1 1a4 4 0 0 1-6-6l5-5a4 4 0 0 1 6 0M16 9l1-1a4 4 0 0 1 6 6l-5 5a4 4 0 0 1-6 0" transform="translate(0 0) scale(.95)"/>',check:'<path d="m5 12 4 4L20 5"/>',arrow:'<path d="M5 12h14m-5-5 5 5-5 5"/>',bell:'<path d="M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9M10 21h4"/>',user:'<circle cx="12" cy="8" r="4"/><path d="M4 21v-2a8 8 0 0 1 16 0v2"/>',settings:'<path d="M4 6h16M4 12h16M4 18h16"/><circle cx="8" cy="6" r="2"/><circle cx="16" cy="12" r="2"/><circle cx="10" cy="18" r="2"/>',help:'<circle cx="12" cy="12" r="9"/><path d="M9 9a3 3 0 1 1 5 2c-2 1-2 2-2 3M12 17h.01"/>',logout:'<path d="M9 3H4v18h5m6-14 5 5-5 5M8 12h12"/>',plus:'<path d="M12 5v14M5 12h14"/>',pin:'<path d="M19 9c0 6-7 12-7 12S5 15 5 9a7 7 0 1 1 14 0Z"/><circle cx="12" cy="9" r="2"/>',clock:'<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',close:'<path d="m6 6 12 12M6 18 18 6"/>',shield:'<path d="m12 3 8 3v6c0 5-8 9-8 9s-8-4-8-9V6zM8 12l3 3 5-6"/>',download:'<path d="M12 3v12m-5-5 5 5 5-5M4 16v5h16v-5"/>'};return `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${p[name]||p.box}</svg>`;};
const photo=(i,lazy=false)=>i.image?`<img src="${esc(i.image)}" alt="${esc(i.name)} 사진"${lazy?' loading="lazy"':''}>`:'<span class="no-photo">사진 없음</span>';
const badge=s=>`<span class="badge b-${esc(s.replaceAll(' ','-'))}">${esc(stateLabel[s]||s)}</span>`;
const btn=(text,action,id='',cls='secondary')=>`<button type="button" class="btn ${cls}" data-action="${action}" data-id="${esc(id)}">${text}</button>`;
const empty=(title,desc='')=>`<div class="empty"><h3>${title}</h3>${desc?`<p>${desc}</p>`:''}</div>`;
function toast(message){$('#toast').textContent=message;$('#toast').classList.remove('hidden');clearTimeout(toast.timer);toast.timer=setTimeout(()=>$('#toast').classList.add('hidden'),4500);}
async function api(path,method='GET',body){if(!navigator.onLine)throw new Error('인터넷 연결을 확인한 뒤 다시 시도해 주세요.');let response;try{response=await fetch('/api'+path,{method,headers:body?{'Content-Type':'application/json'}:{},body:body?JSON.stringify(body):undefined,credentials:'same-origin',cache:'no-store'});}catch{throw new Error('서버에 연결하지 못했습니다. 잠시 후 다시 시도해 주세요.');}const data=await response.json();if(!response.ok){const err=new Error(data.error||'요청을 처리하지 못했습니다.');err.code=data.code;err.status=response.status;throw err;}return data;}
// A refresh may complete after the user starts typing or opens a dialog.
// Preserve current drafts only for the same signed-in identity and role.
function isDirtyField(field) {
  if (['checkbox', 'radio'].includes(field.type)) return field.checked !== field.defaultChecked;
  if (field.tagName === 'SELECT') {
    const options = [...field.options];
    const initial = options.find(option => option.defaultSelected) || options[0];
    return field.value !== (initial?.value || '');
  }
  return field.value !== field.defaultValue;
}
function captureDrafts() {
  return [...document.querySelectorAll('#app form[data-form]')].map(form => ({
    name: form.dataset.form,
    fields: [...form.elements].filter(field => field.name && !['password', 'file'].includes(field.type) && isDirtyField(field)).map(field => ({
      name: field.name, value: field.value, checked: field.checked
    }))
  }));
}
function restoreDrafts(drafts) {
  for (const draft of drafts) {
    const form = [...document.querySelectorAll('#app form[data-form]')].find(form => form.dataset.form === draft.name);
    if (!form) continue;
    for (const saved of draft.fields) {
      const field = form.elements.namedItem(saved.name);
      if (!field) continue;
      field.value = saved.value;
      if (['checkbox', 'radio'].includes(field.type)) field.checked = saved.checked;
    }
  }
}
async function refresh({background = false} = {}) {
  if (background && submitting) return;
  const requestId = ++refreshId;
  try {
    const data = await api('/data');
    if (requestId !== refreshId) return;
    const sameIdentity = S.user?.id === data.user?.id && S.user?.role === data.user?.role;
    if (background && sameIdentity && (submitting || $('#modal').open || ['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement?.tagName))) return;
    const drafts = background && sameIdentity ? captureDrafts() : [];
    // Omitted administrator fields must never survive a role change.
    S = {...emptyState(), ...data};
    if (!isAdmin() && (view.startsWith('admin-') || ['settings', 'activity'].includes(view))) view = 'browse';
    if (!sameIdentity) $('#modal').close();
    render();
    restoreDrafts(drafts);
  } catch (error) {
    if (requestId !== refreshId) return;
    if (error.status === 401) { S = emptyState(); $('#modal').close(); render(); }
    else throw error;
  }
}
function showModal(title,body,context={}){modalContext=context;const d=$('#modal');d.innerHTML=`<header class="modal-head"><h2 id="modal-title">${title}</h2><button type="button" class="icon-btn" data-action="close" aria-label="닫기">${ico('close')}</button></header>${body}`;if(!d.open)d.showModal();(d.querySelector('form input:not([type=hidden]),form textarea,form select')||d.querySelector('button'))?.focus();}
function formBody(form,fields,submit='저장',extra=''){return `<form data-form="${form}" class="form"><div class="form-error hidden" role="alert"></div>${fields}${extra}<div class="form-footer">${btn('취소','close')}<button class="btn primary" type="submit">${submit}</button></div></form>`;}
const input=(name,label,value='',type='text',required=true,attrs='')=>`<label>${label}<input name="${name}" type="${type}" value="${esc(value)}" ${required?'required':''} ${attrs}></label>`;
const textarea=(name,label,value='',required=true)=>`<label>${label}<textarea name="${name}" rows="3" ${required?'required':''} maxlength="4000">${esc(value)}</textarea></label>`;
const select=(name,label,options,value='',required=true)=>`<label>${label}<select name="${name}" aria-label="${esc(label)}" ${required?'required':''}>${options.map(o=>{const [v,t]=Array.isArray(o)?o:[o,o];return `<option value="${esc(v)}" ${value===v?'selected':''}>${esc(t)}</option>`;}).join('')}</select></label>`;
function auth(){
  return `<main class="auth-layout"><section class="auth-form-wrap">
    <a class="brand" href="/">KAIST 분실물 센터</a>
    <h1>로그인</h1><p class="muted">분실·습득 신고와 반환 신청을 이용하려면 로그인하세요.</p>
    <form data-form="login" class="form" data-testid="login-form">
      <div class="form-error hidden" role="alert"></div>
      ${input('email','이메일','','email',true,'autocomplete="username" placeholder="name@kaist.ac.kr"')}
      ${input('password','비밀번호','','password',true,'autocomplete="current-password"')}
      <button class="btn primary full" type="submit" data-testid="login-button">로그인</button>
    </form>
    <div class="auth-links"><button class="text-btn" data-action="register">회원가입</button><button class="text-btn" data-action="verify">이메일 인증</button></div>
    <details class="demo-box"><summary>시연 계정</summary><p>계정을 선택하면 로그인 정보를 입력합니다.</p>
      <div class="demo-buttons">${btn('일반 사용자','demo-user','minji')}${btn('습득자','demo-user','finder')}${btn('관리자','demo-user','admin')}</div>
      <small>비밀번호: CampusDemo!24<br>시연 환경에는 실제 개인정보를 입력하지 마세요.</small>
    </details>
  </section></main>`;
}
const navUser=[['browse','search','물품 검색'],['mine','box','내 신고'],['matches','link','매칭 후보'],['requests','check','내 반환 신청']];
const navAdmin=[['admin-items','box','물품 관리'],['admin-requests','shield','반환 심사'],['admin-users','user','사용자 관리'],['admin-matches','link','매칭 관리'],['settings','settings','운영 설정'],['activity','clock','운영 기록']];
const navLink=([key,icon,title])=>`<button data-action="nav" data-id="${key}" class="nav-link ${view===key?'active':''}" ${view===key?'aria-current="page"':''}>${ico(icon)}<span>${title}</span>${key==='matches'&&S.matches.length?`<span class="nav-count">${S.matches.length}</span>`:''}</button>`;
const titles={browse:['물품 검색','분실·습득 신고를 이름, 장소, 날짜로 검색합니다.'],mine:['내 신고','등록한 신고의 내용과 처리 상태입니다.'],matches:['매칭 후보','분실 신고와 조건이 일치하는 습득물입니다.'],requests:['내 반환 신청','소유권 심사 결과와 수령 안내입니다.'],'admin-items':['물품 관리','신고 접수, 보관 기록, 인도 및 처분을 처리합니다.'],'admin-requests':['반환 심사','신청자의 증빙과 비공개 식별 특징을 비교하세요.'],'admin-users':['사용자 관리','가입 증빙, 승인 상태, 계정 권한을 관리합니다.'],'admin-matches':['매칭 관리','자동 매칭 후보를 검토하거나 직접 연결합니다.'],settings:['운영 설정','보관 기간, 데이터 보존 기간, 공식 접수처를 설정합니다.'],activity:['운영 기록','접수된 문의와 관리자 작업 이력입니다.'],help:['이용 안내','신고, 반환 신청, 가입 절차를 안내합니다.'],notifications:['알림','신고 및 신청에 대한 처리 내역입니다.']};
function render(){
  if(!S.user){$('#app').innerHTML=auth();return;}
  const [title,sub]=titles[view]||titles.browse;
  const unread=S.notifications.filter(n=>!n.read).length;
  $('#app').innerHTML=`<div class="shell">
    <aside class="sidebar"><a class="brand" href="/">KAIST <br>분실물 센터</a>
      <nav aria-label="주 메뉴">${navUser.map(navLink).join('')}
        ${isAdmin()?`<p class="nav-label">관리자</p>${navAdmin.map(navLink).join('')}`:''}
        <div class="nav-support">${navLink(['help','help','이용 안내'])}<button class="nav-link" data-action="install">${ico('download')}<span>앱 설치 안내</span></button></div>
      </nav>
    </aside>
    <div class="main-wrap"><header class="topbar"><div class="top-actions">
      <button class="icon-btn notification-btn" data-action="nav" data-id="notifications" aria-label="알림 ${unread}개">${ico('bell')}<span>알림</span>${unread?`<span class="notification-dot">${unread}</span>`:''}</button>
      <button class="profile-btn" data-action="profile" aria-label="내 계정 ${esc(S.user.name)}">${ico('user',18)}<span>${esc(S.user.name)}</span></button>
      <button class="icon-btn" data-action="logout" aria-label="로그아웃">${ico('logout',18)}<span>로그아웃</span></button>
    </div></header>
    <main class="content"><div class="page-heading"><div><h1>${title}</h1><p>${sub}</p></div>
      <div class="report-actions">${btn('습득 신고','report','found')}<button class="btn primary" data-action="report" data-id="lost" data-testid="new-report">분실 신고</button></div>
    </div>${renderView()}</main></div>
  </div>`;
}
function renderView(){if(view==='browse')return browse();if(view==='mine')return ownReports();if(view==='matches'||view==='admin-matches')return matches();if(view==='requests'||view==='admin-requests')return requests();if(view==='admin-items')return adminItems();if(view==='admin-users')return users();if(view==='settings')return settings();if(view==='activity')return activity();if(view==='notifications')return notifications();return help();}
function card(i){
  return `<button class="item-card" data-action="detail" data-id="${esc(i.id)}" data-testid="item-card">
    <div class="item-visual">${photo(i,true)}<span class="kind-label ${i.kind}">${i.kind==='found'?'습득물':'분실 신고'}</span>${i.specialHandling?'<span class="special-dot" title="특별 처리 물품">!</span>':''}</div>
    <div class="item-card-body"><div class="section-row"><span class="category">${esc(i.category)}</span>${badge(i.state)}</div>
      <h3>${esc(i.name)}</h3><p>${esc(i.location)}</p><div class="card-bottom"><span>${i.kind==='found'?'발견':'분실'} ${date(i.date)}</span><span>상세 보기</span></div>
    </div></button>`;
}
function browse(){
  const publicItems=S.items.filter(i=>i.kind==='lost'?i.state==='Open':['Stored','Recovery requested'].includes(i.state));
  const items=publicItems.filter(i=>(filter.kind==='all'||i.kind===filter.kind)&&(!filter.category||i.category===filter.category)&&(!filter.location||i.location.toLowerCase().includes(filter.location.toLowerCase()))&&(!filter.q||`${i.name} ${i.description}`.toLowerCase().includes(filter.q.toLowerCase()))&&(!filter.date||i.date===filter.date)&&(!filter.color||(i.color||'').includes(filter.color)));
  return `<section class="search-section">
    <div class="tabs" role="group" aria-label="물품 종류">${[['all','전체'],['found','습득물'],['lost','분실 신고']].map(([k,t])=>`<button class="tab ${filter.kind===k?'selected':''}" aria-pressed="${filter.kind===k}" data-action="kind" data-id="${k}">${t}</button>`).join('')}</div>
    <form data-form="search" class="search-bar" aria-label="물품 검색">
      <label class="keyword">이름·설명<input name="q" aria-label="물품 이름 또는 설명" placeholder="검색어" value="${esc(filter.q)}"></label>
      <label>분류<select name="category" aria-label="분류"><option value="">모든 분류</option>${categories().map(c=>`<option ${c===filter.category?'selected':''}>${esc(c)}</option>`).join('')}</select></label>
      <label>장소<input name="location" aria-label="장소" value="${esc(filter.location)}"></label>
      <label>색상<input name="color" aria-label="색상" value="${esc(filter.color)}"></label>
      <label>날짜<input name="date" aria-label="날짜" type="date" value="${esc(filter.date)}" max="${today()}"></label>
      <div class="search-actions"><button class="btn primary" type="submit">검색</button><button class="btn secondary" type="button" data-action="clear-search" aria-label="검색 초기화">초기화</button></div>
    </form>
    <div class="results-heading"><h2>${filter.kind==='found'?'습득물':filter.kind==='lost'?'분실 신고':'전체 신고'} <span>${items.length}건</span></h2><span class="tiny muted">최근 등록 순</span></div>
    ${items.length?`<div class="item-grid">${items.sort((a,b)=>b.createdAt.localeCompare(a.createdAt)).map(card).join('')}</div>`:empty('일치하는 신고가 없습니다.','검색 조건을 변경하거나 분실 신고를 등록하세요.')}
    <p class="search-note">반환은 관리자 소유권 확인 후 공식 접수처에서 진행합니다.</p>
  </section>`;
}
function ownReports(){const items=S.items.filter(isMine);return `<p class="muted space-bottom">총 ${items.length}건</p>${items.length?`<div class="item-grid">${items.map(card).join('')}</div>`:empty('등록한 신고가 없습니다.','상단의 분실 신고 또는 습득 신고를 선택하세요.')}`;}
function matches(){const admin=isAdmin()&&view==='admin-matches';return `${admin?`<div class="space-bottom">${btn('후보 직접 연결','add-match','','primary')}</div>`:''}${S.matches.length?`<div class="match-list">${S.matches.map(m=>{const lost=itemBy(m.lostId),found=itemBy(m.foundId);if(!lost||!found)return '';return `<article class="match-card"><div><span class="eyebrow">분실 신고</span><h3>${esc(lost.name)}</h3><p>${esc(lost.location)} · ${date(lost.date)}</p><button class="text-btn" data-action="detail" data-id="${esc(lost.id)}">신고 보기</button></div><span class="match-arrow">${ico('link',20)}</span><div><span class="eyebrow">매칭된 습득물</span><h3>${esc(found.name)}</h3><p>${esc(found.location)} · ${date(found.date)}</p>${btn('물품 확인','detail',found.id,'primary')}${admin?btn('연결 삭제','remove-match',m.id,'danger'):''}</div></article>`;}).join('')}</div>`:empty('매칭 후보가 없습니다.','조건이 일치하는 습득물이 등록되면 알림을 보냅니다.')}`;}
function requests(){const admin=isAdmin()&&view==='admin-requests';const list=S.requests.filter(r=>admin||r.userId===S.user.id);return `${list.length?`<div class="request-list">${list.slice().reverse().map(r=>requestCard(r,admin)).join('')}</div>`:empty('반환 신청이 없습니다.','습득물 상세 화면에서 반환을 신청할 수 있습니다.')}`;}
function requestCard(r,admin){const i=itemBy(r.itemId);return `<article class="panel request-card"><div class="section-row"><div><span class="tiny muted">${dateTime(r.createdAt)}${admin?' · '+esc(userName(r.userId)):''}</span><h3>${esc(i?.name||'물품')} ${badge(r.status)}</h3></div>${btn('물품 보기','detail',r.itemId)}</div><div class="proof-grid"><div><span class="field-label">신원 정보</span><p>${esc(r.identity)}</p></div><div><span class="field-label">신청자가 설명한 특징</span><p class="preline">${esc(r.evidence)}</p></div>${admin?`<div class="confidential"><span class="field-label">관리자가 기록한 비공개 특징</span><p class="preline">${esc(i?.confidential||'기록 없음')}</p></div>`:''}</div>${r.reason?`<div class="notice">${esc(r.reason)}</div>`:''}${['Approved','Completed'].includes(r.status)&&!i?.blocked?`<div class="pickup-box">${ico('pin',24)}<div>${admin?`<strong>${esc(r.pickupLocation||'수령 장소 확인 중')}</strong><p>${esc(r.department||'')}</p>`:`<strong>${r.status==='Completed'?'인도가 완료되었습니다.':'반환 신청이 승인되었습니다.'}</strong><p>수령 장소를 확인하면 열람 이력이 기록됩니다.</p>${btn('수령 장소 확인','pickup',r.id,'primary')}`}</div></div>`:''}<div class="action-row">${admin&&['Pending','More proof'].includes(r.status)&&!i?.blocked?`${btn('반환 승인','request-approve',r.id,'primary')}${btn('거절','request-reject',r.id,'danger')}${r.status==='Pending'?btn('추가 증빙 요청','request-more',r.id):''}`:''}${!admin&&r.status==='More proof'&&!i?.blocked?btn('증빙 보완하기','request-supplement',r.id,'primary'):''}${admin&&r.status==='Approved'&&i?.state==='Ownership verified'?btn('물품 인도 완료','handover',i.id,'primary'):''}</div></article>`;}
function adminItems(){const list=S.items.filter(i=>!filter.state||i.state===filter.state);return `<div class="stats-row"><div class="stat-card"><span>접수 대기</span><strong>${S.items.filter(i=>i.state==='Registered').length}</strong></div><div class="stat-card"><span>반환 검토 중</span><strong>${S.items.filter(i=>i.state==='Recovery requested').length}</strong></div><div class="stat-card"><span>수령 대기</span><strong>${S.items.filter(i=>i.state==='Ownership verified').length}</strong></div><div class="stat-card"><span>장기 미수령</span><strong>${S.items.filter(i=>i.unclaimed).length}</strong></div></div><form class="inline-filter" data-form="admin-filter">${select('state','상태 필터',[['','모든 상태'],...['Open','Closed','Withdrawn','Registered','Stored','Recovery requested','Ownership verified','Recovered','Disposed'].map(s=>[s,stateLabel[s]])],filter.state,false)}<button class="btn secondary" type="submit">적용</button></form><div class="panel table-wrap"><table><thead><tr><th>물품</th><th>분류 / 종류</th><th>발생 장소</th><th>날짜</th><th>상태</th><th>관리</th></tr></thead><tbody>${list.map(i=>`<tr><td><strong>${esc(i.name)}</strong>${i.blocked?'<small class="danger-text">사고 처리 중</small>':''}${i.unclaimed?'<small class="amber-text">장기 미수령</small>':''}</td><td>${esc(i.category)}<small>${i.kind==='lost'?'분실 신고':'습득물'}${i.specialHandling?' · 특별 처리':''}</small></td><td>${esc(i.location)}</td><td>${date(i.date)}</td><td>${badge(i.state)}</td><td>${btn('관리','detail',i.id)}</td></tr>`).join('')||'<tr><td colspan="6">해당 상태의 물품이 없습니다.</td></tr>'}</tbody></table></div>`;}
function users(){return `<div class="panel table-wrap"><table><thead><tr><th>사용자</th><th>역할</th><th>상태</th><th>증빙</th><th>관리</th></tr></thead><tbody>${(S.users||[]).map(u=>`<tr><td><strong>${esc(u.name)}</strong><small>${esc(u.email)}</small></td><td>${u.role==='Administrator'?'관리자':'일반 사용자'}</td><td>${badge(u.status)}</td><td>${u.document?btn('증빙 보기','document',u.id):'<span class="muted">—</span>'}</td><td><div class="table-actions">${u.status==='pending_admin'?`${btn('가입 승인','user-approve',u.id,'primary')}${btn('거절','user-reject',u.id,'danger')}`:''}${u.status==='active'?`${btn('이용 정지','user-block',u.id,'danger')}${btn(u.role==='User'?'관리자 지정':'일반 사용자로','user-role',u.id)}`:''}${u.status==='blocked'?btn('정지 해제','user-unblock',u.id):''}</div></td></tr>`).join('')}</tbody></table></div>`;}
function settings(){return `<section class="panel settings-panel"><h2>보관 및 데이터 정책</h2><p class="muted">기간은 일 단위로 입력해 주세요. 변경된 기간은 목록과 처리 가능 여부에 반영됩니다.</p><form class="form" data-form="settings"><div class="form-error hidden" role="alert"></div><div class="form-grid">${input('storedDays','습득물 보관 기간',S.settings.storedDays,'number',true,'min="1" max="3650"')}${input('lostDays','분실 신고 유지 기간',S.settings.lostDays,'number',true,'min="1" max="3650"')}${input('dataRetentionDays','완료 데이터 보존 기간',S.settings.dataRetentionDays,'number',true,'min="1" max="3650"')}</div>${input('dropoffLocation','공식 접수·수령 장소',S.settings.dropoffLocation)}${input('department','담당 부서',S.settings.department)}<div class="form-footer"><button class="btn primary" type="submit">설정 저장</button></div></form></section><section class="panel settings-panel space-top"><h2>데이터 백업</h2><p class="muted">자동 백업은 하루 한 번 생성되며 최근 7개를 보관합니다. 수동 백업으로 현재 데이터를 별도로 저장할 수 있어요.</p>${S.maintenance?.backupError?`<div class="form-error" role="alert">자동 백업을 만들지 못했습니다. 데이터 폴더의 남은 공간과 쓰기 권한을 확인한 뒤 다시 시도해 주세요.</div>`:''}${S.maintenance?.lastBackupAt?`<p class="tiny muted">최근 자동 백업 확인: ${dateTime(S.maintenance.lastBackupAt)}</p>`:''}<div class="action-row">${btn('현재 데이터 백업','backup','','primary')}</div><p class="field-hint">복구에는 서버 데이터 폴더의 encryption.key가 함께 필요합니다.</p></section>`;}
function activity(){return `<section class="panel"><h2>접수된 문의</h2>${S.issues?.length?S.issues.map(i=>`<div class="log-row"><span>${dateTime(i.createdAt)} · ${esc(userName(i.userId))}</span><p class="preline">${esc(i.message)}</p></div>`).join(''):'<p class="muted">접수된 문의가 없습니다.</p>'}</section><section class="panel space-top"><h2>작업 이력</h2><div class="table-wrap"><table><thead><tr><th>일시</th><th>처리자</th><th>작업</th><th>대상</th></tr></thead><tbody>${(S.audit||[]).map(a=>`<tr><td>${dateTime(a.createdAt)}</td><td>${esc(userName(a.actorId))}</td><td>${esc(a.action)}</td><td class="mono">${esc(a.targetId)}</td></tr>`).join('')}</tbody></table></div></section>`;}
function notifications(){return `<div class="section-row space-bottom"><p class="muted">총 ${S.notifications.length}건</p>${btn('모두 읽음','read-notifications')}</div><div class="panel">${S.notifications.length?S.notifications.map(n=>`<button class="notification-row ${n.read?'':'unread'}" data-action="notification" data-id="${esc(n.id)}"><div><p>${esc(n.message)}</p><small>${dateTime(n.createdAt)}</small></div>${!n.read?'<span class="small-dot" aria-label="읽지 않음"></span>':''}</button>`).join(''):empty('알림이 없습니다.')}</div>`;}
function help(){
  const guides=[
    ['분실 신고','물품명, 분류, 장소, 날짜와 특징을 입력하세요. 조건이 일치하는 습득물이 등록되면 매칭 후보와 알림을 확인할 수 있습니다.'],
    ['습득 신고','신고 후 안내된 공식 접수처에 물품을 맡기세요. 보관 등록, 정보 정정, 인도 처리는 관리자가 담당합니다.'],
    ['반환 신청','습득물 상세 화면에서 반환을 신청하세요. 신원 정보와 본인만 아는 특징을 제출하면 관리자가 확인합니다. 승인 후 수령 장소를 확인할 수 있습니다.'],
    ['회원가입','KAIST 이메일은 이메일 인증이 필요합니다. 외부 사용자는 소속 증빙 문서를 제출하고 관리자 승인을 받아야 합니다.']
  ];
  return `<div class="help-grid">${guides.map(([title,description])=>`<article class="panel"><h2>${title}</h2><p>${description}</p></article>`).join('')}</div>
    <p class="search-note">연락처와 비밀 식별 특징은 공개 설명에 작성하지 마세요. 비밀 특징은 반환 신청에만 제출하세요.</p>
    <section class="panel space-top"><h2>문의</h2><p class="muted">사용 중 발생한 오류나 문의를 남기면 관리자가 확인합니다.</p>
      <form data-form="issue" class="form"><div class="form-error hidden" role="alert"></div>${textarea('message','문의 내용')}<div class="form-footer"><button class="btn primary" type="submit">문의 보내기</button></div></form>
    </section>`;
}
function report(kind,id){const i=id?itemBy(id):null;kind=i?.kind||kind;showModal(i?'신고 내용 수정':kind==='lost'?'분실 신고':'습득 신고',formBody('report',`<div class="report-switch">${!i?`${btn('분실 신고','report','lost',kind==='lost'?'primary':'secondary')}${btn('습득 신고','report','found',kind==='found'?'primary':'secondary')}`:''}</div>${input('name','물품명',i?.name||'','text',true,'maxlength="100" placeholder="예: 검정색 무선 이어폰"')}<div class="form-grid">${select('category','분류',categories(),i?.category||categories()[0])}${input('color','색상 (선택)',i?.color||'','text',false,'maxlength="50"')}</div><div class="form-grid">${input('location',kind==='lost'?'분실 추정 장소':'발견 장소',i?.location||'')}${input('date',kind==='lost'?'분실 날짜':'발견 날짜',i?.date||today(),'date',true,`max="${today()}"`)}</div>${input('occurredTime',kind==='lost'?'분실 추정 시각 (선택)':'발견 시각 (선택)',i?.occurredTime||'','time',false)}${textarea('description','공개 설명',i?.description||'')}<p class="field-hint">소유권 확인에 사용할 비밀 특징이나 개인정보는 공개 설명에 쓰지 마세요.</p><label>사진 (선택)<input type="file" name="image" accept="image/png,image/jpeg,image/webp,image/gif"><span class="field-hint">PNG, JPG, WebP, GIF · 최대 2MB</span></label><label>카메라로 촬영 (선택)<input type="file" name="camera" accept="image/*" capture="environment"></label>${i&&kind==='found'&&isAdmin()&&(i.storageLocation||i.confidential)?input('storageLocation','보관 장소',i.storageLocation||'','text',false)+textarea('confidential','비공개 식별 특징',i.confidential||'',false):''}${i?.image?'<label class="checkbox"><input name="removeImage" type="checkbox"> 기존 사진 삭제</label>':''}`,i?'수정 저장':'신고 등록'),{kind,id});}
function detail(id){const i=itemBy(id);if(!i){toast('현재 볼 수 없는 물품입니다.');return;}let actions='';const admin=isAdmin();if(i.blocked){if(admin)actions=(i.kind==='found'?btn('정보 수정','edit',id):'')+btn('사고 해결 처리','resolve',id,'primary');}else if(admin&&i.kind==='found'){actions+=btn('정보 수정','edit',id);if(i.state==='Registered')actions+=btn('검사·보관 등록','intake',id,'primary');if(!['Recovered','Disposed'].includes(i.state))actions+=btn(i.specialHandling?'특별 처리 해제':'특별 처리 표시','toggle-special',id);if(i.state==='Stored')actions+=btn('보관 기록 추가','note',id);if(i.state==='Ownership verified')actions+=btn('인도 완료','handover',id,'primary');if(i.unclaimed&&i.state==='Stored')actions+=btn('폐기·기부 처리','dispose',id,'danger');if(i.specialHandling&&!['Recovered','Disposed'].includes(i.state))actions+=btn('관계 기관 이관','authorities',id,'danger');if(i.state==='Recovered')actions+=btn('잘못된 인도 신고','report-error',id,'danger');}if(isMine(i)&&i.kind==='lost'&&i.state==='Open'&&!i.blocked)actions+=btn('신고 수정','edit',id)+btn('신고 철회','withdraw',id,'danger');if(admin&&i.kind==='lost'&&i.state==='Open'&&Date.now()-new Date(i.createdAt)>S.settings.lostDays*86400000)actions+=btn('오래된 신고 삭제','delete-item',id,'danger');if(i.kind==='found'&&['Stored','Recovery requested'].includes(i.state)&&!isMine(i)&&!i.blocked&&!S.requests.some(r=>r.itemId===id&&r.userId===S.user.id&&['Pending','More proof','Approved','Completed'].includes(r.status)))actions+=btn('반환 신청','new-request',id,'primary');
const approvedRequest=S.requests.find(r=>r.itemId===id&&r.userId===S.user.id&&['Approved','Completed'].includes(r.status));const linked=S.matches.filter(m=>m.lostId===id).map(m=>itemBy(m.foundId)).filter(Boolean);showModal(esc(i.name),`<div class="detail-body"><div class="detail-visual">${photo(i)}</div><div class="detail-status">${badge(i.state)}<span class="tiny muted">${i.kind==='found'?'습득물':'분실 신고'} · ${esc(i.category)}${i.color?' · '+esc(i.color):''}</span>${i.specialHandling?'<span class="badge warning">특별 처리</span>':''}</div>${i.blocked?'<div class="form-error">잘못된 인도에 대한 사고 처리 중입니다. 관리자 해결 전까지 이용이 제한됩니다.</div>':''}<dl class="detail-facts"><div><dt>발생 장소</dt><dd>${esc(i.location)}</dd></div><div><dt>발생 날짜</dt><dd>${esc(i.date)}${i.occurredTime?' '+esc(i.occurredTime):''}</dd></div><div><dt>등록일</dt><dd>${date(i.createdAt)}</dd></div></dl><h3>물품 설명</h3><p class="preline detail-description">${esc(i.description)}</p>${admin&&i.kind==='found'?`<section class="confidential"><h3>관리자 전용</h3><p><strong>보관 장소</strong> ${esc(i.storageLocation||'미접수')}</p><p class="preline"><strong>비공개 특징</strong> ${esc(i.confidential||'미기록')}</p>${i.notes?.length?`<h4>보관 이력</h4>${i.notes.map(n=>`<p class="tiny">${dateTime(n.createdAt)} · ${esc(n.note||n.text||'')}</p>`).join('')}`:''}</section>`:''}${approvedRequest&&!i.blocked?`<div class="pickup-box"><div><p>승인된 신청의 수령 장소를 확인할 수 있습니다.</p>${btn('수령 장소 확인','pickup',approvedRequest.id,'primary')}</div></div>`:''}${i.unclaimed?'<div class="notice">보관 기간이 지난 미수령 물품입니다.</div>':''}${isMine(i)&&i.kind==='found'&&i.state==='Registered'?`<div class="notice">신고가 접수되었습니다. ${esc(S.settings.dropoffLocation)}에 물품을 가져다주세요.</div>`:''}${linked.length?`<h3>매칭된 습득물</h3><div class="candidate-list">${linked.map(f=>`<button class="candidate" data-action="detail" data-id="${esc(f.id)}"><strong>${esc(f.name)}</strong><span>${esc(f.location)} · ${date(f.date)}</span></button>`).join('')}</div>`:''}<div class="action-row">${actions}</div></div>`);}
function simpleAction(action,id){const i=itemBy(id);const configs={intake:['검사·보관 등록',input('storageLocation','보관 장소',S.settings.dropoffLocation)+textarea('confidential','비공개 식별 특징')+'<p class="field-hint">소유자 확인에 사용할 특징을 적어주세요. 일반 사용자에게 공개되지 않습니다.</p>','보관 등록'],note:['보관 기록 추가',textarea('note','상태·점검 기록'),'기록 저장'],dispose:['미수령 물품 처리',select('method','처리 방법',[['dispose','폐기'],['donate','기부']])+textarea('reason','처리 사유'),'처리 완료'],authorities:['관계 기관 이관',textarea('reason','이관 기관 및 사유'),'이관 기록'],handover:['물품 인도 완료',`<p><strong>${esc(i?.name)}</strong>을 승인된 소유자에게 전달했나요?</p><div class="notice">인도 일시와 처리 관리자가 기록되고, 연결된 분실 신고가 종료됩니다.</div>`,'인도 완료'],withdraw:['분실 신고 철회','<p>이 신고를 철회할까요? 철회한 신고는 검색에서 제외됩니다.</p>','철회'], 'report-error':['잘못된 인도 신고',textarea('reason','사고 내용'),'사고 신고'],resolve:['사고 해결 처리',textarea('reason','해결 내용'),'해결 완료'],'delete-item':['오래된 신고 삭제','<p>유지 기간이 지난 분실 신고를 삭제할까요?</p>','삭제']};const c=configs[action];showModal(c[0],formBody('item-action',c[1],c[2]),{id,action});}
function newRequest(id){const own=S.items.filter(i=>isMine(i)&&i.kind==='lost'&&i.state==='Open');const identity=[S.user?.name,S.user?.email].filter(Boolean).join(' · ');showModal('반환 신청',formBody('new-request',`<div class="notice">본인만 아는 물품의 특징을 적어주세요. 관리자가 접수 당시 기록과 비교해 확인합니다.</div>${input('identity','신원 정보 (이름·학번 또는 소속)',identity,'text',true,'maxlength="500"')}${textarea('evidence','소유를 증명할 비공개 특징')}${select('lostReportId','내 분실 신고 연결 (선택)',[['','연결하지 않음'],...own.map(i=>[i.id,i.name])],'',false)}`,'반환 신청'),{id});}
function requestAction(action,id){const r=S.requests.find(r=>r.id===id),i=itemBy(r.itemId);let title,fields,submit;if(action==='request-approve'){title='반환 승인';fields=`<div class="notice">${i?.specialHandling?'특별 처리 물품입니다. 안전한 반환 장소를 별도로 지정해 주세요.':'다른 대기 신청은 자동으로 거절되며, 승인된 사용자에게만 수령 장소가 공개됩니다.'}</div>${input('pickupLocation','공식 수령 장소',i?.specialHandling?'':S.settings.dropoffLocation)}${input('department','담당 부서',S.settings.department)}`;submit='승인';}else if(action==='request-supplement'){title='증빙 보완';fields=`<div class="notice preline">기존 증빙: ${esc(r.evidence)}</div>`+textarea('evidence','추가 소유 증빙');submit='보완 제출';}else{title=action==='request-reject'?'반환 거절':'추가 증빙 요청';fields=textarea('reason',action==='request-reject'?'거절 사유':'추가로 필요한 증빙');submit=title;}showModal(title,formBody('request-action',fields,submit),{id,action});}
function register(){showModal('회원가입',formBody('register',`${input('name','이름','','text',true,'autocomplete="name" maxlength="80"')}${input('email','이메일','','email',true,'autocomplete="email"')}${input('password','비밀번호','','password',true,'minlength="10" maxlength="128" autocomplete="new-password"')}${input('confirmPassword','비밀번호 확인','','password',true,'minlength="10" maxlength="128" autocomplete="new-password"')}<p class="field-hint">비밀번호는 10자 이상으로 설정해 주세요.</p><label>신원 증빙 (KAIST 이메일이 없는 외부 사용자 필수)<input name="document" type="file" accept="application/pdf,image/png,image/jpeg"><span class="field-hint">재학·재직 등 신원과 소속을 확인할 수 있는 문서 · PDF, PNG, JPG · 최대 2MB</span></label><div class="notice">KAIST 이메일은 이메일 인증 후 이용할 수 있습니다. 외부 사용자는 증빙 문서에 대한 관리자 승인이 필요합니다.</div>`,'가입 신청'));}
function verify(email='',code=''){showModal('이메일 확인',formBody('verify',`${code?`<div class="notice">시연용 이메일 확인 코드: <strong>${esc(code)}</strong></div>`:''}${input('email','가입 이메일',email,'email')}${input('code','이메일 확인 코드',code,'text',true,'autocomplete="one-time-code"')}`,'확인'));}
function profile(){showModal('내 계정',formBody('profile',`${input('name','이름',S.user.name)}<p class="muted">${esc(S.user.email)}</p>${input('currentPassword','현재 비밀번호 (비밀번호 변경 시)','','password',false,'autocomplete="current-password"')}${input('password','새 비밀번호 (선택)','','password',false,'minlength="10" autocomplete="new-password"')}`,'저장'));}
function addMatch(){const lost=S.items.filter(i=>i.kind==='lost'&&i.state==='Open'),found=S.items.filter(i=>i.kind==='found'&&['Stored','Recovery requested'].includes(i.state));if(!lost.length||!found.length){toast('연결 가능한 신고와 반환 가능한 물품이 필요합니다.');return;}showModal('매칭 후보 직접 연결',formBody('add-match',select('lostId','분실 신고',lost.map(i=>[i.id,`${i.name} · ${i.location}`]))+select('foundId','습득물',found.map(i=>[i.id,`${i.name} · ${i.location}`])),'연결'))}
// Decode photographs before transmission; MIME labels alone do not guarantee a usable image.
async function readFile(file,kind='image'){if(!file?.size)return null;if(file.size>2*1024*1024)throw new Error('파일 크기는 2MB 이하여야 합니다.');const allowed=kind==='image'?['image/jpeg','image/png','image/webp','image/gif']:['application/pdf','image/jpeg','image/png'];if(!allowed.includes(file.type))throw new Error('지원하지 않는 파일 형식입니다.');return new Promise((resolve,reject)=>{const reader=new FileReader();reader.onload=async()=>{if(file.type.startsWith('image/')){try{await new Promise((ok,no)=>{const picture=new Image();picture.onload=()=>picture.naturalWidth&&picture.naturalHeight?ok():no();picture.onerror=no;picture.src=reader.result;});}catch{reject(new Error('이미지를 열 수 없습니다. 올바른 사진 파일을 선택해 주세요.'));return;}}resolve({name:file.name,type:file.type,data:reader.result});};reader.onerror=()=>reject(new Error('파일을 읽지 못했습니다.'));reader.readAsDataURL(file);});}
async function pickup(requestId) {
  const identity = S.user?.id;
  try {
    const result = await api(`/requests/${requestId}/pickup`, 'POST', {});
    if (S.user?.id !== identity) return;
    showModal('승인된 수령 장소', `<div class="detail-body"><div class="pickup-box">${ico('pin', 24)}<div><strong>${esc(result.pickupLocation)}</strong><p>${esc(result.department)}</p></div></div><p class="field-hint">수령 장소 열람 이력이 기록되었습니다. 담당 부서의 안내에 따라 방문해 주세요.</p></div>`);
  } catch (error) {
    $('#modal').close();
    await refresh().catch(() => {});
    throw error;
  }
}
async function after(message = '저장되었습니다.') {
  const dialog = $('#modal');
  if (dialog.open) dialog.close();
  try {
    await refresh();
    toast(message);
  } catch {
    // The mutation already succeeded. A failed refresh must not hide its result
    // in an error box belonging to the dialog that has just closed.
    toast(`${message} 화면을 갱신하지 못했습니다. 연결을 확인한 후 다시 열어 주세요.`);
  }
}
document.addEventListener('click',async e=>{const b=e.target.closest('[data-action]');if(!b)return;const {action,id}=b.dataset;try{if(action==='noop')return;if(action==='close'){$('#modal').close();return;}if(action==='nav'){if($('#modal').open)$('#modal').close();view=id;filter.state='';render();window.scrollTo(0,0);await refresh({background:true});return;}if(action==='demo-user'){const f=$('[data-form="login"]');f.elements.email.value=id+'@kaist.ac.kr';f.elements.password.value='CampusDemo!24';f.querySelector('button[type=submit]').focus();return;}if(action==='register')return register();if(action==='verify')return verify();if(action==='profile')return profile();if(action==='report')return report(id);if(action==='edit')return report('',id);if(action==='detail')return detail(id);if(action==='notification'){const n=S.notifications.find(n=>n.id===id);if(!n)return;if(!n.read){await api(`/notifications/${id}/read`,'POST',{});n.read=true;}render();if(n.itemId)detail(n.itemId);return;}if(action==='kind'){filter.kind=id;render();return;}if(action==='clear-search'){filter={kind:filter.kind,q:'',category:'',location:'',date:'',color:'',state:''};render();return;}if(action==='pickup'){b.disabled=true;await pickup(id);return;}if(action==='new-request')return newRequest(id);if(action.startsWith('request-'))return requestAction(action,id);if(['intake','note','dispose','authorities','handover','withdraw','report-error','resolve','delete-item'].includes(action))return simpleAction(action,id);if(action==='add-match')return addMatch();if(action==='document'){const u=S.users.find(u=>u.id===id);if(!u?.document)return;const d=u.document;showModal('가입 증빙 문서',`<div class="detail-body"><p>${esc(u.name)} · ${esc(d.name)}</p>${d.type?.startsWith('image/')?`<img class="document-image" src="${esc(d.data)}" alt="가입 증빙 문서">`:'<p>PDF 문서입니다. 내려받아 검토해 주세요.</p>'}<a class="btn primary" href="${esc(d.data)}" download="${esc(d.name)}">문서 내려받기</a></div>`);return;}if(action.startsWith('user-')){const u=S.users.find(u=>u.id===id);const a=action.slice(5);showModal('계정 관리',formBody('user-action',`<p><strong>${esc(u.name)}</strong> 계정의 ${a==='approve'?'가입을 승인':a==='reject'?'가입을 거절':a==='block'?'이용을 정지':a==='unblock'?'이용 정지를 해제':u.role==='User'?'관리자 권한을 부여':'권한을 일반 사용자로 변경'}할까요?</p>${['reject','block'].includes(a)?textarea('reason','사유'):''}`,'확인'),{id,action:a,role:u.role==='User'?'Administrator':'User'});return;}if(action==='install'){if(installPrompt){await installPrompt.prompt();installPrompt=null;}else showModal('앱으로 이용하기',`<div class="detail-body"><p>주소창의 설치 버튼이나 브라우저 메뉴에서 <strong>앱 설치</strong>를 선택해 주세요.</p><p>iPhone·iPad에서는 Safari의 공유 메뉴에서 <strong>홈 화면에 추가</strong>를 선택할 수 있어요.</p><div class="notice">신고와 조회에는 인터넷 연결이 필요합니다.</div></div>`);return;}b.disabled=true;if(action==='logout'){await api('/auth/logout','POST',{});refreshId++;S=emptyState();view='browse';render();return;}if(action==='backup'){const result=await api('/backup','POST',{});await after(result.message||'현재 데이터의 백업을 만들었습니다.');return;}if(action==='toggle-special')await api(`/items/${id}/action`,'POST',{action:'special',value:!itemBy(id).specialHandling});if(action==='remove-match')await api('/matches/'+id,'DELETE',{});if(action==='read-notifications')await api('/notifications/read','POST',{});await after(action==='read-notifications'?'모두 읽음으로 표시했어요.':'처리되었습니다.');}catch(err){if(err.status===401){S=emptyState();$('#modal').close();render();}toast(err.message);}finally{if(b.isConnected)b.disabled=false;}});
document.addEventListener('input', event => {
  const form = event.target.closest('form[data-form="report"]');
  if (!form || !modalContext.confirmDuplicate) return;
  modalContext.confirmDuplicate = false;
  const submit = form.querySelector('button[type="submit"]');
  if (submit) submit.textContent = '신고 등록';
  const error = form.querySelector('.form-error');
  if (error) error.classList.add('hidden');
});
document.addEventListener('submit',async e=>{const f=e.target.closest('form[data-form]');if(!f)return;e.preventDefault();const type=f.dataset.form,fd=new FormData(f),values=Object.fromEntries(fd),error=f.querySelector('.form-error');if(error){error.textContent='';error.classList.add('hidden');}const submits=[...f.querySelectorAll('button[type=submit]')];submitting++;submits.forEach(b=>b.disabled=true);try{if(type==='search'){filter={...filter,...values};render();return;}if(type==='admin-filter'){filter.state=values.state;render();return;}if(type==='login'){await api('/auth/login','POST',values);clearTimeout(toast.timer);$('#toast').classList.add('hidden');view='browse';await refresh();return;}if(type==='register'){if(values.password!==values.confirmPassword){f.elements.namedItem('confirmPassword').focus();throw new Error('비밀번호와 비밀번호 확인이 일치하지 않습니다.');}const doc=await readFile(fd.get('document'),'document');const result=await api('/auth/register','POST',{name:values.name,email:values.email,password:values.password,...(doc?{document:doc}:{})});if(result.demoCode)verify(values.email,result.demoCode);else{$('#modal').close();toast(result.message||'가입 신청이 접수되었습니다. 관리자 승인 후 로그인해 주세요.');}return;}if(type==='verify'){await api('/auth/verify','POST',values);$('#modal').close();toast('이메일 확인이 완료되었습니다. 로그인해 주세요.');return;}if(type==='report'){const {id,kind}=modalContext;const image=await readFile(fd.get('camera')?.size?fd.get('camera'):fd.get('image'));const body={kind,name:values.name,category:values.category,color:values.color,location:values.location,date:values.date,occurredTime:values.occurredTime||'',description:values.description,...(id&&kind==='found'&&isAdmin()&&f.elements.storageLocation?{storageLocation:values.storageLocation,confidential:values.confidential}:{}),...(image?{image:image.data}:values.removeImage?{image:null}:{}),...(modalContext.confirmDuplicate?{confirmDuplicate:true}:{})};try{await api(id?'/items/'+id:'/items',id?'PATCH':'POST',body);}catch(err){if(err.code==='DUPLICATE'){modalContext.confirmDuplicate=true;error.textContent='같은 분류·장소·날짜의 습득물 신고가 있습니다. 내용을 확인하고, 별도 물품이 맞으면 다시 등록해 주세요.';error.classList.remove('hidden');f.querySelector('button[type=submit]').textContent='별도 물품으로 등록';return;}else throw err;}await after(kind==='found'?`습득 신고가 접수되었어요. ${S.settings.dropoffLocation}에 물품을 가져다주세요.`:'분실 신고가 등록되었어요.');return;}if(type==='item-action'){const {id,action}=modalContext;await api(`/items/${id}/action`,'POST',{...values,action:action==='authorities'?'dispose':action==='delete-item'?'delete':action,...(action==='authorities'?{method:'authorities'}:{})});await after('처리되었습니다.');return;}if(type==='new-request'){const body={itemId:modalContext.id,...values};if(!body.lostReportId)delete body.lostReportId;await api('/requests','POST',body);view='requests';await after('반환 신청이 접수되었습니다.');return;}if(type==='request-action'){const {id,action}=modalContext;const a={'request-approve':'approve','request-reject':'reject','request-more':'more-proof','request-supplement':'supplement'}[action];await api(`/requests/${id}/action`,'POST',{...values,action:a});await after('반환 신청이 처리되었습니다.');return;}if(type==='user-action'){await api(`/users/${modalContext.id}/action`,'POST',{...values,action:modalContext.action,role:modalContext.role});await after('계정이 변경되었습니다.');return;}if(type==='add-match'){await api('/matches','POST',values);await after('매칭 후보를 연결했습니다.');return;}if(type==='settings'){await api('/settings','PATCH',{...values,storedDays:Number(values.storedDays),lostDays:Number(values.lostDays),dataRetentionDays:Number(values.dataRetentionDays)});await after('운영 설정을 저장했습니다.');return;}if(type==='profile'){const body={name:values.name};if(values.password){body.currentPassword=values.currentPassword;body.password=values.password;}await api('/profile','PATCH',body);await after('내 계정을 변경했습니다.');return;}if(type==='issue'){await api('/issues','POST',values);await after('문의가 접수되었습니다.');}}catch(err){
  if(err.status===401&&type!=='login'){
    S=emptyState();$('#modal').close();render();toast(err.message);
  }else if(error){
    error.textContent=err.message;error.classList.remove('hidden');error.scrollIntoView({block:'nearest'});
  }else toast(err.message);
}finally{submitting--;submits.forEach(b=>b.disabled=false);}});
$('#modal').addEventListener('click',e=>{if(e.target===$('#modal')){const r=e.target.getBoundingClientRect();if(e.clientX<r.left||e.clientX>r.right||e.clientY<r.top||e.clientY>r.bottom)e.target.close();}});
window.addEventListener('beforeinstallprompt',e=>{e.preventDefault();installPrompt=e;});
function network(){$('#network').classList.toggle('hidden',navigator.onLine);}window.addEventListener('offline',network);window.addEventListener('online',()=>{network();if(S.user)refresh({background:true}).catch(e=>toast(e.message));});network();
document.addEventListener('visibilitychange',()=>{if(!document.hidden&&S.user&&navigator.onLine&&!$('#modal').open)refresh({background:true}).catch(()=>{});});
setInterval(()=>{if(S.user&&navigator.onLine&&!document.hidden&&!$('#modal').open&&!['INPUT','TEXTAREA','SELECT'].includes(document.activeElement?.tagName))refresh({background:true}).catch(()=>{});},20000);
if('serviceWorker'in navigator)navigator.serviceWorker.register('/sw.js').catch(()=>{});
try{const session=await api('/session');S={...S,...session};if(S.user)await refresh();else render();}catch(e){render();toast(e.message);}
