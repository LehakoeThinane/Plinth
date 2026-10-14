import { createHmac,createHash,randomBytes,randomUUID,timingSafeEqual } from 'node:crypto';
/** Stand-in payment provider for building and testing without real credentials.
 * It behaves like a hosted checkout: a payment page, then a signed webhook.
 * The signing secret is generated per process and never stored. It refuses to
 * run in production; a real adapter (e.g. Paystack) implements the same methods:
 *   name, createSession(order) -> {reference, redirectUrl}, redirectUrl(reference),
 *   verifyWebhook(rawBody, headers) -> event | null
 */
export class TestPaymentProvider {
  name='test';
  #secret;#sessions=new Map();#now;
  constructor({environment=process.env.NODE_ENV,now=()=>Date.now()}={}) {
    if(environment==='production')throw new Error('The test payment provider cannot run in production');
    this.#secret=randomBytes(32);this.#now=now;
  }
  createSession({orderId,hubId,amountCents,returnUrl,description}) {
    const reference='test_'+randomUUID();
    this.#sessions.set(reference,{reference,orderId,hubId,amountCents,returnUrl,description,expiresAt:this.#now()+30*60*1000});
    return {reference,redirectUrl:this.redirectUrl(reference)};
  }
  redirectUrl(reference) {return '/test-payments/'+encodeURIComponent(reference);}
  session(reference) {
    const session=this.#sessions.get(reference);
    return session&&session.expiresAt>this.#now()?session:null;
  }
  /** What the hosted page does when the payer approves or declines: produce the
   * provider's signed event. The application verifies it like any webhook.
   */
  complete(reference,approved) {
    const session=this.session(reference);
    if(!session)return null;
    this.#sessions.delete(reference);
    // A pretend card fee (2.9% + R1), so the ledger records a fee line.
    const feeCents=Math.min(session.amountCents,Math.round(session.amountCents*0.029)+100);
    const body=JSON.stringify({id:'evt_'+randomUUID(),type:approved?'payment.succeeded':'payment.failed',
      reference,amountCents:session.amountCents,feeCents});
    return {body,headers:{'x-test-signature':this.#sign(body)},returnUrl:session.returnUrl};
  }
  /** A provider refund. Real providers confirm later by webhook; the stand-in
   * returns the signed confirmation at once so the same path applies it.
   */
  refund({reference,amountCents}) {
    const body=JSON.stringify({id:'evt_'+randomUUID(),type:'payment.refunded',reference,amountCents,feeCents:0});
    return {body,headers:{'x-test-signature':this.#sign(body)}};
  }
  #sign(body){return createHmac('sha256',this.#secret).update(body).digest('hex');}
  verifyWebhook(rawBody,headers) {
    const signature=headers['x-test-signature'];
    if(typeof signature!=='string'||!/^[0-9a-f]{64}$/.test(signature))return null;
    const expected=Buffer.from(this.#sign(rawBody),'hex');
    if(!timingSafeEqual(Buffer.from(signature,'hex'),expected))return null;
    let event;
    try{event=JSON.parse(rawBody);}catch{return null;}
    if(typeof event.id!=='string'||typeof event.type!=='string'||typeof event.reference!=='string'||
      !Number.isSafeInteger(event.amountCents)||!Number.isSafeInteger(event.feeCents))return null;
    return {provider:this.name,id:event.id,type:event.type,reference:event.reference,amountCents:event.amountCents,
      feeCents:event.feeCents,payloadHash:createHash('sha256').update(rawBody).digest('hex')};
  }
}
