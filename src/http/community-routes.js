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
export const matchTierApi=routeTable([
  ['GET',`catalogue/tiers`,async(c,h)=>({tiers:await c.tiers.list(h)})],
  ['POST',`catalogue/tiers`,async(c,h)=>[201,await c.tiers.create(h,await c.body())]],
  ['GET',`catalogue/tiers/${id}`,(c,h,t)=>c.tiers.get(h,t)],
  ['PATCH',`catalogue/tiers/${id}`,async(c,h,t)=>c.tiers.update(h,t,await c.body())],
  ['POST',`catalogue/tiers/${id}/(publish|archive)`,(c,h,t,a)=>c.tiers.setStatus(h,t,a==='publish'?'published':'archived')],
  ['POST',`catalogue/tiers/${id}/benefits`,async(c,h,t)=>[201,await c.tiers.addBenefit(h,t,await c.body())]],
  ['DELETE',`catalogue/tiers/${id}/benefits/${id}`,(c,h,t,b)=>c.tiers.removeBenefit(h,t,b)]
]);
export const matchCommerceApi=routeTable([
  ['POST',`checkout`,async(c,h)=>{
    const input=await c.body(),hub=await c.resolveSlug(input.slug);
    if(hub.id!==h)throw Object.assign(new Error('Not found'),{status:404});
    const seats=input.orgId===undefined?null:{orgId:input.orgId,quantity:input.quantity};
    return [201,await c.checkout.checkout(h,{planId:input.planId,seats,idempotencyKey:c.headers['idempotency-key'],returnUrlFor:id=>'/h/'+hub.slug+'/orders/'+id})];
  }],
  ['GET',`orders`,async(c,h)=>({orders:await c.orders.orders(h)})],
  ['POST',`subscriptions`,async(c,h)=>{
    const input=await c.body(),hub=await c.resolveSlug(input.slug);
    if(hub.id!==h)throw Object.assign(new Error('Not found'),{status:404});
    return [201,await c.checkout.subscribe(h,{tierId:input.tierId??null,planId:input.planId??null,idempotencyKey:c.headers['idempotency-key'],returnUrlFor:()=>'/h/'+hub.slug+'/subscriptions'})];
  }],
  ['GET',`subscriptions`,async(c,h)=>({subscriptions:await c.orders.subscriptions(h)})],
  ['POST',`subscriptions/${id}/cancel`,(c,h,s)=>c.checkout.cancel(h,s)],
  ['GET',`orders/${id}`,(c,h,o)=>c.orders.order(h,o)],
  ['GET',`catalogue/sales`,(c,h)=>c.orders.sales(h)],
  ['POST',`catalogue/sales/${id}/refund`,(c,h,o)=>c.checkout.refund(h,o)]
]);
export const matchSeatApi=routeTable([
  ['GET',`seats/companies`,async(c,h)=>({companies:await c.seats.companies(h)})],
  ['GET',`seats`,(c,h)=>c.seats.overview(h,c.query.get('org'))],
  ['POST',`catalogue/seat-grants`,async(c,h)=>{
    const input=await c.body();
    return [201,await c.seats.grant(h,{orgId:input.orgId,productId:input.productId,seats:input.seats,reference:input.reference,idempotencyKey:c.headers['idempotency-key']})];
  }],
  ['POST',`catalogue/seat-grants/${id}/end`,(c,h,p)=>c.seats.endPool(h,p)],
  ['POST',`seat-pools/${id}/assignments`,async(c,h,p)=>[201,await c.seats.assign(h,p,(await c.body()).userId)]],
  ['DELETE',`seat-pools/${id}/assignments/${id}`,(c,h,p,u)=>c.seats.revoke(h,p,u)]
]);