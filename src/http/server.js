import { createServer } from 'node:http';
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** authenticate verifies a bearer credential and returns a server-resolved userId.
 * No default authenticator, development header override or public token issuer.
 * This endpoint returns an ACCESS DECISION only, never media/content.
 */
export function createApi({authenticate,accessForPrincipal,consentForPrincipal,onError=()=>{}}) {
  if(typeof authenticate!=='function'||typeof accessForPrincipal!=='function')throw Error('Verified authentication adapter required');
  return createServer(async(req,res)=>{
    const send=(status,body)=>{res.writeHead(status,{'content-type':'application/json','cache-control':'no-store'});res.end(JSON.stringify(body));};
    try{
      const path=new URL(req.url,'http://localhost').pathname;
      const match=path.match(/^\/v1\/hubs\/([^/]+)\/lessons\/([^/]+)\/access$/);
      const consent=path.match(/^\/v1\/hubs\/([^/]+)\/consents$/);
      const consentRoute=consentForPrincipal && consent && uuid.test(consent[1]) && ['GET','PUT'].includes(req.method);
      if(!consentRoute && (req.method!=='GET'||!match||!uuid.test(match[1])||!uuid.test(match[2])))return send(404,{error:'not_found'});
      const bearer=req.headers.authorization?.match(/^Bearer ([^\s]+)$/)?.[1];
      if(!bearer)return send(401,{error:'unauthenticated'});
      const principal=await authenticate(bearer);
      if(!principal||!uuid.test(principal.userId??''))return send(401,{error:'unauthenticated'});
      if(consentRoute) {
        const repository=consentForPrincipal(principal);
        if(req.method==='GET')return send(200,{consents:await repository.list(consent[1])});
        let body='';
        for await (const chunk of req) {
          body+=chunk;
          if(Buffer.byteLength(body)>4096)return send(413,{error:'body_too_large'});
        }
        let decision;
        try { decision=JSON.parse(body); } catch { return send(400,{error:'invalid_json'}); }
        if(!decision || typeof decision!=='object' || Array.isArray(decision))return send(400,{error:'invalid_consent'});
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
    }catch(error){onError(error);return send(500,{error:'internal_error'});}
  });
}
