import { createRemoteJWKSet,jwtVerify,errors } from 'jose';
/** Adapter for managed providers issuing JWT access tokens for this API audience.
 * Configure endpoints explicitly. Never fetch a URL selected by token contents.
 */
export function createManagedAuthenticator({issuer,audience,jwksUrl,resolveUser,keySet,algorithms=['RS256'],tokenType='at+jwt',claimChecks=()=>true}) {
  const secureUrl=value=>{const url=new URL(value);if(url.protocol!=='https:'||url.username||url.password||url.hash)throw new Error('HTTPS auth configuration required');return url;};
  secureUrl(issuer);
  if(typeof audience!=='string'||!audience||typeof resolveUser!=='function'||typeof claimChecks!=='function'||typeof tokenType!=='string'||!tokenType||
    !Array.isArray(algorithms)||!algorithms.length||algorithms.some(a=>!['RS256','PS256','ES256','EdDSA'].includes(a)))throw new Error('Invalid managed auth configuration');
  const keys=keySet??createRemoteJWKSet(secureUrl(jwksUrl));
  return async token=>{
    if(typeof token!=='string'||token.length>16384)return null;
    let payload;
    try {
      ({payload}=await jwtVerify(token,keys,{issuer,audience,algorithms,typ:tokenType,
        requiredClaims:['sub','iat','exp'],maxTokenAge:'1 hour',clockTolerance:0}));
      if(typeof payload.sub!=='string'||!payload.sub||payload.sub.length>255||claimChecks(payload)!==true)return null;
    }catch(error) {
      if(error instanceof errors.JOSEError && error.code!=='ERR_JWKS_TIMEOUT')return null;
      throw error;
    }
    const userId=await resolveUser(payload.iss,payload.sub);
    return userId?{userId,expiresAt:new Date(payload.exp*1000)}:null;
  };
}
