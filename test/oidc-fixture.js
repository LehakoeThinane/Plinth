import * as oidc from 'openid-client';
import { generateKeyPair,exportJWK,SignJWT } from 'jose';
/** Trusted HTTPS provider endpoints, with an in-process test transport.
 * This exercises the actual OIDC client's validation rather than mocking it.
 */
export async function providerFixture(issuer='https://identity.example') {
  const keys=await generateKeyPair('ES256'),other=await generateKeyPair('ES256');
  const jwk=await exportJWK(keys.publicKey);jwk.kid='oidc-test';
  const configuration=new oidc.Configuration({issuer,authorization_endpoint:issuer+'/authorize',
    token_endpoint:issuer+'/token',jwks_uri:issuer+'/jwks',code_challenge_methods_supported:['S256']},
    'plinth-web',{id_token_signed_response_alg:'ES256'},oidc.None());
  const codes=new Map();let calls=0;
  configuration[oidc.customFetch]=async(url,options)=>{
    if(String(url)===issuer+'/jwks')return Response.json({keys:[jwk]});
    if(String(url)!==issuer+'/token')throw new Error('Unexpected fixture endpoint');
    calls++;
    const params=new URLSearchParams(options.body),record=codes.get(params.get('code'));codes.delete(params.get('code'));
    if(!record||await oidc.calculatePKCECodeChallenge(params.get('code_verifier'))!==record.challenge||
      params.get('redirect_uri')!==record.redirectUri)return Response.json({error:'invalid_grant'},{status:400});
    const now=Math.floor(Date.now()/1000);
    const jwt=await new SignJWT({iss:issuer,aud:'plinth-web',sub:'subject-a',iat:now,exp:now+600,nonce:record.nonce,...record.overrides})
      .setProtectedHeader({alg:'ES256',kid:jwk.kid}).sign(record.forged?other.privateKey:keys.privateKey);
    return Response.json({access_token:'transient-fixture-token',token_type:'Bearer',expires_in:600,id_token:jwt});
  };
  return {configuration,get calls(){return calls;},authorize(location,{overrides={},forged=false,challenge}={}) {
    const u=new URL(location),code='code-'+codes.size+'-'+Math.random();
    codes.set(code,{challenge:challenge??u.searchParams.get('code_challenge'),redirectUri:u.searchParams.get('redirect_uri'),
      nonce:u.searchParams.get('nonce'),overrides,forged});
    const callback=new URL(u.searchParams.get('redirect_uri'));callback.searchParams.set('code',code);callback.searchParams.set('state',u.searchParams.get('state'));
    return callback;
  }};
}
