import { createServer } from 'node:http';
import { renderStorefront,renderProductPage,renderLessonPage,renderLibrary,renderLibraryItem,renderMembership } from './storefront.js';
import { matchCommunityApi,matchMessagingApi,matchTierApi,matchCommerceApi } from './community-routes.js';
import { handlePaymentWebhook } from '../modules/commerce/checkout-service.js';
import { renderTestPayment,renderTestSubscription } from './commerce-shell.js';
async function readRaw(req,maxBytes) {
  const chunks=[];let size=0;
  for await(const chunk of req){size+=chunk.length;if(size>maxBytes)throw Object.assign(new Error('Body too large'),{status:413});chunks.push(chunk);}
  return Buffer.concat(chunks).toString('utf8');
}
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
  'content-security-policy':"default-src 'none'; style-src 'self' 'unsafe-inline'; font-src 'self'; script-src 'self'; img-src 'self'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
  'x-content-type-options':'nosniff','referrer-policy':'strict-origin-when-cross-origin'};
// Self-hosted, OFL-licensed fonts: a fixed list, so no request picks a path.
const fontFile=(pkg,file)=>new URL(import.meta.resolve(pkg+'/files/'+file));
const fontFiles={
  'body-400.woff2':fontFile('@fontsource/atkinson-hyperlegible-next','atkinson-hyperlegible-next-latin-400-normal.woff2'),
  'body-400-italic.woff2':fontFile('@fontsource/atkinson-hyperlegible-next','atkinson-hyperlegible-next-latin-400-italic.woff2'),
  'body-600.woff2':fontFile('@fontsource/atkinson-hyperlegible-next','atkinson-hyperlegible-next-latin-600-normal.woff2'),
  'body-700.woff2':fontFile('@fontsource/atkinson-hyperlegible-next','atkinson-hyperlegible-next-latin-700-normal.woff2'),
  'newsreader.woff2':fontFile('@fontsource-variable/newsreader','newsreader-latin-wght-normal.woff2'),
  'newsreader-italic.woff2':fontFile('@fontsource-variable/newsreader','newsreader-latin-wght-italic.woff2'),
  'archivo.woff2':fontFile('@fontsource-variable/archivo','archivo-latin-wght-normal.woff2')
};
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
export function createApi({authenticate,accessForPrincipal,consentForPrincipal,noticeForPrincipal,hubForPrincipal,identityForPrincipal,organisationForPrincipal,logoForPrincipal,brandingStore,domainForPrincipal,orgDomainsForPrincipal,catalogueForPrincipal,publicCatalogue,learningForPrincipal,libraryForPrincipal,communityForPrincipal,moderationForPrincipal,messagingForPrincipal,tierForPrincipal,publicTiers,checkoutForPrincipal,ordersForPrincipal,paymentProvider,payments,publicHubs,browserSessions,hostedSignIn,accountLinks,onError=()=>{}}) {
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
      if(req.method==='GET' && path==='/assets/plinth.css') {
        const styles=await readFile(new URL('./plinth.css',import.meta.url),'utf8');
        res.writeHead(200,{'content-type':'text/css; charset=utf-8','x-content-type-options':'nosniff','cache-control':'no-cache'});
        return res.end(styles);
      }
      const font=req.method==='GET'&&path.startsWith('/assets/fonts/')?fontFiles[path.slice(14)]:null;
      if(font) {
        res.writeHead(200,{'content-type':'font/woff2','x-content-type-options':'nosniff','cache-control':'public, max-age=604800'});
        return res.end(await readFile(font));
      }
      const commercePage=path.match(/^\/h\/([a-z0-9-]+)\/(?:(checkout)\/([0-9a-f-]{36})\/([0-9a-f-]{36})|(orders)(?:\/([0-9a-f-]{36}))?|admin\/(sales)|(subscribe)\/([0-9a-f-]{36})|(subscriptions))$/);
      if(browserSessions && publicHubs && hubForPrincipal && ordersForPrincipal && publicCatalogue && req.method==='GET' && commercePage &&
        [3,4,6,9].every(i=>!commercePage[i]||uuid.test(commercePage[i]))) {
        const hub=await publicHubs.resolve({slug:commercePage[1]});
        const principal=await browserSessions.principal(req);
        if(!principal) {
          if(hostedSignIn){res.writeHead(303,{'location':'/h/'+hub.slug+'/sign-in?view='+(commercePage[7]?'admin':'member'),'cache-control':'no-store'});return res.end();}
          return send(401,{error:'unauthenticated'});
        }
        if(principal.hubId!==hub.id)return send(404,{error:'not_found'});
        const membership=await hubForPrincipal(principal).membership(hub.id).catch(error=>{if(error.status===404)return null;throw error;});
        const orders=ordersForPrincipal(principal);let view,commerce;
        if(commercePage[2]) {
          const page=await publicCatalogue.page(hub.id,commercePage[3]),plan=page.plans.find(p=>p.id===commercePage[4]);
          if(!plan)return send(404,{error:'not_found'});
          view='checkout';commerce={product:page.product,plan};
        } else if(commercePage[5]) {
          view=commercePage[6]?'order':'orders';commerce=commercePage[6]?{order:await orders.order(hub.id,commercePage[6])}:{orders:await orders.orders(hub.id)};
        } else if(commercePage[8]) {
          const tier=publicTiers?(await publicTiers.compare(hub.id)).tiers.find(t=>t.id===commercePage[9]):null;
          if(!tier)return send(404,{error:'not_found'});
          view='subscribe';commerce={tier};
        } else if(commercePage[10]) {
          view='subscriptions';commerce={subscriptions:await orders.subscriptions(hub.id),testMode:paymentProvider?.name==='test'};
        } else {view='sales';commerce={sales:await orders.sales(hub.id)};}
        const html=renderApplicationShell({hub,view,membership,commerce,consents:[],csrfToken:principal.csrfToken});
        res.writeHead(200,htmlHeaders);return res.end(html);
      }
      const enquiryPage=path.match(/^\/h\/([a-z0-9-]+)\/enquiries(?:\/([0-9a-f-]{36}))?$/);
      if(browserSessions && publicHubs && hubForPrincipal && messagingForPrincipal && req.method==='GET' && enquiryPage && (!enquiryPage[2]||uuid.test(enquiryPage[2]))) {
        const hub=await publicHubs.resolve({slug:enquiryPage[1]});
        const principal=await browserSessions.principal(req);
        if(!principal) {
          if(hostedSignIn){res.writeHead(303,{'location':'/h/'+hub.slug+'/sign-in?view=enquiries','cache-control':'no-store'});return res.end();}
          return send(401,{error:'unauthenticated'});
        }
        if(principal.hubId!==hub.id)return send(404,{error:'not_found'});
        // Prospects may enquire without joining, so membership is optional here.
        const membership=await hubForPrincipal(principal).membership(hub.id).catch(error=>{if(error.status===404)return null;throw error;});
        const messaging=messagingForPrincipal(principal);
        const enquiries=enquiryPage[2]?{thread:await messaging.enquiry(hub.id,enquiryPage[2])}:{inbox:await messaging.enquiries(hub.id)};
        const html=renderApplicationShell({hub,view:enquiryPage[2]?'enquiry':'enquiries',membership,enquiries:{...enquiries,userId:principal.userId},consents:[],csrfToken:principal.csrfToken});
        res.writeHead(200,htmlHeaders);return res.end(html);
      }
      const communityPage=path.match(/^\/h\/([a-z0-9-]+)\/(community|admin\/community)(?:\/(spaces|posts)\/([0-9a-f-]{36}))?$/);
      if(browserSessions && publicHubs && hubForPrincipal && communityForPrincipal && moderationForPrincipal && req.method==='GET' && communityPage &&
        (communityPage[2]==='community'||!communityPage[3]) && (!communityPage[4]||uuid.test(communityPage[4]))) {
        const hub=await publicHubs.resolve({slug:communityPage[1]});
        const principal=await browserSessions.principal(req);
        if(!principal) {
          if(hostedSignIn){res.writeHead(303,{'location':'/h/'+hub.slug+'/sign-in?view='+(communityPage[2]==='community'?'member':'admin'),'cache-control':'no-store'});return res.end();}
          return send(401,{error:'unauthenticated'});
        }
        if(principal.hubId!==hub.id)return send(404,{error:'not_found'});
        const membership=await hubForPrincipal(principal).membership(hub.id).catch(error=>{if(error.status===404)return null;throw error;});
        const service=communityForPrincipal(principal);
        let view,community;
        if(communityPage[2]==='admin/community') {
          if(!['owner','admin'].includes(membership?.role))return send(404,{error:'not_found'});
          const moderation=moderationForPrincipal(principal);
          view='community-admin';community={spaces:await moderation.adminSpaces(hub.id),reports:await moderation.reports(hub.id)};
        } else if(communityPage[3]==='spaces') {
          const space=(await service.spaces(hub.id)).spaces.find(s=>s.id===communityPage[4]);
          if(!space)return send(404,{error:'not_found'});
          view='space';community={space,feed:await service.feed(hub.id,space.id,{before:requestUrl.searchParams.get('before')})};
        } else if(communityPage[3]==='posts') {
          const thread=await service.post(hub.id,communityPage[4]);
          if(thread.decision==='locked')return send(404,{error:'not_found'});
          view='post';community={thread};
        } else {view='community';community=await service.spaces(hub.id);}
        const html=renderApplicationShell({hub,view,membership,community:{...community,userId:principal.userId},consents:[],csrfToken:principal.csrfToken});
        res.writeHead(200,htmlHeaders);return res.end(html);
      }      const adminPages=path.match(/^\/h\/([a-z0-9-]+)\/admin\/(products|library|tiers)(?:\/([0-9a-f-]{36}))?$/);
      if(browserSessions && publicHubs && hubForPrincipal && catalogueForPrincipal && libraryForPrincipal && tierForPrincipal && req.method==='GET' && adminPages && (!adminPages[3]||uuid.test(adminPages[3]))) {
        const hub=await publicHubs.resolve({slug:adminPages[1]}),entryId=adminPages[3];
        const principal=await browserSessions.principal(req);
        if(!principal) {
          if(hostedSignIn){res.writeHead(303,{'location':'/h/'+hub.slug+'/sign-in?view=admin','cache-control':'no-store'});return res.end();}
          return send(401,{error:'unauthenticated'});
        }
        if(principal.hubId!==hub.id)return send(404,{error:'not_found'});
        const membership=await hubForPrincipal(principal).membership(hub.id).catch(error=>{if(error.status===404)return null;throw error;});
        if(!['owner','admin'].includes(membership?.role))return send(404,{error:'not_found'});
        let view,catalogue;
        if(adminPages[2]==='tiers') {
          const tiers=tierForPrincipal(principal);
          view=entryId?'tier':'tiers';catalogue=entryId?await tiers.get(hub.id,entryId):{tiers:await tiers.list(hub.id)};
        } else if(adminPages[2]==='library') {
          const library=libraryForPrincipal(principal);
          view=entryId?'library-item':'library';
          catalogue=entryId?{item:await library.get(hub.id,entryId),products:await catalogueForPrincipal(principal).list(hub.id)}:{items:await library.list(hub.id)};
        } else {
          const products=catalogueForPrincipal(principal);view=entryId?'product':'products';
          catalogue=entryId?{detail:await products.get(hub.id,entryId),opens:(await products.opens(hub.id,entryId,{limit:20})).opens}:{products:await products.list(hub.id)};
        }
        const html=renderApplicationShell({hub,view,membership,catalogue,consents:[],csrfToken:principal.csrfToken});
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
      // Lessons and library items accept an optional identity: free content works
      // signed out. A malformed or invalid bearer is still rejected, never treated
      // as anonymous, and a session for another hub is not found.
      const optionalPrincipal=async(api,hubId)=>{
        if(req.headers.authorization) {
          const token=api&&req.headers.authorization.match(/^Bearer ([^\s]+)$/)?.[1];
          const principal=token?await authenticate(token):null;
          if(!principal||!uuid.test(principal.userId??''))throw Object.assign(new Error('Unauthenticated'),{status:401});
          return principal;
        }
        const principal=await browserSessions?.principal(req)??null;
        if(principal?.sessionHash && principal.hubId!==hubId)throw Object.assign(new Error('Not found'),{status:404});
        return principal;
      };
      const libraryApi=path.match(/^\/v1\/hubs\/([0-9a-f-]{36})\/library(?:\/([0-9a-f-]{36}))?$/);
      const libraryPage=path.match(/^\/h\/([a-z0-9-]+)\/library(?:\/([0-9a-f-]{36}))?$/);
      if(libraryForPrincipal && req.method==='GET' && ((libraryApi && uuid.test(libraryApi[1])) || (libraryPage && publicHubs)) && [libraryApi?.[2],libraryPage?.[2]].every(id=>!id||uuid.test(id))) {
        const hub=libraryApi?null:await publicHubs.resolve({slug:libraryPage[1]});
        const hubId=libraryApi?libraryApi[1]:hub.id,itemId=(libraryApi??libraryPage)[2];
        if(!itemId) {
          const page=await libraryForPrincipal(null).browse(hubId,{topic:requestUrl.searchParams.get('topic'),before:requestUrl.searchParams.get('before'),
            limit:requestUrl.searchParams.get('limit')??24});
          if(libraryApi)return send(200,page);
          res.writeHead(200,htmlHeaders);return res.end(renderLibrary(hub,page,{signIn:Boolean(hostedSignIn),topic:requestUrl.searchParams.get('topic')}));
        }
        const principal=await optionalPrincipal(Boolean(libraryApi),hubId);
        const result=await accessForPrincipal(principal??{userId:null}).openLibraryItem({hubId,userId:principal?.userId??null,itemId});
        if(result.decision==='not_found')return send(404,{error:'not_found'});
        if(libraryApi)return send(200,result);
        res.writeHead(200,htmlHeaders);return res.end(renderLibraryItem(hub,result,{signIn:Boolean(hostedSignIn)}));
      }
      const lessonApi=path.match(/^\/v1\/hubs\/([0-9a-f-]{36})\/lessons\/([0-9a-f-]{36})$/);
      const lessonPage=path.match(/^\/h\/([a-z0-9-]+)\/lessons\/([0-9a-f-]{36})$/);
      if(req.method==='GET' && ((lessonApi && uuid.test(lessonApi[1]) && uuid.test(lessonApi[2])) || (lessonPage && publicHubs && uuid.test(lessonPage[2])))) {
        const hub=lessonApi?null:await publicHubs.resolve({slug:lessonPage[1]});
        const hubId=lessonApi?lessonApi[1]:hub.id,lessonId=(lessonApi??lessonPage)[2];
        const principal=await optionalPrincipal(Boolean(lessonApi),hubId);
        const result=await accessForPrincipal(principal??{userId:null}).open({hubId,userId:principal?.userId??null,lessonId,device:req.headers['user-agent']??null});
        if(result.decision==='not_found')return send(404,{error:'not_found'});
        if(lessonApi)return send(200,result);
        // Signed-in learners get the CSRF token needed to save progress from the page.
        const session=principal?.sessionHash?{hubId,csrfToken:principal.csrfToken}:null;
        res.writeHead(200,htmlHeaders);return res.end(renderLessonPage(hub,result,{signIn:Boolean(hostedSignIn),session}));
      }
      // Payment webhooks carry no session: the provider's signature is the
      // authentication, verified before anything is recorded.
      const webhook=path.match(/^\/v1\/webhooks\/payments\/([a-z0-9-]{1,40})$/);
      if(paymentProvider && payments && req.method==='POST' && webhook) {
        if(webhook[1]!==paymentProvider.name)return send(404,{error:'not_found'});
        return send(200,await handlePaymentWebhook({provider:paymentProvider,payments},await readRaw(req,65536),req.headers));
      }
      // The test provider's hosted page: only exists while that stand-in is configured.
      const testPayment=path.match(/^\/test-payments\/(test_[0-9a-f-]{36})(?:\/(approve|decline))?$/);
      if(paymentProvider?.name==='test' && payments && testPayment) {
        if(req.method==='GET' && !testPayment[2]) {
          const session=paymentProvider.session(testPayment[1]);
          if(!session)return send(404,{error:'not_found'});
          res.writeHead(200,htmlHeaders);return res.end(renderTestPayment(session));
        }
        if(req.method==='POST' && testPayment[2]) {
          const completed=paymentProvider.complete(testPayment[1],testPayment[2]==='approve');
          if(!completed)return send(404,{error:'not_found'});
          await handlePaymentWebhook({provider:paymentProvider,payments},completed.body,completed.headers);
          res.writeHead(303,{'location':completed.returnUrl,'cache-control':'no-store'});return res.end();
        }
      }
      // The test provider's stored-card simulator for subscriptions (TEST MODE only).
      const testSubscription=path.match(/^\/test-payments\/subscriptions\/(test_[0-9a-f-]{36})(?:\/(renew|fail))?$/);
      if(paymentProvider?.name==='test' && payments && testSubscription) {
        const subscription=paymentProvider.subscription(testSubscription[1]);
        if(!subscription)return send(404,{error:'not_found'});
        if(req.method==='GET' && !testSubscription[2]){res.writeHead(200,htmlHeaders);return res.end(renderTestSubscription(subscription,requestUrl.searchParams.get('outcome')));}
        if(req.method==='POST' && testSubscription[2]) {
          const event=paymentProvider.renew(testSubscription[1],testSubscription[2]==='renew');
          const result=event?await handlePaymentWebhook({provider:paymentProvider,payments},event.body,event.headers):{outcome:'stopped'};
          res.writeHead(303,{'location':'/test-payments/subscriptions/'+testSubscription[1]+'?outcome='+encodeURIComponent(result.outcome),'cache-control':'no-store'});return res.end();
        }
      }
      // Published tiers are public so visitors can compare them.
      const tierList=path.match(/^\/v1\/hubs\/([0-9a-f-]{36})\/tiers$/);
      const membershipPage=path.match(/^\/h\/([a-z0-9-]+)\/membership$/);
      if(publicTiers && req.method==='GET' && ((tierList && uuid.test(tierList[1])) || (membershipPage && publicHubs))) {
        if(tierList)return send(200,await publicTiers.compare(tierList[1]));
        const hub=await publicHubs.resolve({slug:membershipPage[1]});
        res.writeHead(200,htmlHeaders);return res.end(renderMembership(hub,await publicTiers.compare(hub.id),{signIn:Boolean(hostedSignIn)}));
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
      const communityRoute=communityForPrincipal&&moderationForPrincipal?matchCommunityApi(path,req.method):null;
      const messagingRoute=messagingForPrincipal?matchMessagingApi(path,req.method):null;
      const tierRoute=tierForPrincipal?matchTierApi(path,req.method):null;
      const commerceRoute=checkoutForPrincipal&&ordersForPrincipal?matchCommerceApi(path,req.method):null;
      const libraryAdmin=path.match(/^\/v1\/hubs\/([0-9a-f-]{36})\/catalogue\/library(?:\/([0-9a-f-]{36})(?:\/(publish|archive))?)?$/);
      const libraryAdminRoute=libraryForPrincipal && libraryAdmin && uuid.test(libraryAdmin[1]) && (!libraryAdmin[2]||uuid.test(libraryAdmin[2])) &&
        (!libraryAdmin[2]?['GET','POST'].includes(req.method):!libraryAdmin[3]?['GET','PATCH'].includes(req.method):req.method==='POST');
      const learning=path.match(/^\/v1\/hubs\/([0-9a-f-]{36})\/learning$/);
      const learningRoute=learningForPrincipal && learning && uuid.test(learning[1]) && req.method==='GET';
      const catalogue=path.match(/^\/v1\/hubs\/([0-9a-f-]{36})\/catalogue\/products(?:\/([0-9a-f-]{36})(?:\/(modules|lessons|plans|publish|opens)(?:\/([0-9a-f-]{36})(?:\/(content))?)?)?)?$/);
      const catalogueRoute=catalogueForPrincipal && catalogue && [1,2,4].every(i=>catalogue[i]===undefined||uuid.test(catalogue[i])) &&
        (!catalogue[2]?['GET','POST'].includes(req.method):!catalogue[3]?['GET','PATCH'].includes(req.method):
          catalogue[3]==='opens'?req.method==='GET'&&!catalogue[4]:catalogue[5]?catalogue[3]==='lessons'&&req.method==='PUT':
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
      if(!commerceRoute && !tierRoute && !messagingRoute &&!communityRoute &&!libraryAdminRoute && !progressRoute && !learningRoute && !catalogueRoute && !domainRoute &&!orgDomainRoute &&!logoRoute && !noticeRoute && !readAccount && !linkRoute && !orgRoute &&!sessionRoute && !createHub && !hubRoute && !consentRoute && (req.method!=='GET'||!match||!uuid.test(match[1])||!uuid.test(match[2])))return send(404,{error:'not_found'});
      const bearer=req.headers.authorization?.match(/^Bearer ([^\s]+)$/)?.[1];
      if(req.headers.authorization && !bearer)return send(401,{error:'unauthenticated'});
      const principal=bearer?await authenticate(bearer):await browserSessions?.principal(req);
      if(!principal||!uuid.test(principal.userId??''))return send(401,{error:'unauthenticated'});
      const targetHub=commerceRoute?commerceRoute.hubId:tierRoute?tierRoute.hubId:messagingRoute?messagingRoute.hubId:communityRoute?communityRoute.hubId:libraryAdminRoute?libraryAdmin[1]:progressRoute?progress[1]:learningRoute?learning[1]:catalogueRoute?catalogue[1]:domainRoute?domain[1]:orgDomainRoute?orgDomain[1]:logoRoute?logo[1]:noticeRoute?notice[1]:readAccount?accountRoute[1]:linkRoute?links[1]:orgRoute?org[1]:sessionRoute?sessionAction[1]:hubRoute?hubAction[1]:consentRoute?consent[1]:match?.[1];
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
      if(commerceRoute) {
        // Commerce errors carry a specific code (join_first, already_owned, ...) for the screens.
        try {
          const result=await commerceRoute.run({checkout:checkoutForPrincipal(principal),orders:ordersForPrincipal(principal),headers:req.headers,
            query:requestUrl.searchParams,body:()=>readObject(req),resolveSlug:slug=>publicHubs.resolve({slug})});
          return send(result.status,result.body);
        }catch(error){if(error.status&&error.code)return send(error.status,{error:error.code});throw error;}
      }
      if(tierRoute) {
        const result=await tierRoute.run({tiers:tierForPrincipal(principal),query:requestUrl.searchParams,body:()=>readObject(req,32768)});
        return send(result.status,result.body);
      }
      if(messagingRoute) {
        const result=await messagingRoute.run({messaging:messagingForPrincipal(principal),query:requestUrl.searchParams,body:()=>readObject(req,32768)});
        return send(result.status,result.body);
      }
      if(communityRoute) {
        const result=await communityRoute.run({community:communityForPrincipal(principal),moderation:moderationForPrincipal(principal),
          query:requestUrl.searchParams,body:()=>readObject(req,32768)});
        return send(result.status,result.body);
      }
      if(libraryAdminRoute) {
        const library=libraryForPrincipal(principal),[,hubId,itemId,action]=libraryAdmin;
        if(!itemId)return req.method==='GET'?send(200,{items:await library.list(hubId)}):send(201,await library.create(hubId,await readObject(req,262144)));
        if(action)return send(200,await library.setStatus(hubId,itemId,action==='publish'?'published':'archived'));
        return send(200,req.method==='GET'?await library.get(hubId,itemId):await library.update(hubId,itemId,await readObject(req,262144)));
      }
      if(catalogueRoute) {
        const products=catalogueForPrincipal(principal),[,hubId,productId,part,planId,content]=catalogue;
        if(!productId)return req.method==='GET'?send(200,{products:await products.list(hubId)}):send(201,await products.create(hubId,await readObject(req)));
        if(!part)return send(200,req.method==='GET'?await products.get(hubId,productId):await products.update(hubId,productId,await readObject(req)));
        if(part==='publish')return send(200,await products.publish(hubId,productId));
        if(part==='opens')return send(200,await products.opens(hubId,productId,{before:requestUrl.searchParams.get('before'),limit:requestUrl.searchParams.get('limit')??50}));
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
