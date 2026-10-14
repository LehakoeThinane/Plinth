import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { CatalogueRepository } from '../src/db/catalogue-repository.js';
import { CommerceRepository,PaymentsRepository } from '../src/db/commerce-repository.js';
import { SeatRepository } from '../src/db/seat-repository.js';
import { CheckoutService,handlePaymentWebhook } from '../src/modules/commerce/checkout-service.js';
import { PostgresAccessRepository } from '../src/db/access-repository.js';
import { AccessService } from '../src/access.js';
import { MemoryAccessCache } from '../src/cache/memory.js';
export async function seatChecks({admin,app,db,paymentsPool,provider,hubId,userA,otherOrg,check,base,fetch,slug,testUsers,testOrgs}) {
  const catalogue=new CatalogueRepository(db,userA),payments=new PaymentsRepository(paymentsPool);
  const checkout=user=>new CheckoutService({orders:new CommerceRepository(db,user),provider,payments});
  const seats=user=>new SeatRepository(db,user);
  const buySeats=(user,planId,quantity,key=randomUUID())=>checkout(user).checkout(hubId,{planId,seats:{orgId:org,quantity},idempotencyKey:key,returnUrlFor:id=>'/h/'+slug+'/orders/'+id});
  const referenceOf=orderId=>admin.query('SELECT psp_reference FROM commerce.orders WHERE id=$1',[orderId]).then(r=>r.rows[0].psp_reference);
  const pay=async orderId=>{const done=provider.complete(await referenceOf(orderId),true);return handlePaymentWebhook({provider,payments},done.body,done.headers);};
  const opens=async(user,lessonId)=>(await new AccessService(new PostgresAccessRepository(db,user),new MemoryAccessCache()).open({hubId,userId:user,lessonId})).decision;
  const [companyAdmin,emp1,emp2,emp3,outsider]=Array.from({length:5},()=>randomUUID());testUsers.push(companyAdmin,emp1,emp2,emp3,outsider);
  const org=randomUUID();testOrgs.push(org);
  await admin.query("INSERT INTO identity.users(id,display_name) VALUES ($1,'Nomsa'),($2,'Emp One'),($3,'Emp Two'),($4,'Emp Three'),($5,'Outsider')",[companyAdmin,emp1,emp2,emp3,outsider]);
  await admin.query("INSERT INTO identity.organisations(id,display_name) VALUES ($1,'Seat Co')",[org]);
  await admin.query(`INSERT INTO identity.org_members(user_id,org_id,status,role) VALUES ($1,$5,'active','admin'),($2,$5,'active','member'),($3,$5,'active','member'),($4,$5,'active','member')`,
    [companyAdmin,emp1,emp2,emp3,org]);
  // emp1 is not yet a hub member: a seat brings them in. emp3 is suspended in the hub.
  await admin.query("INSERT INTO tenancy.memberships(hub_id,user_id,role,status) VALUES ($1,$2,'member','active'),($1,$3,'member','active'),($1,$4,'member','suspended'),($1,$5,'member','active')",
    [hubId,companyAdmin,emp2,emp3,outsider]);
  const course=await catalogue.create(hubId,{type:'course',title:'Team <b>course</b>',visibility:'public',accessMode:'entitled'});
  const lesson=(await catalogue.addLesson(hubId,course.id,{moduleId:(await catalogue.addModule(hubId,course.id,{title:'M'})).id,title:'L'})).id;
  const perSeat=(await catalogue.addPlan(hubId,course.id,{model:'per_seat',amountCents:100000})).id;
  const onceOff=(await catalogue.addPlan(hubId,course.id,{model:'once_off',amountCents:150000})).id;
  await catalogue.publish(hubId,course.id);
  const programme=await catalogue.create(hubId,{type:'programme',title:'Seat Co programme',visibility:'company',accessMode:'entitled',companyOrg:org});
  const programmeLesson=(await catalogue.addLesson(hubId,programme.id,{moduleId:(await catalogue.addModule(hubId,programme.id,{title:'M'})).id,title:'Private'})).id;
  await catalogue.publish(hubId,programme.id);
  const free=await catalogue.create(hubId,{type:'toolkit',title:'Free',visibility:'public',accessMode:'open'});
  let pool;
  await check('a company admin buys seats; payment creates a pool and nobody has access until a seat is assigned',async()=>{
    await assert.rejects(buySeats(emp2,perSeat,2),{status:409,code:'not_company_admin'});
    await assert.rejects(buySeats(outsider,perSeat,2),{status:409,code:'not_company_admin'});
    await assert.rejects(buySeats(companyAdmin,onceOff,2),{status:409,code:'not_a_seat_price'});
    await assert.rejects(buySeats(companyAdmin,perSeat,0),{status:400});
    await assert.rejects(buySeats(companyAdmin,perSeat,1001),{status:400});
    const key=randomUUID(),order=await buySeats(companyAdmin,perSeat,2,key);
    assert.deepEqual(await buySeats(companyAdmin,perSeat,2,key),order);
    await assert.rejects(buySeats(companyAdmin,perSeat,3,key),{status:409,code:'idempotency_key_reused'});
    assert.deepEqual(await pay(order.orderId),{outcome:'paid'});
    const row=(await admin.query('SELECT status,total_cents,kind,seat_org FROM commerce.orders WHERE id=$1',[order.orderId])).rows[0];
    assert.deepEqual([row.status,Number(row.total_cents),row.kind,row.seat_org],['paid',200000,'seats',org]);
    const pools=(await admin.query('SELECT id,seats,source,status,org_id FROM commerce.seat_pools WHERE order_id=$1',[order.orderId])).rows;
    assert.deepEqual(pools.map(p=>[p.seats,p.source,p.status,p.org_id]),[[2,'purchase','active',org]]);pool=pools[0].id;
    assert.equal((await admin.query('SELECT count(*)::int AS n FROM access.entitlements WHERE seat_pool_id=$1 OR order_id=$2',[pool,order.orderId])).rows[0].n,0);
    assert.notEqual(await opens(companyAdmin,lesson),'allowed');
  });
  await check('a seat is an ordinary entitlement; the pool lock stops the last seat going twice',async()=>{
    const view=await seats(companyAdmin).overview(hubId,org);
    assert.deepEqual(view.pools.map(p=>[p.productTitle,p.seats,p.holders.length]),[['Team <b>course</b>',2,0]]);
    assert.deepEqual(view.members.map(m=>m.name).sort(),['Emp One','Emp Three','Emp Two','Nomsa']);
    assert.deepEqual(await seats(companyAdmin).companies(hubId),[{id:org,display_name:'Seat Co'}]);
    const first=await seats(companyAdmin).assign(hubId,pool,emp1);
    assert.deepEqual(await seats(companyAdmin).assign(hubId,pool,emp1),first,'assigning again returns the same seat');
    assert.deepEqual((await admin.query('SELECT role,status FROM tenancy.memberships WHERE hub_id=$1 AND user_id=$2',[hubId,emp1])).rows,[{role:'member',status:'active'}]);
    assert.deepEqual((await admin.query('SELECT source,kind,target_id FROM access.entitlements WHERE id=$1',[first.entitlementId])).rows,[{source:'seat',kind:'product',target_id:course.id}]);
    assert.equal(await opens(emp1,lesson),'allowed');
    const race=await Promise.allSettled([seats(companyAdmin).assign(hubId,pool,emp2),seats(companyAdmin).assign(hubId,pool,companyAdmin)]);
    assert.equal(race.filter(r=>r.status==='fulfilled').length,1,'exactly one person gets the last seat');
    assert.equal(race.find(r=>r.status==='rejected').reason.code,'no_seats_left');
    await assert.rejects(seats(companyAdmin).assign(hubId,pool,outsider),{status:409,code:'not_company_member'});
    // Only the company's own admins assign seats: not its members, not the provider.
    await assert.rejects(seats(emp1).assign(hubId,pool,emp2),{status:404});
    await assert.rejects(seats(userA).assign(hubId,pool,emp2),{status:404});
    await assert.rejects(seats(emp1).overview(hubId,org),{status:404});
    await assert.rejects(seats(emp1).overview(hubId,null),{status:404});
  });
  await check('taking a seat back ends access at once and frees the seat',async()=>{
    assert.deepEqual(await seats(companyAdmin).revoke(hubId,pool,emp1),{revoked:true});
    assert.notEqual(await opens(emp1,lesson),'allowed');
    assert.deepEqual(await seats(companyAdmin).revoke(hubId,pool,emp1),{revoked:false});
    await assert.rejects(seats(companyAdmin).assign(hubId,pool,emp3),{status:409,code:'member_suspended'});
    assert.equal((await admin.query('SELECT status FROM tenancy.memberships WHERE hub_id=$1 AND user_id=$2',[hubId,emp3])).rows[0].status,'suspended');
    // The provider can take a seat back too, for example after abuse.
    const holder=(await seats(companyAdmin).overview(hubId,org)).pools[0].holders[0].userId;
    assert.deepEqual(await seats(userA).revoke(hubId,pool,holder),{revoked:true});
    assert.equal((await seats(companyAdmin).overview(hubId,org)).pools[0].holders.length,0);
    await assert.rejects(seats(emp1).revoke(hubId,pool,holder),{status:404});
    const audit=(await admin.query('SELECT user_id,assigned_by,revoked_by FROM commerce.seat_assignments WHERE pool_id=$1 AND revoked_at IS NOT NULL ORDER BY revoked_at',[pool])).rows;
    assert.deepEqual(audit.map(a=>[a.user_id,a.assigned_by,a.revoked_by]),[[emp1,companyAdmin,companyAdmin],[holder,companyAdmin,userA]]);
  });
  await check('providers grant seats for off-platform deals; company product seats only go to that company',async()=>{
    const key=randomUUID(),grant=input=>seats(userA).grant(hubId,{orgId:org,productId:programme.id,seats:5,reference:'PO-2026-01',idempotencyKey:key,...input});
    const {poolId}=await grant();
    assert.deepEqual(await grant(),{poolId},'a retried grant returns the same pool');
    await assert.rejects(grant({seats:6}),{status:409,code:'idempotency_key_reused'});
    await assert.rejects(grant({idempotencyKey:randomUUID(),orgId:otherOrg}),{status:409,code:'wrong_organisation'});
    await assert.rejects(grant({idempotencyKey:randomUUID(),productId:free.id}),{status:409,code:'not_a_paid_product'});
    await assert.rejects(grant({idempotencyKey:randomUUID(),reference:'  '}),{status:400});
    await assert.rejects(grant({idempotencyKey:randomUUID(),orgId:randomUUID()}),{status:409,code:'unknown_organisation'});
    await assert.rejects(seats(companyAdmin).grant(hubId,{orgId:org,productId:programme.id,seats:5,reference:'PO',idempotencyKey:randomUUID()}),{status:404});
    const row=(await admin.query('SELECT source,external_reference,granted_by,order_id FROM commerce.seat_pools WHERE id=$1',[poolId])).rows[0];
    assert.deepEqual(row,{source:'provider_grant',external_reference:'PO-2026-01',granted_by:userA,order_id:null});
    await seats(companyAdmin).assign(hubId,poolId,emp2);
    assert.equal(await opens(emp2,programmeLesson),'allowed');
    assert.notEqual(await opens(emp1,programmeLesson),'allowed');
    const all=await seats(userA).overview(hubId,null);
    assert.deepEqual(all.pools.filter(p=>p.orgId===org).map(p=>[p.source,p.holders.length]).sort(),[['provider_grant',1],['purchase',0]]);
    assert.deepEqual(all.members,[]);
    await assert.rejects(seats(userA).endPool(hubId,pool),{status:409,code:'purchased_seats'});
    assert.deepEqual(await seats(userA).endPool(hubId,poolId),{ended:true});
    assert.notEqual(await opens(emp2,programmeLesson),'allowed');
    await assert.rejects(seats(companyAdmin).assign(hubId,poolId,emp1),{status:409,code:'seats_ended'});
  });
  await check('refunding a seat purchase ends the pool and every seat assigned from it',async()=>{
    const order=await buySeats(companyAdmin,perSeat,1);await pay(order.orderId);
    const bought=(await admin.query('SELECT id FROM commerce.seat_pools WHERE order_id=$1',[order.orderId])).rows[0].id;
    await seats(companyAdmin).assign(hubId,bought,emp1);
    assert.equal(await opens(emp1,lesson),'allowed');
    assert.deepEqual(await checkout(userA).refund(hubId,order.orderId),{outcome:'refunded'});
    assert.equal((await admin.query('SELECT status FROM commerce.seat_pools WHERE id=$1',[bought])).rows[0].status,'ended');
    assert.equal((await admin.query('SELECT count(*)::int AS n FROM commerce.seat_assignments WHERE pool_id=$1 AND revoked_at IS NULL',[bought])).rows[0].n,0);
    assert.notEqual(await opens(emp1,lesson),'allowed');
    const ledger=(await admin.query('SELECT sum(debit_cents)::bigint AS d,sum(credit_cents)::bigint AS c FROM commerce.ledger_entries WHERE order_id=$1',[order.orderId])).rows[0];
    assert.equal(ledger.d,ledger.c);
  });
  await check('seat records are closed to direct access; only the seat functions change them',async()=>{
    await assert.rejects(db.withSnapshot({hubId,userId:userA,orgIds:[],isStaff:true},tx=>tx.query('SELECT * FROM commerce.seat_pools')),{code:'42501'});
    await assert.rejects(db.withSnapshot({hubId,userId:companyAdmin,orgIds:[org],isStaff:false},tx=>tx.query('SELECT * FROM commerce.seat_assignments')),{code:'42501'});
    await assert.rejects(app.query('SELECT app.assign_seat($1,$2)',[pool,emp1]),{code:'42501'});
    await assert.rejects(db.withSnapshot({hubId,userId:companyAdmin,orgIds:[org],isStaff:false},tx=>tx.query(
      "INSERT INTO access.entitlements(hub_id,id,user_id,target_id,kind,source,seat_pool_id) VALUES($1,$2,$3,$4,'product','seat',$5)",[hubId,randomUUID(),emp2,course.id,pool])),{code:'42501'});
    // Buying seats for an organisation needs its admin role, even writing the order directly.
    await assert.rejects(db.withSnapshot({hubId,userId:emp2,orgIds:[],isStaff:false},tx=>tx.query(
      "INSERT INTO commerce.orders(hub_id,id,buyer_id,subtotal_cents,total_cents,idempotency_key,request_hash,kind,seat_org) VALUES($1,$2,$3,100000,100000,$4,$5,'seats',$6)",
      [hubId,randomUUID(),emp2,randomUUID(),'e'.repeat(64),org])),{code:'42501'});
  });
  await check('seat pages and API: product pages offer seats, admins see every pool',async()=>{
    const auth={authorization:'Bearer learner-a'};
    const product=await (await fetch(base+'/h/'+slug+'/products/'+course.id)).text();
    assert.ok(product.includes('/checkout/'+course.id+'/'+perSeat+'">Buy seats'));
    const api=await fetch(base+'/v1/hubs/'+hubId+'/seats',{headers:auth});assert.equal(api.status,200);
    assert.ok((await api.json()).pools.some(p=>p.orgId===org));
    const denied=await fetch(base+'/v1/hubs/'+hubId+'/seat-pools/'+pool+'/assignments',{method:'POST',headers:auth,body:JSON.stringify({userId:emp1})});
    assert.deepEqual([denied.status,(await denied.json()).error],[404,'not_found']);
    const host='learn-new.example',exchange=await fetch(base+'/v1/hubs/'+hubId+'/session',{method:'POST',headers:{...auth,host,origin:'https://'+host}});
    const cookie=exchange.headers.get('set-cookie').split(';')[0];
    const adminPage=await (await fetch(base+'/h/'+slug+'/admin/seats',{headers:{host,cookie}})).text();
    assert.ok(adminPage.includes('Grant seats for an off-platform deal'));assert.ok(adminPage.includes('Seat Co'));assert.ok(adminPage.includes('PO-2026-01'));
    // The page depends on which organisations this person administers (earlier checks may have made some).
    const companies=await seats(userA).companies(hubId);
    const mine=await (await fetch(base+'/h/'+slug+'/seats',{headers:{host,cookie}})).text();
    assert.ok(companies.length?mine.includes('has no seats here yet'):mine.includes('You are not an administrator of any organisation'));
    assert.ok(!mine.includes('Seat Co'),'another company’s seats never appear');
    const buy=await (await fetch(base+'/h/'+slug+'/checkout/'+course.id+'/'+perSeat,{headers:{host,cookie}})).text();
    assert.ok(companies.length?buy.includes('id="seat-quantity"'):buy.includes('Seats are bought by a company administrator'));
  });
}
