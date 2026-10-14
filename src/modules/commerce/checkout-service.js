/** Flow A. Checkout creates a pending order and a payment session; access is
 * granted only when a verified provider webhook reports payment.
 */
export class CheckoutService {
  #orders;#provider;
  constructor({orders,provider}) {this.#orders=orders;this.#provider=provider;}
  async checkout(hubId,{planId,idempotencyKey,returnUrlFor}) {
    const order=await this.#orders.createOrder(hubId,{planId,idempotencyKey});
    // A retried checkout returns the same order and payment page.
    if(order.psp_reference)return {orderId:order.id,status:order.status,redirectUrl:this.#provider.redirectUrl(order.psp_reference)};
    if(order.status!=='pending')return {orderId:order.id,status:order.status,redirectUrl:null};
    const session=await this.#provider.createSession({orderId:order.id,hubId,amountCents:Number(order.total_cents),
      returnUrl:returnUrlFor(order.id),description:order.description});
    await this.#orders.attachReference(hubId,order.id,this.#provider.name,session.reference);
    return {orderId:order.id,status:'pending',redirectUrl:session.redirectUrl};
  }
}
/** Verifies a provider webhook and applies it once, in one database transaction. */
export async function handlePaymentWebhook({provider,payments},rawBody,headers) {
  const event=provider.verifyWebhook(rawBody,headers);
  if(!event)throw Object.assign(new Error('Invalid signature'),{status:401});
  return {outcome:await payments.record(event)};
}
