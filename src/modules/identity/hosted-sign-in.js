import * as oidc from 'openid-client';
import { randomBytes,createHash,timingSafeEqual } from 'node:crypto';
const cookieName='__Host-plinth-login';
const digest=value=>createHash('sha256').update(value).digest('hex');
const cookieAttributes='; Path=/; Secure; HttpOnly; SameSite=Lax';
const reject=()=>Object.assign(new Error('Sign-in rejected'),{status:401});
const views=new Set(['join','member','admin','create-hub','organisations','account']);
export const clearLoginCookie=cookieName+'='+cookieAttributes+'; Max-Age=0';
// Sign-in-method changes need a session established within this window.
export const recentSignInMs=10*60*1000;
export const isRecentSignIn=(principal,now=Date.now())=>now-new Date(principal?.createdAt).getTime()<=recentSignInMs;
/** Configuration is built from administratively trusted provider metadata.
 * Tokens are transient: only a verified issuer/subject reaches account resolution.
 */
export class HostedSignIn {
  #config;#store;#sessions;#resolveUser;#linkIdentity;#now;
  constructor({configuration,store,sessions,resolveUser,linkIdentity,now=()=>Date.now()}) {
    const metadata=configuration.serverMetadata();
    if(!['RS256','PS256','ES256','EdDSA'].includes(configuration.clientMetadata().id_token_signed_response_alg??'RS256'))
      throw new Error('Asymmetric OIDC signature algorithm required');
    for(const key of ['issuer','authorization_endpoint','token_endpoint','jwks_uri']) {
      const url=new URL(metadata[key]);
      if(url.protocol!=='https:'||url.username||url.password)throw new Error('Trusted HTTPS OIDC metadata required');
    }
    if(!metadata.code_challenge_methods_supported?.includes('S256'))throw new Error('OIDC provider must support S256 PKCE');
    oidc.enableNonRepudiationChecks(configuration);
    this.#config=configuration;this.#store=store;this.#sessions=sessions;this.#resolveUser=resolveUser;this.#linkIdentity=linkIdentity;this.#now=now;
  }
  async begin(req,hub,view='member') {
    if(!views.has(view))throw Object.assign(new Error('Invalid sign-in destination'),{status:400});
    return this.#start(req,hub,view);
  }
  /** Adds a sign-in method to the signed-in account. The provider is asked to
   * authenticate again, and the callback must return to this same session.
   */
  async beginLink(req,hub,principal) {
    if(!this.#linkIdentity)throw Object.assign(new Error('Not found'),{status:404});
    if(!principal?.sessionHash||principal.hubId!==hub.id)throw reject();
    if(!isRecentSignIn(principal,this.#now()))throw Object.assign(new Error('Recent sign-in required'),{status:403,reauthenticate:true});
    return this.#start(req,hub,'account',{userId:principal.userId,sessionHash:principal.sessionHash},{prompt:'login'});
  }
  async #start(req,hub,view,link,parameters={}) {
    const origin=await this.#sessions.trustedOrigin(req,hub.id);
    const state=randomBytes(32).toString('hex'),nonce=oidc.randomNonce(),verifier=oidc.randomPKCECodeVerifier();
    const redirectUri=origin+'/auth/callback',returnPath='/h/'+hub.slug+'/'+view;
    const url=oidc.buildAuthorizationUrl(this.#config,{...parameters,scope:'openid',redirect_uri:redirectUri,
      response_mode:'query',state,nonce,code_challenge:await oidc.calculatePKCECodeChallenge(verifier),code_challenge_method:'S256'});
    await this.#store.storeLogin(digest(state),{hubId:hub.id,origin,payload:{nonce,verifier,redirectUri,returnPath,...(link?{link}:{})},expiresAt:new Date(this.#now()+600000)});
    return {location:url.href,cookies:[cookieName+'='+state+cookieAttributes+'; Max-Age=600']};
  }
  async complete(req,url) {
    const states=url.searchParams.getAll('state');
    const cookies=(req.headers.cookie??'').split(';').map(v=>v.trim()).filter(v=>v.startsWith(cookieName+'='));
    const state=states[0],bound=cookies[0]?.slice(cookieName.length+1);
    if(states.length!==1||cookies.length!==1||!/^[0-9a-f]{64}$/.test(state??'')||
      !/^[0-9a-f]{64}$/.test(bound??'')||!timingSafeEqual(Buffer.from(state),Buffer.from(bound)))throw reject();
    // Host is only a lookup key; it must subsequently match the trusted hub origin.
    const host=req.headers.host;
    if(typeof host!=='string'||!host||/[\s/@?#\\]/.test(host))throw reject();
    const origin=new URL('https://'+host).origin;
    const attempt=await this.#store.consumeLogin(digest(state),origin);
    if(!attempt||await this.#sessions.trustedOrigin(req,attempt.hubId)!==attempt.origin)throw reject();
    const p=attempt.payload;
    if(p.redirectUri!==origin+'/auth/callback'||!/^\/h\/[a-z0-9-]+\/(join|member|admin|create-hub|organisations|account)$/.test(p.returnPath))throw reject();
    // A link callback must return to the exact session that started it.
    const linking=p.link?await this.#sessions.principal(req):null;
    if(p.link&&(!this.#linkIdentity||!linking||linking.sessionHash!==p.link.sessionHash||
      linking.userId!==p.link.userId||linking.hubId!==attempt.hubId))throw reject();
    let claims;
    try {
      const tokens=await oidc.authorizationCodeGrant(this.#config,new URL('/auth/callback'+url.search,origin),
        {pkceCodeVerifier:p.verifier,expectedState:state,expectedNonce:p.nonce,idTokenExpected:true});
      claims=tokens.claims();
    } catch {throw reject();}
    if(!claims||typeof claims.sub!=='string'||!claims.sub||claims.sub.length>512||
      !Number.isFinite(claims.exp)||claims.exp*1000<=this.#now())throw reject();
    if(linking) {
      // Never provision an account here; the identity joins the session's account or is refused.
      const outcome=await this.#linkIdentity(linking.sessionHash,claims.iss,claims.sub);
      if(!outcome)throw reject();
      return {location:p.returnPath+'?link='+outcome,cookies:[clearLoginCookie]};
    }
    const userId=await this.#resolveUser(claims.iss,claims.sub);
    if(!userId)throw reject();
    const session=await this.#sessions.establishFromCallback(req,attempt.hubId,{userId,expiresAt:new Date(claims.exp*1000)});
    return {location:p.returnPath,cookies:[clearLoginCookie,session.cookie]};
  }
}
