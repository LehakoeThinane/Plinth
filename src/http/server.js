import { createServer } from 'node:http';
import { renderStorefront } from './storefront.js';
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
async function readObject(req) {
  req.setEncoding('utf8');
  let body='';
  for await(const chunk of req) {
    body+=chunk;
    if(Buffer.byteLength(body)>4096)throw Object.assign(new Error('Body too large'),{status:413});
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
export function createApi({authenticate,accessForPrincipal,consentForPrincipal,hubForPrincipal,publicHubs,onError=()=>{}}) {
  if(typeof authenticate!=='function'||typeof accessForPrincipal!=='function')throw Error('Verified authentication adapter required');
  return createServer(async(req,res)=>{
    const send=(status,body)=>{res.writeHead(status,{'content-type':'application/json','cache-control':'no-store'});res.end(JSON.stringify(body));};
    try{
      const requestUrl=new URL(req.url,'http://localhost');
      const path=requestUrl.pathname;
      const storefront=path.match(/^\/h\/([a-z0-9-]+)$/);
      if(publicHubs && req.method==='GET' && storefront) {
        const html=renderStorefront(await publicHubs.resolve({slug:storefront[1]}));
        res.writeHead(200,{'content-type':'text/html; charset=utf-8','cache-control':'no-store',
          'content-security-policy':"default-src 'none'; style-src 'unsafe-inline'; img-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
          'x-content-type-options':'nosniff','referrer-policy':'strict-origin-when-cross-origin'});
        return res.end(html);
      }
      if(publicHubs && req.method==='GET' && path==='/v1/hubs/resolve') {
        return send(200,await publicHubs.resolve({slug:requestUrl.searchParams.get('slug'),hostname:requestUrl.searchParams.get('hostname')}));
      }
      const match=path.match(/^\/v1\/hubs\/([^/]+)\/lessons\/([^/]+)\/access$/);
      const consent=path.match(/^\/v1\/hubs\/([^/]+)\/consents$/);
      const consentRoute=consentForPrincipal && consent && uuid.test(consent[1]) && ['GET','PUT'].includes(req.method);
      const hubAction=path.match(/^\/v1\/hubs\/([^/]+)\/(join|membership|branding)$/);
      const createHub=hubForPrincipal && path==='/v1/hubs' && req.method==='POST';
      const hubRoute=hubForPrincipal && hubAction && uuid.test(hubAction[1]) &&
        req.method===({join:'POST',membership:'GET',branding:'PUT'})[hubAction[2]];
      if(!createHub && !hubRoute && !consentRoute && (req.method!=='GET'||!match||!uuid.test(match[1])||!uuid.test(match[2])))return send(404,{error:'not_found'});
      const bearer=req.headers.authorization?.match(/^Bearer ([^\s]+)$/)?.[1];
      if(!bearer)return send(401,{error:'unauthenticated'});
      const principal=await authenticate(bearer);
      if(!principal||!uuid.test(principal.userId??''))return send(401,{error:'unauthenticated'});
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
      if([400,404,409,413].includes(error.status))return send(error.status,{error:({400:'invalid_request',404:'not_found',409:'conflict',413:'body_too_large'})[error.status]});
      onError(error);return send(500,{error:'internal_error'});
    }
  });
}
