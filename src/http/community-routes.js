const id='([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})';
const routes=[
  ['GET',`spaces`,(c,h)=>c.community.spaces(h)],
  ['GET',`spaces/${id}/posts`,(c,h,s)=>c.community.feed(h,s,{before:c.query.get('before'),limit:c.query.get('limit')??20})],
  ['POST',`spaces/${id}/posts`,async(c,h,s)=>[201,await c.community.createPost(h,s,await c.body())]],
  ['GET',`posts/${id}`,(c,h,p)=>c.community.post(h,p)],
  ['DELETE',`posts/${id}`,(c,h,p)=>c.community.withdraw(h,'post',p)],
  ['POST',`posts/${id}/comments`,async(c,h,p)=>[201,await c.community.comment(h,p,await c.body())]],
  ['PUT',`posts/${id}/reactions/([a-z]+)`,(c,h,p,k)=>c.community.react(h,p,k,true)],
  ['DELETE',`posts/${id}/reactions/([a-z]+)`,(c,h,p,k)=>c.community.react(h,p,k,false)],
  ['DELETE',`comments/${id}`,(c,h,m)=>c.community.withdraw(h,'comment',m)],
  ['POST',`reports`,async(c,h)=>[201,await c.community.report(h,await c.body())]],
  ['GET',`catalogue/spaces`,async(c,h)=>({spaces:await c.moderation.adminSpaces(h)})],
  ['POST',`catalogue/spaces`,async(c,h)=>[201,await c.moderation.createSpace(h,await c.body())]],
  ['PATCH',`catalogue/spaces/${id}`,async(c,h,s)=>c.moderation.updateSpace(h,s,await c.body())],
  ['GET',`catalogue/reports`,async(c,h)=>({reports:await c.moderation.reports(h,{status:c.query.get('status')??'open'})})],
  ['POST',`catalogue/reports/${id}/resolve`,async(c,h,r)=>c.moderation.resolve(h,r,(await c.body()).action)]
].map(([method,pattern,handler])=>({method,pattern:new RegExp('^/v1/hubs/'+id+'/'+pattern+'$'),handler}));
/** Matches a community API route. The server authenticates, enforces the
 * session hub and CSRF, then calls run with the verified context.
 */
export function matchCommunityApi(path,method) {
  for(const route of routes) {
    const match=route.method===method&&path.match(route.pattern);
    if(match)return {hubId:match[1],run:async context=>{
      const result=await route.handler(context,...match.slice(1));
      return Array.isArray(result)?{status:result[0],body:result[1]}:{status:200,body:result};
    }};
  }
  return null;
}
