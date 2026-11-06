# Campus Found API contract

Local demo, Node.js 24+, no package dependencies. JSON requests/responses. Errors `{error, code?, duplicate?}`. Session HttpOnly cookie. All changes same-origin. Two roles `User`, `Administrator`. Dates YYYY-MM-DD. All UI copy Korean.

## Authentication
- GET `/api/session` → `{user:null|User,demo:true,settings}`. Public user `{id,name,email,role,status}`. Settings `{storedDays:30,lostDays:90,dataRetentionDays:180,dropoffLocation:'학생지원팀 분실물 접수처',department:'학생지원팀'}`.
- POST `/api/auth/register` `{name,email,password,document?}`. document/file is `{name,type,data}`; data is base64 data URL. KAIST → pending_email, other → pending_admin (document mandatory). Returns `{message,demoCode?}`.
- POST `/api/auth/verify` `{email,code}` → `{message}`.
- POST `/api/auth/login` `{email,password}` → `{user}`; POST `/api/auth/logout`.
- Demo accounts all password `CampusDemo!24`: admin@kaist.ac.kr, minji@kaist.ac.kr, finder@kaist.ac.kr.

## Read
GET `/api/data` → `{user,items,requests,matches,notifications,settings,users?,audit?,issues?}`. Admin gets all, normal users get own reports + public active reports + own requested items. Private fields filtered server-side. Own request information never exposed to others.
- item `{id,kind:'lost'|'found',name,category,location,date,occurredTime?:'HH:mm'|'',description,color,image:null|string,state,ownerId,createdAt,updatedAt,specialHandling,blocked,unclaimed,storageLocation?,confidential?,intakeAt?,notes?}`. image data URL. Only admin sees storageLocation/confidential/notes and internal incident/disposal comments. Pickup details are never included in non-admin list responses; use the audited pickup endpoint. Non-admin ownerId is id only, no identity.
- lost states `Open,Closed,Withdrawn`; found `Registered,Stored,Recovery requested,Ownership verified,Recovered,Disposed`.
- request `{id,itemId,userId,lostReportId?,identity?,evidence?,status:'Pending'|'More proof'|'Approved'|'Rejected'|'Completed',reason?,createdAt,updatedAt,pickupLocation?,department?}`. Requester/admin only. Pickup fields in list responses are administrator-only; requesters use the audited endpoint. Admin gets requester name via users.
- match `{id,lostId,foundId,createdAt}`; users get own lost report matches, ordered same location then newest found date.
- notification `{id,userId,message,itemId?,read,createdAt}`.
- admin-only maintenance `{backupError:null|string,lastBackupAt:null|string}`. Backup failure does not undo an already committed business change. Manual backup failure returns 503.
- admin users `{id,name,email,role,status:'active'|'pending_email'|'pending_admin'|'rejected'|'blocked',document?}`; audit `{id,actorId,action,targetId,createdAt}`; issues `{id,userId,message,createdAt}`.

## Mutate
- POST `/api/items` `{kind,name,category,location,date,occurredTime?,description,color?,image?,confirmDuplicate?:true}` → `{item}`. Optional occurrence time uses 24-hour HH:mm; unknown time may be omitted. Found duplicate category/location/date yields 409 `{code:'DUPLICATE',error}` unless confirmed. Keyword/color and other search filters run on the authorized `/api/data` collection in the demo client.
- PATCH `/api/items/:id` editable content fields. Only lost owner while Open, or admin (found). No arbitrary state changes.
- POST `/api/items/:id/action` `{action,...}` → `{item?}`:
  - withdraw (own Open lost)
  - intake (admin Registered found) `{storageLocation,confidential}`
  - note (admin Stored found) `{note}`
  - special (admin found) `{value:boolean}`
  - dispose (admin, unclaimed Stored OR special nonterminal found) `{reason,method:'dispose'|'donate'|'authorities'}`
  - handover (admin Ownership verified)
  - report-error (admin Recovered) `{reason}`
  - resolve (admin blocked) `{reason}`
  - delete (admin lost Open older than lostDays)
- POST `/api/requests` `{itemId,lostReportId?,identity,evidence}` → `{request}`. Found owner forbidden; account active; duplicate active request by same user forbidden.
- POST `/api/requests/:id/action` `{action,...}` → `{request}`:
  - approve (admin Pending/More proof) `{pickupLocation,department}` mandatory, explicit special location for hazardous
  - reject (admin Pending/More proof) `{reason}`
  - more-proof (admin Pending) `{reason}`
  - supplement (requester More proof) `{evidence}` → Pending
- POST `/api/requests/:id/pickup` `{}` → `{pickupLocation,department}`. Only the approved/completed requester, when the item is not incident-blocked. Every successful access records `수령 장소 열람` with the actor, request ID and timestamp in the administrator audit log. Non-admin `/api/data` omits these fields even after approval.
- POST `/api/matches` admin `{lostId,foundId}`; DELETE `/api/matches/:id` admin.
- POST `/api/users/:id/action` admin `{action:'approve'|'reject'|'block'|'unblock'|'role',role?,reason?}`. Approve/reject external registration, block/unblock access, role User/Administrator, protect last active admin.
- POST `/api/notifications/read` marks own notifications read.
- PATCH `/api/settings` admin `{storedDays,lostDays,dataRetentionDays,dropoffLocation,department}`.
- POST `/api/issues` authenticated `{message}`.
- PATCH `/api/profile` authenticated `{name?,currentPassword?,password?}`. Current password mandatory for changing password.
- POST `/api/backup` admin `{}` creates an encrypted database backup in the local data folder.

One lost report may have competing pending claims on different found items, but only one linked claim can be approved. Handover closes the linked lost report and rejects its remaining pending claims. Withdrawing an Open lost report remains allowed and detaches request links; it does not cancel an independently verified ownership approval or revive the withdrawn report on handover.

## Scope and safety
PWA offline shell only: private/API data are never cached. Network unavailable → explicit offline state and no false success. IdentityVerifier interface plus DemoIdentityProvider; no real external verification/mail. Server enforces permissions and lifecycle, not just UI. Signed session cookie, hashed passwords, encrypted stored payloads/documents, input validation, login limiting, audit, rollback on failed mutations. Local .data excluded from source. Seed realistic demo examples.

Persistence uses per-record AES-256-GCM payloads and a SQLite `(collection,id)` primary key. Writes update changed records in one transaction; legacy encrypted single-document databases migrate automatically on startup. Reads run retention maintenance at most once a minute; mutations apply retention immediately. Automatic backups run once a day during use, with bounded retry after failure and administrator error feedback.

For TLS-terminating demo proxies, set `PUBLIC_ORIGIN=https://demo.example` and preserve the public Host header. This explicit origin controls same-origin validation and Secure cookies; forwarded headers are never trusted implicitly. Bind the backend privately and terminate HTTPS at the proxy.
