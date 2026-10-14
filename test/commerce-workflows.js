import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { CatalogueRepository } from '../src/db/catalogue-repository.js';
import { CommerceRepository,PaymentsRepository } from '../src/db/commerce-repository.js';
import { CheckoutService,handlePaymentWebhook } from '../src/modules/commerce/checkout-service.js';
import { PostgresAccessRepository } from '../src/db/access-repository.js';
import { AccessService } from '../src/access.js';
import { MemoryAccessCache } from '../src/cache/memory.js';
import { auditPolicies } from '../src/db/policy-audit.js';
export async function commerceChecks({admin,app,db,paymentsPool,provider,hubId,userA,check,base,fetch,slug,testUsers}) {
  const catalogue=new CatalogueRepository(db,userA),payments=new PaymentsRepository(paymentsPool);
  const checkout=user=>new CheckoutService({orders:new CommerceRepository(db,user),provider});
  const start=(user,planId,key=randomUUID())=>checkout(user).checkout(hubId,{planId,idempotencyKey:key,returnUrlFor:id=>'/h/'+slug+'/orders/'+id});
  const pay=(reference,approved=true)=>{const done=provider.complete(reference,approved);return handlePaymentWebhook({provider,payments},done.body,done.headers);};
  const referenceOf=orderId=>admin.query('SELECT psp_reference FROM commerce.orders WHERE id=$1',[orderId]).then(r=>r.rows[0].psp_reference);
  const [buyer,buyer2,outsider]=Array.from({length:3},()=>randomUUID());testUsers.push(buyer,buyer2,outsider);
  await admin.query('INSERT INTO identity.users(id) SELECT unnest($1::uuid[])',[[buyer,buyer2,outsider]]);
  await admin.query("INSERT INTO tenancy.memberships(hub_id,user_id,role,status) VALUES($1,$2,'member','active'),($1,$3,'member','active')",[hubId,buyer,buyer2]);
  const product=await catalogue.create(hubId,{type:'course',title:'Paid <b>course</b>',visibility:'public',accessMode:'entitled'});
  const module=await catalogue.addModule(hubId,product.id,{title:'M'}),lesson=(await catalogue.addLesson(hubId,product.id,{moduleId:module.id,title:'L'})).id;
  const plan=(await catalogue.addPlan(hubId,product.id,{model:'once_off',amountCents:50000})).id;
  const subscription=(await catalogue.addPlan(hubId,product.id,{model:'subscription',amountCents:9900,interval:'month'})).id;
  await catalogue.publish(hubId,product.id);
  const draft=await catalogue.create(hubId,{type:'course',title:'Draft',visibility:'public',accessMode:'entitled'});
  const draftPlan=(await catalogue.addPlan(hubId,draft.id,{model:'once_off',amountCents:1000})).id;
  let order;
  await check('checkout makes one pending order per idempotency key and refuses invalid purchases',async()=>{
    const key=randomUUID();order=await start(buyer,plan,key);
    assert.match(order.redirectUrl,/^\/test-payments\/test_/);assert.deepEqual(await start(buyer,plan,key),order);
    await assert.rejects(start(buyer,subscription,key),{status:409,code:'idempotency_key_reused'});
    await assert.rejects(start(buyer,subscription),{status:409,code:'not_yet_supported'});
    await assert.rejects(start(outsider,plan),{status:409,code:'join_first'});
    await assert.rejects(start(buyer,draftPlan),{status:404});
    await assert.rejects(checkout(buyer).checkout(hubId,{planId:plan,idempotencyKey:'',returnUrlFor:()=>''}),{status:400});
    const row=(await admin.query('SELECT status,total_cents FROM commerce.orders WHERE id=$1',[order.orderId])).rows[0];
    assert.deepEqual([row.status,Number(row.total_cents)],['pending',50000]);
    assert.equal((await admin.query('SELECT count(*)::int AS n FROM access.entitlements WHERE user_id=$1',[buyer])).rows[0].n,0);
  });
  await check('only a verified webhook marks an order paid, once, with a balanced ledger and access',async()=>{
    const reference=await referenceOf(order.orderId);
    await assert.rejects(handlePaymentWebhook({provider,payments},JSON.stringify({id:'evt_forged',type:'payment.succeeded',reference,amountCents:50000,feeCents:0}),{'x-test-signature':'0'.repeat(64)}),{status:401});
    assert.equal((await admin.query('SELECT status FROM commerce.orders WHERE id=$1',[order.orderId])).rows[0].status,'pending');
    const done=provider.complete(reference,true);
    assert.deepEqual(await handlePaymentWebhook({provider,payments},done.body,done.headers),{outcome:'paid'});
    assert.deepEqual(await handlePaymentWebhook({provider,payments},done.body,done.headers),{outcome:'duplicate'});
    const ledger=(await admin.query('SELECT account,debit_cents,credit_cents FROM commerce.ledger_entries WHERE order_id=$1 ORDER BY id',[order.orderId])).rows;
    const debits=ledger.reduce((s,l)=>s+Number(l.debit_cents),0),credits=ledger.reduce((s,l)=>s+Number(l.credit_cents),0);
    assert.deepEqual([debits,credits],[50000,50000]);assert.deepEqual(ledger.map(l=>l.account),['buyer_payment','provider_revenue','payment_fees']);
    const granted=(await admin.query('SELECT source,order_id,kind FROM access.entitlements WHERE user_id=$1 AND target_id=$2',[buyer,product.id])).rows;
    assert.deepEqual(granted,[{source:'purchase',order_id:order.orderId,kind:'product'}]);
    const access=new AccessService(new PostgresAccessRepository(db,buyer),new MemoryAccessCache());
    assert.equal((await access.open({hubId,userId:buyer,lessonId:lesson})).decision,'allowed');
    await assert.rejects(start(buyer,plan),{status:409,code:'already_owned'});
    assert.equal((await new CommerceRepository(db,buyer).order(hubId,order.orderId)).status,'paid');
  });
  await check('wrong amounts, tampered prices and declines never grant access',async()=>{
    const reference=await referenceOf((await start(buyer2,plan)).orderId);
    const event=(amountCents,feeCents=0)=>({provider:'test',id:'evt_'+randomUUID(),type:'payment.succeeded',reference,amountCents,feeCents,payloadHash:'a'.repeat(64)});
    assert.equal(await payments.record(event(100)),'review');
    // An order whose price was written below the plan's price is never paid out.
    const cheap=randomUUID(),cheapRef='test_'+randomUUID();
    await db.withSnapshot({hubId,userId:buyer2,orgIds:[],isStaff:false},async tx=>{
      await tx.query("INSERT INTO commerce.orders(hub_id,id,buyer_id,subtotal_cents,total_cents,idempotency_key,request_hash) VALUES($1,$2,$3,100,100,$4,$5)",[hubId,cheap,buyer2,randomUUID(),'b'.repeat(64)]);
      await tx.query('INSERT INTO commerce.order_lines(hub_id,order_id,line,plan_id,product_id,quantity,unit_amount_cents,amount_cents) VALUES($1,$2,1,$3,$4,1,100,100)',[hubId,cheap,plan,product.id]);
      await tx.query("UPDATE commerce.orders SET psp_provider='test',psp_reference=$2 WHERE id=$1",[cheap,cheapRef]);
    });
    assert.equal(await payments.record({...event(100),reference:cheapRef}),'review');
    const declined=await start(buyer2,plan);assert.deepEqual(await pay(await referenceOf(declined.orderId),false),{outcome:'failed'});
    assert.equal(await payments.record({...event(50000),reference:'test_unknown'}),'unknown_reference');
    assert.equal((await admin.query('SELECT count(*)::int AS n FROM access.entitlements WHERE user_id=$1',[buyer2])).rows[0].n,0);
    await assert.rejects(app.query("SELECT app.record_payment_event('test','e','payment.succeeded','r',1,0,$1)",['a'.repeat(64)]),{code:'42501'});
    await assert.rejects(db.withSnapshot({hubId,userId:buyer2,orgIds:[],isStaff:false},tx=>tx.query("UPDATE commerce.orders SET status='paid' WHERE id=$1",[cheap])),{code:'42501'});
    await assert.rejects(db.withSnapshot({hubId,userId:userA,orgIds:[],isStaff:false},tx=>tx.query("INSERT INTO commerce.ledger_entries(hub_id,order_id,account,debit_cents) VALUES($1,$2,'buyer_payment',1)",[hubId,cheap])),{code:'42501'});
    await assert.rejects(admin.query("UPDATE commerce.ledger_entries SET debit_cents=1 WHERE order_id=$1",[order.orderId]),{code:'23514'});
    await assert.rejects(admin.query('DELETE FROM commerce.ledger_entries WHERE order_id=$1',[order.orderId]),{code:'23514'});
    await assert.rejects(paymentsPool.query('SELECT * FROM commerce.orders'),{code:'42501'});
    assert.equal((await db.withSnapshot({hubId,userId:buyer2,orgIds:[],isStaff:false},tx=>tx.query('SELECT id FROM commerce.orders WHERE id=$1',[order.orderId]))).rows.length,0);
    const c=await admin.connect();
    try{await c.query('BEGIN');await c.query('DROP POLICY hub_scope ON commerce.orders');await assert.rejects(auditPolicies(c),/Unsafe tenant policies/);}
    finally{await c.query('ROLLBACK');c.release();}
  });
  await check('HTTP checkout, the test payment page and the webhook complete a purchase end to end',async()=>{
    const auth={authorization:'Bearer learner-a'},key=randomUUID();
    const started=await fetch(base+'/v1/hubs/'+hubId+'/checkout',{method:'POST',headers:{...auth,'idempotency-key':key},body:JSON.stringify({planId:plan,slug})});
    assert.equal(started.status,201);const {orderId,redirectUrl}=await started.json();
    assert.equal((await fetch(base+'/v1/hubs/'+hubId+'/checkout',{method:'POST',headers:auth,body:JSON.stringify({planId:plan,slug})})).status,400);
    const page=await fetch(base+redirectUrl);assert.equal(page.status,200);assert.ok((await page.text()).includes('TEST MODE'));
    const approved=await fetch(base+redirectUrl+'/approve',{method:'POST',redirect:'manual'});
    assert.equal(approved.status,303);assert.equal(approved.headers.get('location'),'/h/'+slug+'/orders/'+orderId);
    assert.equal((await (await fetch(base+'/v1/hubs/'+hubId+'/orders/'+orderId,{headers:auth})).json()).status,'paid');
    const again=await fetch(base+'/v1/hubs/'+hubId+'/checkout',{method:'POST',headers:{...auth,'idempotency-key':randomUUID()},body:JSON.stringify({planId:plan,slug})});
    assert.deepEqual([again.status,(await again.json()).error],[409,'already_owned']);
    assert.equal((await fetch(base+'/v1/webhooks/payments/test',{method:'POST',body:'{}'})).status,401);
    assert.equal((await fetch(base+'/v1/webhooks/payments/paystack',{method:'POST',body:'{}'})).status,404);
    assert.equal((await fetch(base+redirectUrl)).status,404);
    assert.ok((await (await fetch(base+'/h/'+slug+'/products/'+product.id)).text()).includes('/checkout/'+product.id+'/'+plan));
    const host='learn-new.example',exchange=await fetch(base+'/v1/hubs/'+hubId+'/session',{method:'POST',headers:{...auth,host,origin:'https://'+host}});
    const cookie=exchange.headers.get('set-cookie').split(';')[0];
    const sales=await (await fetch(base+'/h/'+slug+'/admin/sales',{headers:{host,cookie}})).text();
    assert.ok(sales.includes('Your revenue'));assert.ok(sales.includes('Paid &lt;b&gt;course&lt;/b&gt;'));
    assert.ok((await (await fetch(base+'/h/'+slug+'/checkout/'+product.id+'/'+plan,{headers:{host,cookie}})).text()).includes('id="start-checkout"'));
  });
}
