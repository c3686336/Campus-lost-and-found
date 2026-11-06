import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { resolve, join, extname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes, createHmac, timingSafeEqual } from 'node:crypto';
import { EncryptedStore } from './lib/storage.mjs';
import { CampusService, ApiError, publicUser } from './lib/service.mjs';

const root = fileURLToPath(new URL('.', import.meta.url));
const publicRoot = join(root, 'public');
const types = { '.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.json':'application/json; charset=utf-8','.webmanifest':'application/manifest+json','.svg':'image/svg+xml','.png':'image/png','.ico':'image/x-icon' };
const COOKIE = 'campus_session';
const TTL = 8 * 60 * 60 * 1000;

export function createApp(options = {}) {
  const originSetting = options.publicOrigin || process.env.PUBLIC_ORIGIN;
  const publicOrigin = originSetting ? new URL(originSetting) : null;
  if (publicOrigin && (!['https:','http:'].includes(publicOrigin.protocol) || publicOrigin.username || publicOrigin.password || publicOrigin.search || publicOrigin.hash || publicOrigin.pathname !== '/')) throw new Error('PUBLIC_ORIGIN must be an HTTP(S) origin without a path or credentials.');
  const store = new EncryptedStore(resolve(options.dataDir || process.env.DATA_DIR || join(root,'.data')));
  const service = new CampusService(store,options);
  const sessions = new Map(), attempts = new Map(), secret = randomBytes(32);
  const sign = token => createHmac('sha256',secret).update(token).digest('hex');
  const cookie = req => {
    const part = (req.headers.cookie || '').split(';').map(x=>x.trim()).find(x=>x.startsWith(COOKIE+'='));
    if(!part)return null;
    const [token,signature] = part.slice(COOKIE.length+1).split('.');
    if(!token || !signature)return null;
    const a=Buffer.from(signature),b=Buffer.from(sign(token));
    if(a.length!==b.length||!timingSafeEqual(a,b))return null;
    const session=sessions.get(token);
    if(!session||session.expires<Date.now()){sessions.delete(token);return null;}
    return {token,...session};
  };
  const json = (res,status,data) => { res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'});res.end(JSON.stringify(data)); };
  const body = async req => {
    if(!/^application\/json(?:;|$)/i.test(req.headers['content-type']||''))throw new ApiError(415,'JSON 요청만 지원합니다.');
    let length=0, chunks=[];
    for await(const chunk of req){length+=chunk.length;if(length>3*1024*1024)throw new ApiError(413,'업로드 용량을 초과했습니다.');chunks.push(chunk);}
    try { const value=JSON.parse(Buffer.concat(chunks).toString()||'{}');if(!value||typeof value!=='object'||Array.isArray(value))throw new Error();return value; }catch{throw new ApiError(400,'올바른 JSON 요청이 아닙니다.');}
  };
  const server = createServer(async(req,res)=>{
    res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('Referrer-Policy','same-origin');res.setHeader('X-Frame-Options','DENY');
    res.setHeader('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; worker-src 'self'; manifest-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'; form-action 'self'");
    res.setHeader('Permissions-Policy','camera=(self), microphone=(), geolocation=()');
    try {
      const hostname=new URL(`http://${req.headers.host||''}`).hostname;
      if(publicOrigin ? req.headers.host !== publicOrigin.host : !options.allowRemote&&!process.env.HOST&&!['localhost','127.0.0.1','[::1]'].includes(hostname))throw new ApiError(403,'허용되지 않은 호스트입니다.');
      const url=new URL(req.url,'http://localhost');
      const path=url.pathname;
      if(path.startsWith('/api/')) {
        res.setHeader('Cache-Control','no-store');
        if(!['GET','POST','PATCH','DELETE'].includes(req.method))throw new ApiError(405,'지원하지 않는 메서드입니다.');
        if(req.method!=='GET') {
          const expected = publicOrigin?.origin || `${req.socket.encrypted?'https':'http'}://${req.headers.host}`;
          if((req.headers.origin && req.headers.origin !== expected) || req.headers['sec-fetch-site']==='cross-site')throw new ApiError(403,'다른 사이트에서 보낸 요청은 허용되지 않습니다.');
        }
        let payload;
        if(req.method!=='GET')payload=await body(req);
        // Account and session may change while a client is still uploading its body.
        const session=cookie(req);
        const u=session ? service.state.users.find(u=>u.id===session.userId && u.status==='active') : null;
        if(path==='/api/session'&&req.method==='GET')return json(res,200,{user:publicUser(u),demo:true,settings:service.state.settings});
        if(path==='/api/auth/register'&&req.method==='POST')return json(res,201,service.register(payload));
        if(path==='/api/auth/verify'&&req.method==='POST')return json(res,200,service.verify(payload));
        if(path==='/api/auth/login'&&req.method==='POST') {
          const now=Date.now();
          for (const [key, attempt] of attempts) if(attempt.until<=now) attempts.delete(key);
          const key=req.socket.remoteAddress+':'+String(payload.email||'').trim().toLowerCase().slice(0,254);
          if(!attempts.has(key)&&attempts.size>=10000)throw new ApiError(429,'로그인 요청이 많습니다. 잠시 후 다시 시도해 주세요.');
          let entry=attempts.get(key);
          if(entry&&entry.until<=Date.now()){attempts.delete(key);entry=null;}
          if(entry?.count>=5)throw new ApiError(429,'로그인 시도가 너무 많습니다. 15분 후 다시 시도해 주세요.');
          let user;
          try{user=service.login(payload);}catch(error){attempts.set(key,{count:(entry?.count||0)+1,until:entry?.until||Date.now()+900000});throw error;}
          attempts.delete(key);
          if(session)sessions.delete(session.token);
          // Bound memory for an unattended demo server.
          for(const [id,s]of sessions)if(s.expires<Date.now())sessions.delete(id);
          const token=randomBytes(32).toString('hex');sessions.set(token,{userId:user.id,expires:Date.now()+TTL});
          res.setHeader('Set-Cookie',`${COOKIE}=${token}.${sign(token)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${TTL/1000}${req.socket.encrypted||publicOrigin?.protocol==='https:'?'; Secure':''}`);
          return json(res,200,{user:publicUser(user)});
        }
        if(path==='/api/auth/logout'&&req.method==='POST'){if(session)sessions.delete(session.token);res.setHeader('Set-Cookie',`${COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0`);return json(res,200,{message:'로그아웃되었습니다.'});}
        if(!u)throw new ApiError(401,'로그인이 필요합니다.');
        if(path==='/api/data'&&req.method==='GET')return json(res,200,service.data(u));
        if(path==='/api/items'&&req.method==='POST')return json(res,201,service.createItem(u,payload));
        let match;
        if((match=/^\/api\/items\/([^/]+)$/.exec(path))&&req.method==='PATCH')return json(res,200,service.editItem(u,match[1],payload));
        if((match=/^\/api\/items\/([^/]+)\/action$/.exec(path))&&req.method==='POST')return json(res,200,service.itemAction(u,match[1],payload));
        if(path==='/api/requests'&&req.method==='POST')return json(res,201,service.createRequest(u,payload));
        if((match=/^\/api\/requests\/([^/]+)\/action$/.exec(path))&&req.method==='POST')return json(res,200,service.requestAction(u,match[1],payload));
        if((match=/^\/api\/requests\/([^/]+)\/pickup$/.exec(path))&&req.method==='POST')return json(res,200,service.pickup(u,match[1]));
        if(path==='/api/matches'&&req.method==='POST')return json(res,201,service.match(u,payload));
        if((match=/^\/api\/matches\/([^/]+)$/.exec(path))&&req.method==='DELETE')return json(res,200,service.match(u,payload,match[1]));
        if((match=/^\/api\/users\/([^/]+)\/action$/.exec(path))&&req.method==='POST'){const result=service.userAction(u,match[1],payload);if(payload.action==='block')for(const [key,value]of sessions)if(value.userId===match[1])sessions.delete(key);return json(res,200,result);}
        if(path==='/api/settings'&&req.method==='PATCH')return json(res,200,service.settings(u,payload));
        if(path==='/api/profile'&&req.method==='PATCH'){const result=service.profile(u,payload);if(payload.password!==undefined)for(const [key,value]of sessions)if(value.userId===u.id&&key!==session?.token)sessions.delete(key);return json(res,200,result);}
        if(path==='/api/notifications/read'&&req.method==='POST')return json(res,200,service.readNotifications(u));
        if(path==='/api/issues'&&req.method==='POST')return json(res,201,service.issue(u,payload));
        if(path==='/api/backup'&&req.method==='POST'){service.admin(u);const file=service.backup(true);return json(res,200,{message:'암호화 백업을 생성했습니다.',file});}
        throw new ApiError(404,'API를 찾을 수 없습니다.');
      }
      if(!['GET','HEAD'].includes(req.method))throw new ApiError(405,'지원하지 않는 메서드입니다.');
      let relative;
      try{relative=decodeURIComponent(path);}catch{throw new ApiError(400,'올바르지 않은 경로입니다.');}
      if(relative.includes('\0')||relative.split(/[\\/]/).some(p=>p.startsWith('.')))throw new ApiError(404,'파일을 찾을 수 없습니다.');
      const target=resolve(publicRoot,relative.replace(/^[/\\]+/,'')||'index.html');
      if(!target.startsWith(publicRoot+sep))throw new ApiError(404,'파일을 찾을 수 없습니다.');
      let bytes;
      try{if(!(await stat(target)).isFile())throw new Error();bytes=await readFile(target);}catch{throw new ApiError(404,'파일을 찾을 수 없습니다.');}
      const ext=extname(target);res.setHeader('Content-Type',types[ext]||'application/octet-stream');
      // Files keep stable names in this buildless demo. Always revalidate online
      // so a service worker cannot hide an updated UI behind the HTTP cache.
      res.setHeader('Cache-Control','no-cache');
      res.writeHead(200);res.end(req.method==='HEAD'?undefined:bytes);
    }catch(error){if(res.headersSent){res.end();return;}if(!(error instanceof ApiError))console.error('Request failed:',error.stack);json(res,error.status||500,{error:error instanceof ApiError?error.message:'요청 처리 중 오류가 발생했습니다.',...(error.code?{code:error.code}:{})});}
  });
  server.requestTimeout=15000;server.headersTimeout=10000;
  let closed=false;
  const close=async()=>{if(closed)return;closed=true;if(server.listening)await new Promise(resolve=>server.close(resolve));store.close();};
  return {server,store,service,close};
}

if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const app=createApp();const port=Number(process.env.PORT||3000);const host=process.env.HOST||'127.0.0.1';
  app.server.listen(port,host,()=>console.log(`Campus Found: http://${host}:${app.server.address().port}`));
  for(const signal of ['SIGINT','SIGTERM'])process.on(signal,async()=>{await app.close();process.exit(0);});
}
