/** Flow A. Checkout creates a pending order and a payment session; access is
 * granted only when a verified provider webhook reports payment.
 */
export class CheckoutService {
  #orders;#provider;#payments;
  constructor({orders,provider,payments}) {this.#orders=orders;this.#provider=provider;this.#payments=payments;}
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
  /** Starts a subscription; the provider keeps a card authorisation for renewals. */
  async subscribe(hubId,{tierId,planId,idempotencyKey,returnUrlFor}) {
    const order=await this.#orders.createSubscription(hubId,{tierId,planId,idempotencyKey});
    // A retried request returns the same order, subscription and payment page.
    if(order.psp_reference)return {orderId:order.id,subscriptionId:order.subscription_id,status:order.status,redirectUrl:this.#provider.redirectUrl(order.psp_reference)};
    if(order.status!=='pending')return {orderId:order.id,subscriptionId:order.subscription_id,status:order.status,redirectUrl:null};
    const session=await this.#provider.createSession({orderId:order.id,hubId,amountCents:Number(order.total_cents),
      returnUrl:returnUrlFor(order.id),description:order.description,recurring:true});
    await this.#orders.attachReference(hubId,order.id,this.#provider.name,session.reference);
    return {orderId:order.id,subscriptionId:order.subscription_id,status:'pending',redirectUrl:session.redirectUrl};
  }
  async cancel(hubId,subscriptionId) {
    const subscription=await this.#orders.cancelSubscription(hubId,subscriptionId);
    if(subscription.psp_provider===this.#provider.name)await this.#provider.cancelSubscription(subscription.psp_reference);
    return {cancelled:true,accessUntil:subscription.current_period_end};
  }
  /** Asks the provider to refund a paid order in full. The order, ledger and
   * access change only when the provider's signed confirmation is applied.
   */
  async refund(hubId,orderId) {
    const order=await this.#orders.refundable(hubId,orderId);
    if(order.psp_provider!==this.#provider.name)throw Object.assign(new Error('Different provider'),{status:409,code:'not_refundable'});
    const confirmation=await this.#provider.refund({reference:order.psp_reference,amountCents:Number(order.total_cents)});
    if(!confirmation)return {outcome:'requested'};
    return handlePaymentWebhook({provider:this.#provider,payments:this.#payments},confirmation.body,confirmation.headers);
  }
}
/** Verifies a provider webhook and applies it once, in one database transaction. */
export async function handlePaymentWebhook({provider,payments},rawBody,headers) {
  const event=provider.verifyWebhook(rawBody,headers);
  if(!event)throw Object.assign(new Error('Invalid signature'),{status:401});
  return {outcome:await payments.record(event)};
}
