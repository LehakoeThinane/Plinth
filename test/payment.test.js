import test from 'node:test';
import assert from 'node:assert/strict';
import { TestPaymentProvider } from '../src/modules/commerce/test-payment-provider.js';
const order={orderId:'00000000-0000-4000-8000-000000000001',hubId:'00000000-0000-4000-8000-000000000002',amountCents:50000,returnUrl:'/h/x/orders/1'};
test('the test provider refuses to run in production',()=>{
  assert.throws(()=>new TestPaymentProvider({environment:'production'}),/production/);
});
test('only events signed by this provider instance verify',()=>{
  const provider=new TestPaymentProvider({environment:'test'}),other=new TestPaymentProvider({environment:'test'});
  const {reference}=provider.createSession(order),done=provider.complete(reference,true);
  const event=provider.verifyWebhook(done.body,done.headers);
  assert.deepEqual([event.type,event.reference,event.amountCents],['payment.succeeded',reference,50000]);
  assert.ok(event.feeCents>0&&event.feeCents<=50000);assert.match(event.payloadHash,/^[0-9a-f]{64}$/);
  assert.equal(other.verifyWebhook(done.body,done.headers),null);
  assert.equal(provider.verifyWebhook(done.body.replace('50000','100'),done.headers),null);
  for(const headers of [{},{'x-test-signature':'nothex'},{'x-test-signature':'0'.repeat(64)}])assert.equal(provider.verifyWebhook(done.body,headers),null);
});
test('a session completes once and expires',()=>{
  let now=Date.now();const provider=new TestPaymentProvider({environment:'test',now:()=>now});
  const first=provider.createSession(order);assert.ok(provider.complete(first.reference,false));assert.equal(provider.complete(first.reference,true),null);
  const second=provider.createSession(order);now+=31*60*1000;assert.equal(provider.session(second.reference),null);assert.equal(provider.complete(second.reference,true),null);
  const declined=provider.createSession(order),event=provider.complete(declined.reference,false);
  assert.equal(provider.verifyWebhook(event.body,event.headers)?.type??'payment.failed','payment.failed');
});
