import { createServer } from 'node:https';
import { existsSync } from 'node:fs';
import { mkdir,readFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import pg from 'pg';
import { generateKeyPair,exportJWK,createLocalJWKSet } from 'jose';
import { createManagedApplication } from '../src/app.js';
import { LocalBrandingStore } from '../src/storage/local-branding.js';
import { TestPaymentProvider } from '../src/modules/commerce/test-payment-provider.js';
import { TestIdentityProvider } from '../src/dev/test-identity-provider.js';
import { seedDemo,demoPeople,demoSlug } from '../src/dev/demo-seed.js';
import { head } from '../src/http/ui.js';
// Local click-through run with stand-ins: TEST SIGN-IN, TEST MODE payments and
// demo data. Never for production; every stand-in refuses NODE_ENV=production.
if(process.env.NODE_ENV==='production')throw new Error('npm run local is for local development only');
const port=Number(process.env.PORT??8443),origin='https://localhost:'+port;
const base=process.env.DATABASE_URL;
if(!base||!process.env.TEST_ADMIN_DATABASE_URL){console.error('DATABASE_URL and TEST_ADMIN_DATABASE_URL are required (see .env.example). Start Docker and run docker compose up -d first.');process.exit(2);}
const loginFor=user=>{const url=new URL(base);url.username=user;return url.href;};
const pool=url=>new pg.Pool({connectionString:url,max:5,connectionTimeoutMillis:10000});
const app=pool(base),admin=pool(process.env.TEST_ADMIN_DATABASE_URL),auth=pool(process.env.TEST_AUTH_DATABASE_URL??loginFor('plinth_auth'));
const domains=pool(loginFor('plinth_domain_verifier')),payments=pool(loginFor('plinth_payments'));

// A self-signed certificate for localhost: session cookies are Secure/__Host-
// and only HTTPS origins are trusted, exactly as in production.
const certs=resolve('.local/certs'),key=resolve(certs,'localhost-key.pem'),cert=resolve(certs,'localhost-cert.pem');
if(!existsSync(key)||!existsSync(cert)) {
  await mkdir(certs,{recursive:true});
  const openssl=['openssl',process.env.ProgramFiles+'\\Git\\usr\\bin\\openssl.exe'].find(cmd=>{try{execFileSync(cmd,['version'],{stdio:'ignore'});return true;}catch{return false;}});
  if(!openssl){console.error('OpenSSL is needed once to create a local certificate (it ships with Git for Windows).');process.exit(2);}
  execFileSync(openssl,['req','-x509','-newkey','ec','-pkeyopt','ec_paramgen_curve:prime256v1','-nodes','-days','30','-subj','/CN=localhost',
    '-addext','subjectAltName=DNS:localhost','-keyout',key,'-out',cert],{stdio:'ignore'});
}

// A fixed issuer keeps the demo people's accounts the same whichever PORT is used.
const issuer='https://localhost:8443/test-auth';
const identity=await TestIdentityProvider.create({issuer,endpoint:origin+'/test-auth',clientId:'plinth-local',redirectUri:origin+'/auth/callback',people:demoPeople});
const seeded=await seedDemo({admin,app,issuer});
// Bearer API tokens are not used in the browser run; a local key set satisfies configuration.
const apiKeys=await generateKeyPair('ES256'),apiJwk={...await exportJWK(apiKeys.publicKey),kid:'local-api'};
const application=createManagedApplication({pool:app,authPool:auth,
  auth:{issuer,audience:'plinth-local-api',algorithms:['ES256'],keySet:createLocalJWKSet({keys:[apiJwk]})},
  oidcConfiguration:identity.configuration(),originForHub:async()=>origin,
  brandingStore:new LocalBrandingStore({root:'.local/branding'}),domainVerificationPool:domains,
  paymentProvider:new TestPaymentProvider(),paymentsPool:payments,onError:error=>console.error(error)});
const handle=application.listeners('request')[0];
const landing=`${head({title:'Plinth local'})}<body><div class="testmode"><div class="wrap">LOCAL TEST RUN: stand-in sign-in and payments, demo data, no real money.</div></div>
<main id="main" class="standin"><p class="eyebrow">Plinth</p><h1>Local click-through</h1>
<section class="panel"><ul class="rows"><li><h3><a href="/h/${demoSlug}">Zoya Speaks storefront</a></h3><p class="muted">What a visitor sees, signed out.</p></li>
<li><h3><a href="/h/${demoSlug}/admin">Provider admin</a></h3><p class="muted">Sign in as Zoya: products, library, tiers, community and sales.</p></li>
<li><h3><a href="/h/${demoSlug}/learning">My learning</a></h3><p class="muted">Sign in as Thabo: a learner part-way through a free course.</p></li>
<li><h3><a href="/h/${demoSlug}/community">Community</a></h3><p class="muted">Sign in as Lerato to see the private Absa space.</p></li></ul></section>
<p class="muted">Demo people: ${demoPeople.map(p=>p.name).join(', ')}, or a brand-new visitor. Purchases use the TEST MODE payment page.</p></main></body></html>`;
createServer({key:await readFile(key),cert:await readFile(cert)},(req,res)=>{
  const url=new URL(req.url,origin);
  if(url.pathname.startsWith('/test-auth/'))return identity.handle(req,res,url).catch(error=>{console.error(error);res.writeHead(500);res.end();});
  if(url.pathname==='/'){res.writeHead(200,{'content-type':'text/html; charset=utf-8'});return res.end(landing);}
  return handle(req,res);
}).on('error',error=>{
  if(error.code!=='EADDRINUSE')throw error;
  console.error('Port '+port+' is already in use, probably by another npm run local. Stop it (Ctrl+C in its window) or set PORT to another number.');
  process.exit(2);
}).listen(port,'127.0.0.1',()=>{
  console.log('Plinth local run: '+origin+'/  ('+(seeded.created?'demo data created':'demo data already present')+')');
  console.log('Your browser will warn about the local certificate once; continue to localhost.');
});
for(const signal of ['SIGINT','SIGTERM'])process.on(signal,async()=>{await Promise.all([app,admin,auth,domains,payments].map(p=>p.end()));process.exit(0);});
