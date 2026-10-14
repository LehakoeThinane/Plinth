import { createServer } from 'node:http';
import { renderStorefront,renderProductPage,renderLessonPage } from './storefront.js';
import { readFile } from 'node:fs/promises';
import { renderApplicationShell } from './application-shell.js';
import { clearLoginCookie,isRecentSignIn } from '../modules/identity/hosted-sign-in.js';
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
export function createApi({authenticate,accessForPrincipal,consentForPrincipal,noticeForPrincipal,hubForPrincipal,identityForPrincipal,organisationForPrincipal,logoForPrincipal,brandingStore,domainForPrincipal,orgDomainsForPrincipal,catalogueForPrincipal,publicCatalogue,learningForPrincipal,publicHubs,browserSessions,hostedSignIn,accountLinks,onError=()=>{}}) {
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
      const adminProducts=path.match(/^\/h\/([a-z0-9-]+)\/admin\/products(?:\/([0-9a-f-]{36}))?$/);
      if(browserSessions && publicHubs && hubForPrincipal && catalogueForPrincipal && req.method==='GET' && adminProducts && (!adminProducts[2]||uuid.test(adminProducts[2]))) {
        const hub=await publicHubs.resolve({slug:adminProducts[1]});
        const principal=await browserSessions.principal(req);
        if(!principal) {
          if(hostedSignIn){res.writeHead(303,{'location':'/h/'+hub.slug+'/sign-in?view=admin','cache-control':'no-store'});return res.end();}
          return send(401,{error:'unauthenticated'});
        }
        if(principal.hubId!==hub.id)return send(404,{error:'not_found'});
        const membership=await hubForPrincipal(principal).membership(hub.id).catch(error=>{if(error.status===404)return null;throw error;});
        if(!['owner','admin'].includes(membership?.role))return send(404,{error:'not_found'});
        const products=catalogueForPrincipal(principal);
        const catalogue=adminProducts[2]?{detail:await products.get(hub.id,adminProducts[2])}:{products:await products.list(hub.id)};
        const html=renderApplicationShell({hub,view:adminProducts[2]?'product':'products',membership,catalogue,consents:[],csrfToken:principal.csrfToken});
        res.writeHead(200,htmlHeaders);return res.end(html);
      }
      const shell=path.match(/^\/h\/([a-z0-9-]+)\/(member|admin|join|create-hub|organisations|account|learning)$/);
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
        catch(error){if(error.status!==404||!['join','create-hub','organisations','account','learning'].includes(shell[2]))throw error;}
        if(shell[2]==='admin' && !['owner','admin'].includes(membership?.role))return send(404,{error:'not_found'});
        const account=['organisations','account'].includes(shell[2])?await identityForPrincipal(principal).account(hub.id):undefined;
        const signIn=shell[2]==='account'?{...await identityForPrincipal(principal).signInMethods(hub.id),
          linkingEnabled:Boolean(accountLinks),recent:isRecentSignIn(principal),outcome:requestUrl.searchParams.get('link')}:undefined;
        const orgId=requestUrl.searchParams.get('org');
        const organisation=account && orgId?await organisationForPrincipal(principal).admin(hub.id,orgId):undefined;
        const learningView=shell[2]==='learning'&&learningForPrincipal?await learningForPrincipal(principal).learning(hub.id):undefined;
        const orgDomains=organisation&&orgDomainsForPrincipal?await orgDomainsForPrincipal(principal).list(hub.id,orgId):undefined;
        const history=shell[2]==='admin'&&noticeForPrincipal?await noticeForPrincipal(principal).history(hub.id,{before:requestUrl.searchParams.get('notices_before')}):{publications:[],next:null};
        const domains=shell[2]==='admin'&&domainForPrincipal?await domainForPrincipal(principal).list(hub.id):undefined;
        const html=renderApplicationShell({hub,view:shell[2],membership,account,signIn,organisation,orgDomains,learning:learningView,publications:history.publications,olderNotices:history.next,domains,brandingEnabled:Boolean(brandingStore),consents:await consentForPrincipal(principal).list(hub.id),csrfToken:principal.csrfToken});
        res.writeHead(200,htmlHeaders);return res.end(html);
      }
      const storefront=path.match(/^\/h\/([a-z0-9-]+)$/);
      if(publicHubs && req.method==='GET' && storefront) {
        const hub=await publicHubs.resolve({slug:storefront[1]});
        const html=renderStorefront(hub,{signIn:Boolean(hostedSignIn),products:publicCatalogue?await publicCatalogue.shelf(hub.id):null});
        res.writeHead(200,htmlHeaders);
        return res.end(html);
      }
      const productPage=path.match(/^\/h\/([a-z0-9-]+)\/products\/([0-9a-f-]{36})$/);
      if(publicHubs && publicCatalogue && req.method==='GET' && productPage && uuid.test(productPage[2])) {
        const hub=await publicHubs.resolve({slug:productPage[1]});
        const html=renderProductPage(hub,await publicCatalogue.page(hub.id,productPage[2]),{signIn:Boolean(hostedSignIn)});
        res.writeHead(200,htmlHeaders);
        return res.end(html);
      }
      if(publicHubs && req.method==='GET' && path==='/v1/hubs/resolve') {
        return send(200,await publicHubs.resolve({slug:requestUrl.searchParams.get('slug'),hostname:requestUrl.searchParams.get('hostname')}));
      }
      // Lessons accept an optional identity: free (open) lessons work signed out.
      // A malformed or invalid bearer is still rejected, never treated as anonymous.
      const lessonApi=path.match(/^\/v1\/hubs\/([0-9a-f-]{36})\/lessons\/([0-9a-f-]{36})$/);
      const lessonPage=path.match(/^\/h\/([a-z0-9-]+)\/lessons\/([0-9a-f-]{36})$/);
      if(req.method==='GET' && ((lessonApi && uuid.test(lessonApi[1]) && uuid.test(lessonApi[2])) || (lessonPage && publicHubs && uuid.test(lessonPage[2])))) {
        const hub=lessonApi?null:await publicHubs.resolve({slug:lessonPage[1]});
        const hubId=lessonApi?lessonApi[1]:hub.id,lessonId=(lessonApi??lessonPage)[2];
        let principal=null;
        if(req.headers.authorization) {
          const token=lessonApi&&req.headers.authorization.match(/^Bearer ([^\s]+)$/)?.[1];
          principal=token?await authenticate(token):null;
          if(!principal||!uuid.test(principal.userId??''))return send(401,{error:'unauthenticated'});
        } else principal=await browserSessions?.principal(req)??null;
        if(principal?.sessionHash && principal.hubId!==hubId)return send(404,{error:'not_found'});
        const result=await accessForPrincipal(principal??{userId:null}).open({hubId,userId:principal?.userId??null,lessonId});
        if(result.decision==='not_found')return send(404,{error:'not_found'});
        if(lessonApi)return send(200,result);
        // Signed-in learners get the CSRF token needed to save progress from the page.
        const session=principal?.sessionHash?{hubId,csrfToken:principal.csrfToken}:null;
        res.writeHead(200,htmlHeaders);return res.end(renderLessonPage(hub,result,{signIn:Boolean(hostedSignIn),session}));
      }
      // The shelf is public: company products are hidden by the database boundary.
      const shelf=path.match(/^\/v1\/hubs\/([0-9a-f-]{36})\/products(?:\/([0-9a-f-]{36}))?$/);
      if(publicCatalogue && req.method==='GET' && shelf && uuid.test(shelf[1]) && (!shelf[2]||uuid.test(shelf[2]))) {
        return send(200,shelf[2]?await publicCatalogue.page(shelf[1],shelf[2]):{products:await publicCatalogue.shelf(shelf[1])});
      }
      const match=path.match(/^\/v1\/hubs\/([^/]+)\/lessons\/([^/]+)\/access$/);
      const consent=path.match(/^\/v1\/hubs\/([^/]+)\/consents$/);
      const consentRoute=consentForPrincipal && consent && uuid.test(consent[1]) && ['GET','PUT'].includes(req.method);
      const notice=path.match(/^\/v1\/hubs\/([^/]+)\/notices(?:\/(retire))?$/);
      const noticeRoute=noticeForPrincipal&&notice&&uuid.test(notice[1])&&(notice[2]?req.method==='POST':['GET','PUT'].includes(req.method));
      const org=path.match(/^\/v1\/hubs\/([^/]+)\/organisations(?:\/([^/]+)(?:\/(invitations|accept|members)(?:\/([^/]+))?)?)?$/);
      const accountRoute=identityForPrincipal && path.match(/^\/v1\/hubs\/([^/]+)\/account$/);
      const orgRoute=organisationForPrincipal && org && uuid.test(org[1]) && (!org[2]||uuid.test(org[2])) &&
        (org[4]===undefined||uuid.test(org[4])) &&
        (org[2]?org[3]?org[3]==='accept'?req.method==='POST'&&!org[4]:
          org[3]==='invitations'?(org[4]?req.method==='DELETE':req.method==='POST'):
          org[4]&&['PUT','DELETE'].includes(req.method):['GET','PUT'].includes(req.method):req.method==='POST');
      const readAccount=accountRoute && uuid.test(accountRoute[1]) && req.method==='GET';
      const progress=path.match(/^\/v1\/hubs\/([0-9a-f-]{36})\/lessons\/([0-9a-f-]{36})\/progress$/);
      const progressRoute=progress && uuid.test(progress[1]) && uuid.test(progress[2]) && req.method==='PUT';
      const learning=path.match(/^\/v1\/hubs\/([0-9a-f-]{36})\/learning$/);
      const learningRoute=learningForPrincipal && learning && uuid.test(learning[1]) && req.method==='GET';
      const catalogue=path.match(/^\/v1\/hubs\/([0-9a-f-]{36})\/catalogue\/products(?:\/([0-9a-f-]{36})(?:\/(modules|lessons|plans|publish)(?:\/([0-9a-f-]{36})(?:\/(content))?)?)?)?$/);
      const catalogueRoute=catalogueForPrincipal && catalogue && [1,2,4].every(i=>catalogue[i]===undefined||uuid.test(catalogue[i])) &&
        (!catalogue[2]?['GET','POST'].includes(req.method):!catalogue[3]?['GET','PATCH'].includes(req.method):
          catalogue[5]?catalogue[3]==='lessons'&&req.method==='PUT':
          catalogue[4]?catalogue[3]==='plans'&&req.method==='DELETE':req.method==='POST');
      const orgDomain=path.match(/^\/v1\/hubs\/([0-9a-f-]{36})\/organisations\/([0-9a-f-]{36})\/domains(?:\/(verify))?$/);
      const orgDomainRoute=orgDomainsForPrincipal && orgDomain && uuid.test(orgDomain[1]) && uuid.test(orgDomain[2]) &&
        (orgDomain[3]?req.method==='POST':['GET','POST','DELETE'].includes(req.method));
      const links=path.match(/^\/v1\/hubs\/([0-9a-f-]{36})\/account\/links$/);
      const linkRoute=links && uuid.test(links[1]) && (req.method==='GET'?Boolean(identityForPrincipal):
        Boolean(accountLinks) && ['POST','DELETE'].includes(req.method));
      const domain=path.match(/^\/v1\/hubs\/([0-9a-f-]{36})\/domains(?:\/(verify))?$/);
      const domainRoute=domainForPrincipal&&domain&&uuid.test(domain[1])&&(domain[2]?req.method==='POST':['GET','POST','DELETE'].includes(req.method));
      const hubAction=path.match(/^\/v1\/hubs\/([^/]+)\/(join|membership|branding)$/);
      const logo=path.match(/^\/v1\/hubs\/([0-9a-f-]{36})\/branding\/logo$/);
      const logoRoute=logoForPrincipal && logo && uuid.test(logo[1]) && ['PUT','DELETE'].includes(req.method);
      const sessionAction=path.match(/^\/v1\/hubs\/([^/]+)\/session$/);
      const sessionRoute=browserSessions && sessionAction && uuid.test(sessionAction[1]) && ['POST','DELETE'].includes(req.method);
      const createHub=hubForPrincipal && path==='/v1/hubs' && req.method==='POST';
      const hubRoute=hubForPrincipal && hubAction && uuid.test(hubAction[1]) &&
        req.method===({join:'POST',membership:'GET',branding:'PUT'})[hubAction[2]];
      if(!progressRoute && !learningRoute && !catalogueRoute && !domainRoute &&!orgDomainRoute &&!logoRoute && !noticeRoute && !readAccount && !linkRoute && !orgRoute &&!sessionRoute && !createHub && !hubRoute && !consentRoute && (req.method!=='GET'||!match||!uuid.test(match[1])||!uuid.test(match[2])))return send(404,{error:'not_found'});
      const bearer=req.headers.authorization?.match(/^Bearer ([^\s]+)$/)?.[1];
      if(req.headers.authorization && !bearer)return send(401,{error:'unauthenticated'});
      const principal=bearer?await authenticate(bearer):await browserSessions?.principal(req);
      if(!principal||!uuid.test(principal.userId??''))return send(401,{error:'unauthenticated'});
      const targetHub=progressRoute?progress[1]:learningRoute?learning[1]:catalogueRoute?catalogue[1]:domainRoute?domain[1]:orgDomainRoute?orgDomain[1]:logoRoute?logo[1]:noticeRoute?notice[1]:readAccount?accountRoute[1]:linkRoute?links[1]:orgRoute?org[1]:sessionRoute?sessionAction[1]:hubRoute?hubAction[1]:consentRoute?consent[1]:match?.[1];
      if(principal.sessionHash && targetHub && principal.hubId!==targetHub)return send(404,{error:'not_found'});
      if(principal.sessionHash && !['GET','HEAD'].includes(req.method))browserSessions.checkMutation(req,principal);
      if(domainRoute) {
        const domains=domainForPrincipal(principal);
        if(req.method==='GET')return send(200,await domains.list(targetHub));
        const input=await readObject(req);
        return send(200,await (domain[2]?domains.verify(targetHub,input):req.method==='DELETE'?domains.remove(targetHub,input):domains.request(targetHub,input)));
      }
      if(progressRoute)return send(200,await accessForPrincipal(principal).recordProgress({hubId:progress[1],userId:principal.userId,
        lessonId:progress[2],update:await readObject(req),idempotencyKey:req.headers['idempotency-key']}));
      if(learningRoute)return send(200,await learningForPrincipal(principal).learning(learning[1]));
      if(catalogueRoute) {
        const products=catalogueForPrincipal(principal),[,hubId,productId,part,planId,content]=catalogue;
        if(!productId)return req.method==='GET'?send(200,{products:await products.list(hubId)}):send(201,await products.create(hubId,await readObject(req)));
        if(!part)return send(200,req.method==='GET'?await products.get(hubId,productId):await products.update(hubId,productId,await readObject(req)));
        if(part==='publish')return send(200,await products.publish(hubId,productId));
        if(content)return send(200,await products.setLessonContent(hubId,productId,planId,await readObject(req,262144)));
        if(planId)return send(200,await products.retirePlan(hubId,productId,planId));
        const input=await readObject(req);
        return send(201,await (part==='modules'?products.addModule(hubId,productId,input):part==='lessons'?products.addLesson(hubId,productId,input):products.addPlan(hubId,productId,input)));
      }
      if(orgDomainRoute) {
        const domains=orgDomainsForPrincipal(principal),[,hubId,orgId,verify]=orgDomain;
        if(req.method==='GET')return send(200,await domains.list(hubId,orgId));
        const input=await readObject(req);
        return send(200,await (verify?domains.verify(hubId,orgId,input):req.method==='DELETE'?domains.remove(hubId,orgId,input):domains.request(hubId,orgId,input)));
      }
      if(logoRoute) {
        const logos=logoForPrincipal(principal);
        await logos.authorise(targetHub);
        return send(200,req.method==='DELETE'?await logos.remove(targetHub):await logos.upload(targetHub,await readBinary(req),req.headers['content-type']));
      }
      if(noticeRoute) {
        const repository=noticeForPrincipal(principal);
        if(notice[2])return send(200,await repository.retire(targetHub,await readObject(req)));
        if(req.method==='GET')return send(200,await repository.history(targetHub,
          {before:requestUrl.searchParams.get('before'),limit:requestUrl.searchParams.get('limit')??50}));
        return send(200,await repository.publish(targetHub,await readObject(req,65536)));
      }
      if(readAccount)return send(200,await identityForPrincipal(principal).account(targetHub));
      if(linkRoute) {
        if(req.method==='GET')return send(200,await identityForPrincipal(principal).signInMethods(targetHub));
        // Changes are tied to a recent browser session, never a bearer token alone.
        if(!principal.sessionHash)return send(403,{error:'browser_session_required'});
        const input=await readObject(req);
        try {
          if(req.method==='DELETE')return send(200,await accountLinks.unlink(principal,input));
          const hub=await publicHubs.resolve({slug:input.slug});
          if(hub.id!==targetHub)return send(404,{error:'not_found'});
          const started=await accountLinks.begin(req,hub,principal);
          res.setHeader('set-cookie',started.cookies);
          return send(200,{location:started.location});
        }catch(error){if(error.reauthenticate)return send(403,{error:'reauthentication_required'});throw error;}
      }
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
