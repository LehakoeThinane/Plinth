import { routeTable,uuidGroup as id } from './route-table.js';
export const matchCommunityApi=routeTable([
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
]);
export const matchMessagingApi=routeTable([
  ['GET',`enquiries`,(c,h)=>c.messaging.enquiries(h)],
  ['POST',`enquiries`,async(c,h)=>[201,await c.messaging.createEnquiry(h,await c.body())]],
  ['GET',`enquiries/${id}`,(c,h,e)=>c.messaging.enquiry(h,e)],
  ['PATCH',`enquiries/${id}`,async(c,h,e)=>c.messaging.setStatus(h,e,(await c.body()).status)],
  ['GET',`conversations/${id}/messages`,(c,h,v)=>c.messaging.history(h,v,{before:c.query.get('before'),limit:c.query.get('limit')??50})],
  ['POST',`conversations/${id}/messages`,async(c,h,v)=>[201,await c.messaging.send(h,v,await c.body())]],
  ['PUT',`conversations/${id}/read`,(c,h,v)=>c.messaging.markRead(h,v)]
]);
