export const uuidGroup='([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})';
/** Builds a matcher for hub-scoped API routes: [method, path after /v1/hubs/{hub}/, handler].
 * The server authenticates, enforces the session hub and CSRF, then calls run
 * with the verified context. A handler may return [status, body] or a body (200).
 */
export function routeTable(entries) {
  const routes=entries.map(([method,pattern,handler])=>({method,pattern:new RegExp('^/v1/hubs/'+uuidGroup+'/'+pattern+'$'),handler}));
  return (path,method)=>{
    for(const route of routes) {
      const match=route.method===method&&path.match(route.pattern);
      if(match)return {hubId:match[1],run:async context=>{
        const result=await route.handler(context,...match.slice(1));
        return Array.isArray(result)?{status:result[0],body:result[1]}:{status:200,body:result};
      }};
    }
    return null;
  };
}
