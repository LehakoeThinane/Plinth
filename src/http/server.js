import { createServer } from 'node:http';
import { renderStorefront } from './storefront.js';
import { readFile } from 'node:fs/promises';
import { renderApplicationShell } from './application-shell.js';
import { clearLoginCookie } from '../modules/identity/hosted-sign-in.js';
import { maxLogoBytes } from '../modules/tenancy/logo-images.js';
async function readBinary(req) {
  const chunks=[];let size=0;
  for await(const chunk of req){size+=chunk.length;if(size>maxLogoBytes)throw Object.assign(new Error('Body too large'),{status:413});chunks.push(chunk);}
  return Buffer.concat(chunks);
}
const htmlHeaders={'content-type':'text/html; charset=utf-8','cache-control':'no-store',
  'content-security-policy':"default-src 'none'; style-src 'unsafe-inline'; script-src 'self'; img-src 'self'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
  'x-content-type-options':'nosniff','referrer-policy':'strict-origin-when-cross-origin'};
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
async function readObject(req,maxBytes=4096) {
  req.setEncoding('utf8');
  let body='';
  for await(const chunk of req) {
    body+=chunk;
    if(Buffer.byteLength(body)>maxBytes)throw Object.assign(new Error('Body too large'),{status:413});
  }
  let result;
  try{result=JSON.parse(body);}catch{throw Object.assign(new Error('Invalid JSON'),{status:400});}
  if(!result || typeof result!=='object' || Array.isArray(result))throw Object.assign(new Error('Invalid body'),{status:400});
  return result;
}
/** authenticate verifies a bearer credential and returns a server-resolved userId.
 * No default authenticator, development header override or public token issuer.
 * This endpoint returns an ACCESS DECISION only, never media/content.
 */
export function createApi({authenticate,accessForPrincipal,consentForPrincipal,noticeForPrincipal,hubForPrincipal,identityForPrincipal,organisationForPrincipal,logoForPrincipal,brandingStore,publicHubs,browserSessions,hostedSignIn,onError=()=>{}}) {
  if(typeof authenticate!=='function'||typeof accessForPrincipal!=='function')throw Error('Verified authentication adapter required');
  return createServer(async(req,res)=>{
    const send=(status,body)=>{res.writeHead(status,{'content-type':'application/json','cache-control':'no-store'});res.end(JSON.stringify(body));};
    try{
      const requestUrl=new URL(req.url,'http://localhost');
      const path=requestUrl.pathname;
      const asset=path.match(/^\/assets\/hubs\/([0-9a-f-]{36})\/branding\/([0-9a-f-]{36})\.webp$/);
      if(brandingStore && publicHubs && req.method==='GET' && asset && uuid.test(asset[1]) && uuid.test(asset[2])) {
        if(!await publicHubs.isPublishedLogo(asset[1],asset[2]+'.webp'))return send(404,{error:'not_found'});
        const bytes=await brandingStore.read(asset[1],asset[2]);
        if(!bytes)return send(404,{error:'not_found'});
        res.writeHead(200,{'content-type':'image/webp','cache-control':'no-store','x-content-type-options':'nosniff','cross-origin-resource-policy':'same-origin'});
        return res.end(bytes);
      }
      const signIn=path.match(/^\/h\/([a-z0-9-]+)\/sign-in$/);
      if(hostedSignIn && req.method==='GET' && (signIn||path==='/auth/callback')) {
        let result;
        try {
          result=signIn?await hostedSignIn.begin(req,await publicHubs.resolve({slug:signIn[1]}),requestUrl.searchParams.get('view')??'member'):
            await hostedSignIn.complete(req,requestUrl);
        }catch(error){if(!signIn)res.setHeader('set-cookie',clearLoginCookie);throw error;}
        res.writeHead(303,{'location':result.location,'set-cookie':result.cookies,'cache-control':'no-store','referrer-policy':'no-referrer'});
        return res.end();
      }
      if(req.method==='GET' && path==='/assets/plinth-shell.js') {
        const script=await readFile(new URL('./plinth-shell.js',import.meta.url),'utf8');
        res.writeHead(200,{'content-type':'text/javascript; charset=utf-8','x-content-type-options':'nosniff','cache-control':'no-cache'});
        return res.end(script);
      }
      const shell=path.match(/^\/h\/([a-z0-9-]+)\/(member|admin|join|create-hub|organisations)$/);
      if(browserSessions && publicHubs && hubForPrincipal && consentForPrincipal && req.method==='GET' && shell) {
        const hub=await publicHubs.resolve({slug:shell[1]});
        const principal=await browserSessions.principal(req);
        if(!principal) {
          if(hostedSignIn){res.writeHead(303,{'location':'/h/'+hub.slug+'/sign-in?view='+shell[2],'cache-control':'no-store'});return res.end();}
          return send(401,{error:'unauthenticated'});
        }
        if(principal.hubId!==hub.id)return send(404,{error:'not_found'});
        let membership;
        try{membership=await hubForPrincipal(principal).membership(hub.id);}
        catch(error){if(error.status!==404||!['join','create-hub','organisations'].includes(shell[2]))throw error;}
        if(shell[2]==='admin' && !['owner','admin'].includes(membership?.role))return send(404,{error:'not_found'});
        const account=shell[2]==='organisations'?await identityForPrincipal(principal).account(hub.id):undefined;
        const orgId=requestUrl.searchParams.get('org');
        const organisation=account && orgId?await organisationForPrincipal(principal).admin(hub.id,orgId):undefined;
        const publications=shell[2]==='admin'&&noticeForPrincipal?await noticeForPrincipal(principal).history(hub.id):[];
        const html=renderApplicationShell({hub,view:shell[2],membership,account,organisation,publications,brandingEnabled:Boolean(brandingStore),consents:await consentForPrincipal(principal).list(hub.id),csrfToken:principal.csrfToken});
        res.writeHead(200,htmlHeaders);return res.end(html);
      }
      const storefront=path.match(/^\/h\/([a-z0-9-]+)$/);
      if(publicHubs && req.method==='GET' && storefront) {
        const html=renderStorefront(await publicHubs.resolve({slug:storefront[1]}),{signIn:Boolean(hostedSignIn)});
        res.writeHead(200,htmlHeaders);
        return res.end(html);
      }
      if(publicHubs && req.method==='GET' && path==='/v1/hubs/resolve') {
        return send(200,await publicHubs.resolve({slug:requestUrl.searchParams.get('slug'),hostname:requestUrl.searchParams.get('hostname')}));
      }
      const match=path.match(/^\/v1\/hubs\/([^/]+)\/lessons\/([^/]+)\/access$/);
      const consent=path.match(/^\/v1\/hubs\/([^/]+)\/consents$/);
      const consentRoute=consentForPrincipal && consent && uuid.test(consent[1]) && ['GET','PUT'].includes(req.method);
      const notice=path.match(/^\/v1\/hubs\/([^/]+)\/notices$/);
      const noticeRoute=noticeForPrincipal&&notice&&uuid.test(notice[1])&&['GET','PUT'].includes(req.method);
      const org=path.match(/^\/v1\/hubs\/([^/]+)\/organisations(?:\/([^/]+)(?:\/(invitations|accept|members)(?:\/([^/]+))?)?)?$/);
      const accountRoute=identityForPrincipal && path.match(/^\/v1\/hubs\/([^/]+)\/account$/);
      const orgRoute=organisationForPrincipal && org && uuid.test(org[1]) && (!org[2]||uuid.test(org[2])) &&
        (org[4]===undefined||uuid.test(org[4])) &&
        (org[2]?org[3]?org[3]==='accept'?req.method==='POST'&&!org[4]:
          org[3]==='invitations'?(org[4]?req.method==='DELETE':req.method==='POST'):
          org[4]&&['PUT','DELETE'].includes(req.method):['GET','PUT'].includes(req.method):req.method==='POST');
      const readAccount=accountRoute && uuid.test(accountRoute[1]) && req.method==='GET';
      const hubAction=path.match(/^\/v1\/hubs\/([^/]+)\/(join|membership|branding)$/);
      const logo=path.match(/^\/v1\/hubs\/([0-9a-f-]{36})\/branding\/logo$/);
      const logoRoute=logoForPrincipal && logo && uuid.test(logo[1]) && ['PUT','DELETE'].includes(req.method);
      const sessionAction=path.match(/^\/v1\/hubs\/([^/]+)\/session$/);
      const sessionRoute=browserSessions && sessionAction && uuid.test(sessionAction[1]) && ['POST','DELETE'].includes(req.method);
      const createHub=hubForPrincipal && path==='/v1/hubs' && req.method==='POST';
      const hubRoute=hubForPrincipal && hubAction && uuid.test(hubAction[1]) &&
        req.method===({join:'POST',membership:'GET',branding:'PUT'})[hubAction[2]];
      if(!logoRoute && !noticeRoute && !readAccount && !orgRoute && !sessionRoute && !createHub && !hubRoute && !consentRoute && (req.method!=='GET'||!match||!uuid.test(match[1])||!uuid.test(match[2])))return send(404,{error:'not_found'});
      const bearer=req.headers.authorization?.match(/^Bearer ([^\s]+)$/)?.[1];
      if(req.headers.authorization && !bearer)return send(401,{error:'unauthenticated'});
      const principal=bearer?await authenticate(bearer):await browserSessions?.principal(req);
      if(!principal||!uuid.test(principal.userId??''))return send(401,{error:'unauthenticated'});
      const targetHub=logoRoute?logo[1]:noticeRoute?notice[1]:readAccount?accountRoute[1]:orgRoute?org[1]:sessionRoute?sessionAction[1]:hubRoute?hubAction[1]:consentRoute?consent[1]:match?.[1];
      if(principal.sessionHash && targetHub && principal.hubId!==targetHub)return send(404,{error:'not_found'});
      if(principal.sessionHash && !['GET','HEAD'].includes(req.method))browserSessions.checkMutation(req,principal);
      if(logoRoute) {
        const logos=logoForPrincipal(principal);
        await logos.authorise(targetHub);
        return send(200,req.method==='DELETE'?await logos.remove(targetHub):await logos.upload(targetHub,await readBinary(req),req.headers['content-type']));
      }
      if(noticeRoute) {
        const repository=noticeForPrincipal(principal);
        return send(200,req.method==='GET'?{publications:await repository.history(targetHub)}:await repository.publish(targetHub,await readObject(req,65536)));
      }
      if(readAccount)return send(200,await identityForPrincipal(principal).account(targetHub));
      if(orgRoute) {
        const repository=organisationForPrincipal(principal),hubId=org[1],orgId=org[2];
        if(!orgId)return send(201,await repository.create(hubId,await readObject(req)));
        if(!org[3])return send(200,req.method==='GET'?await repository.admin(hubId,orgId):await repository.rename(hubId,orgId,await readObject(req)));
        if(org[3]==='accept')return send(200,await repository.accept(hubId,orgId,await readObject(req)));
        if(org[3]==='invitations')return send(org[4]?200:201,org[4]?await repository.revoke(hubId,orgId,org[4]):await repository.invite(hubId,orgId,await readObject(req)));
        const input=req.method==='PUT'?await readObject(req):null;
        if(input && !['admin','member'].includes(input.role))return send(400,{error:'invalid_request'});
        return send(200,await repository.member(hubId,orgId,org[4],input?.role??null));
      }
      if(sessionRoute) {
        if(req.method==='POST') {
          if(!bearer)return send(401,{error:'unauthenticated'});
          const session=await browserSessions.establish(req,sessionAction[1],principal);
          res.setHeader('set-cookie',session.cookie);
          return send(201,{csrfToken:session.csrfToken,expiresAt:session.expiresAt});
        }
        if(!principal.sessionHash)return send(401,{error:'unauthenticated'});
        res.setHeader('set-cookie',await browserSessions.end(req,principal));
        return send(200,{signedOut:true});
      }
      if(createHub)return send(201,await hubForPrincipal(principal).create(await readObject(req)));
      if(hubRoute) {
        const hubs=hubForPrincipal(principal),hubId=hubAction[1];
        if(hubAction[2]==='join')return send(200,await hubs.join(hubId));
        if(hubAction[2]==='membership')return send(200,await hubs.membership(hubId));
        return send(200,await hubs.brand(hubId,await readObject(req)));
      }
      if(consentRoute) {
        const repository=consentForPrincipal(principal);
        if(req.method==='GET')return send(200,{consents:await repository.list(consent[1])});
        const decision=await readObject(req);
        try { return send(200,await repository.set(consent[1],decision)); }
        catch(error) {
          if([400,404,409].includes(error.status))return send(error.status,{error:({400:'invalid_consent',404:'not_found',409:'notice_changed'})[error.status]});
          throw error;
        }
      }
      const access=accessForPrincipal(principal);
      const result=await access.check({hubId:match[1],targetId:match[2],userId:principal.userId});
      if(result.decision==='not_found')return send(404,{error:'not_found'});
      return send(200,result);
    }catch(error){
      if([400,401,403,404,409,413,415].includes(error.status))return send(error.status,{error:({400:'invalid_request',401:'unauthenticated',403:'forbidden',404:'not_found',409:'conflict',413:'body_too_large',415:'unsupported_image'})[error.status]});
      onError(error);return send(500,{error:'internal_error'});
    }
  });
}
