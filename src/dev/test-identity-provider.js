import * as oidc from 'openid-client';
import { generateKeyPair,exportJWK,SignJWT } from 'jose';
import { randomBytes,randomUUID } from 'node:crypto';
import { escapeText as e,head } from '../http/ui.js';
/** Local stand-in for Auth0, for clicking through the app before a real tenant
 * exists. It serves a TEST SIGN-IN page and issues signed ID tokens through the
 * same OIDC code + S256 PKCE flow the application uses with a real provider.
 * Keys are generated per process. It refuses to run in production.
 */
export class TestIdentityProvider {
  #issuer;#endpoint;#clientId;#redirectUri;#people;#keys;#jwk;#codes=new Map();
  /** endpoint is where browsers reach /authorize; it defaults to the issuer and
   * differs only when the local run uses another port with the same accounts. */
  static async create({issuer,endpoint=issuer,clientId,redirectUri,people,environment=process.env.NODE_ENV}) {
    if(environment==='production')throw new Error('The test identity provider cannot run in production');
    const provider=new TestIdentityProvider();
    provider.#issuer=issuer;provider.#endpoint=endpoint;provider.#clientId=clientId;provider.#redirectUri=redirectUri;provider.#people=people;
    provider.#keys=await generateKeyPair('ES256');provider.#jwk={...await exportJWK(provider.#keys.publicKey),kid:'local-test',alg:'ES256',use:'sig'};
    return provider;
  }
  get issuer(){return this.#issuer;}
  /** Client configuration for HostedSignIn. Token and key requests are answered
   * in-process, so no TLS trust for the local certificate is needed server-side.
   */
  configuration() {
    const configuration=new oidc.Configuration({issuer:this.#issuer,authorization_endpoint:this.#endpoint+'/authorize',
      token_endpoint:this.#endpoint+'/token',jwks_uri:this.#endpoint+'/jwks',code_challenge_methods_supported:['S256']},
      this.#clientId,{id_token_signed_response_alg:'ES256'},oidc.None());
    configuration[oidc.customFetch]=async(url,options)=>{
      if(String(url)===this.#endpoint+'/jwks')return Response.json({keys:[this.#jwk]});
      if(String(url)===this.#endpoint+'/token')return this.#token(new URLSearchParams(options.body));
      throw new Error('Unexpected test identity endpoint');
    };
    return configuration;
  }
  async #token(params) {
    const record=this.#codes.get(params.get('code'));this.#codes.delete(params.get('code'));
    if(!record||record.expiresAt<Date.now()||params.get('redirect_uri')!==record.redirectUri||
      await oidc.calculatePKCECodeChallenge(params.get('code_verifier')??'')!==record.challenge)return Response.json({error:'invalid_grant'},{status:400});
    const now=Math.floor(Date.now()/1000);
    const idToken=await new SignJWT({nonce:record.nonce,name:record.name}).setProtectedHeader({alg:'ES256',kid:'local-test'})
      .setIssuer(this.#issuer).setAudience(this.#clientId).setSubject(record.subject).setIssuedAt(now).setExpirationTime(now+3600).sign(this.#keys.privateKey);
    return Response.json({access_token:randomBytes(16).toString('hex'),token_type:'Bearer',expires_in:3600,id_token:idToken});
  }
  /** Serves /authorize: GET shows the sign-in page, POST issues a one-use code. */
  async handle(req,res,url) {
    if(url.pathname!==new URL(this.#endpoint).pathname+'/authorize'){res.writeHead(404);return res.end();}
    const params=req.method==='POST'?new URLSearchParams(await new Promise((resolve,reject)=>{let b='';req.setEncoding('utf8');
      req.on('data',c=>{b+=c;if(b.length>8192)reject(new Error('Too large'));});req.on('end',()=>resolve(b));req.on('error',reject);})):url.searchParams;
    if(params.get('client_id')!==this.#clientId||params.get('redirect_uri')!==this.#redirectUri||params.get('code_challenge_method')!=='S256'||
      !params.get('code_challenge')||!params.get('state')){res.writeHead(400,{'content-type':'text/plain'});return res.end('Invalid sign-in request');}
    if(req.method==='GET'){res.writeHead(200,{'content-type':'text/html; charset=utf-8','cache-control':'no-store'});return res.end(this.#page(params));}
    const person=this.#people.find(p=>p.subject===params.get('subject'))??(params.get('subject')==='new'?{subject:'visitor-'+randomUUID().slice(0,8),name:'New visitor'}:null);
    if(!person){res.writeHead(400,{'content-type':'text/plain'});return res.end('Choose a person');}
    const code=randomBytes(24).toString('hex');
    this.#codes.set(code,{subject:person.subject,name:person.name,nonce:params.get('nonce'),challenge:params.get('code_challenge'),
      redirectUri:this.#redirectUri,expiresAt:Date.now()+60000});
    const target=new URL(this.#redirectUri);target.searchParams.set('code',code);target.searchParams.set('state',params.get('state'));
    res.writeHead(303,{location:target.href,'cache-control':'no-store'});res.end();
  }
  #page(params) {
    const hidden=['client_id','redirect_uri','state','nonce','code_challenge','code_challenge_method','scope','response_type']
      .map(k=>`<input type="hidden" name="${k}" value="${e(params.get(k)??'')}">`).join('');
    const choices=[...this.#people,{subject:'new',name:'A brand-new visitor',role:'Creates a fresh account with nothing yet'}]
      .map(p=>`<form method="post" action="${e(new URL(this.#endpoint).pathname)}/authorize">${hidden}<input type="hidden" name="subject" value="${e(p.subject)}">
        <button><strong>${e(p.name)}</strong><span>${e(p.role??'')}</span></button></form>`).join('');
    return `${head({title:'Test sign-in'})}<body><div class="testmode"><div class="wrap">TEST SIGN-IN (local only). This page stands in for Auth0.</div></div>
<main id="main" class="standin"><p class="eyebrow">Choose a demo person</p><h1>Sign in as…</h1>
<p class="muted">Each person sees the hub differently. Real sign-in replaces this page when Auth0 is set up.</p><div class="people">${choices}</div></main></body></html>`;
  }
}
