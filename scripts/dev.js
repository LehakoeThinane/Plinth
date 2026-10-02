import { createServer } from 'node:http';
import { modules } from '../src/modules/index.js';
// Phase 0 liveness shell, not an authenticated product API. No tokens are issued.
const host='127.0.0.1'; const port=Number(process.env.PORT??3000);
if(process.env.NODE_ENV==='production')throw Error('Use a configured production composition root');
const server=createServer((req,res)=>{
  if(req.method==='GET' && req.url==='/health') {
    res.writeHead(200,{'content-type':'application/json','cache-control':'no-store'});
    res.end(JSON.stringify({status:'alive',environment:'local',modules:Object.keys(modules),databaseReady:false}));
  } else {res.writeHead(404,{'content-type':'application/json'});res.end(JSON.stringify({error:'not_found'}));}
});
server.listen(port,host,()=>console.log('Local foundation: http://'+host+':'+port+'/health'));
for(const signal of ['SIGINT','SIGTERM'])process.on(signal,()=>server.close());
