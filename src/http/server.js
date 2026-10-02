import { createServer } from 'node:http';
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** authenticate verifies a bearer credential and returns a server-resolved userId.
 * No default authenticator, development header override or public token issuer.
 * This endpoint returns an ACCESS DECISION only, never media/content.
 */
export function createApi({authenticate,accessForPrincipal,onError=()=>{}}) {
  if(typeof authenticate!=='function'||typeof accessForPrincipal!=='function')throw Error('Verified authentication adapter required');
  return createServer(async(req,res)=>{
    const send=(status,body)=>{res.writeHead(status,{'content-type':'application/json','cache-control':'no-store'});res.end(JSON.stringify(body));};
    try{
      const path=new URL(req.url,'http://localhost').pathname;
      const match=path.match(/^\/v1\/hubs\/([^/]+)\/lessons\/([^/]+)\/access$/);
      if(req.method!=='GET'||!match||!uuid.test(match[1])||!uuid.test(match[2]))return send(404,{error:'not_found'});
      const bearer=req.headers.authorization?.match(/^Bearer ([^\s]+)$/)?.[1];
      if(!bearer)return send(401,{error:'unauthenticated'});
      const principal=await authenticate(bearer);
      if(!principal||!uuid.test(principal.userId??''))return send(401,{error:'unauthenticated'});
      const access=accessForPrincipal(principal);
      const result=await access.check({hubId:match[1],targetId:match[2],userId:principal.userId});
      if(result.decision==='not_found')return send(404,{error:'not_found'});
      return send(200,result);
    }catch(error){onError(error);return send(500,{error:'internal_error'});}
  });
}
