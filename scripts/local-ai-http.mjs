import {appendFile,mkdir} from 'node:fs/promises';
import {join} from 'node:path';
/** Optional loopback-only transport. No route exists unless explicitly enabled. */
export function localAiHttp(adapter,logDir){
 const displayed=new Map();
 return async(req,res,url)=>{
  if(!url.pathname.startsWith('/api/local-ai/'))return false;
  const peer=req.socket.remoteAddress;
  if(!['127.0.0.1','::1','::ffff:127.0.0.1'].includes(peer)||req.headers['cf-connecting-ip']||req.headers['x-forwarded-for']||req.headers.origin){res.writeHead(403).end();return true;}
  let token='',body={},operation=url.pathname.split('/').at(-1),result,code='OK';const start=performance.now();
  try{
   if(req.method!=='POST'||!req.headers['content-type']?.startsWith('application/json'))throw Object.assign(Error('需要 POST JSON'),{code:'INVALID_REQUEST'});
   token=(req.headers.authorization??'').replace(/^Bearer /,'');if(!token||token.length>200)throw Object.assign(Error('需要玩家身份'),{code:'AUTH'});
   let text='';for await(const chunk of req){text+=chunk;if(Buffer.byteLength(text)>65536)throw Object.assign(Error('请求过大'),{code:'INVALID_REQUEST'});}body=JSON.parse(text||'{}');
   if(operation==='reference')result=await adapter.reference(token,body.referenceId);
   else if(operation==='connect')result=await adapter.connect(token);
   else if(operation==='disconnect')result=await adapter.disconnect(token);
   else if(operation==='status'||operation==='observe')result=await adapter.observe(token);
   else if(operation==='wait')result=await adapter.wait(token,body.after,body.timeout??30000);
   else if(operation==='submit')result=await adapter.submit(token,body);
   else throw Object.assign(Error('未知 AI 操作'),{code:'INVALID_REQUEST'});
  }catch(e){code=e.code??'REJECTED';result={code,message:e.message};}
  const observation=result?.observation??(result?.interfaceVersion?result:null);
  if(observation){const signature=JSON.stringify([observation.bindings,observation.status,observation.phase]);if(displayed.get(observation.userId)!==signature){displayed.set(observation.userId,signature);console.log('本机 AI：'+observation.name+'；绑定 '+observation.bindings.join('、')+'；'+observation.status+(observation.phase?'；'+observation.phase:''));}}
  // A durable audit failure is visible and must never invite blindly retrying an action.
  try{await mkdir(logDir,{recursive:true});let record=JSON.stringify({at:new Date().toISOString(),operation,ms:performance.now()-start,code,request:operation==='submit'?body:undefined,result});if(token)record=record.replaceAll(token,'[REDACTED]');await appendFile(join(logDir,'interface.jsonl'),record+'\n','utf8');}
  catch{code='AUDIT_FAILED';result={code,message:'本地审计写入失败；操作可能已执行，请观察局面，不要更换请求编号重试'};}
  res.writeHead(code==='OK'?200:400,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'}).end(JSON.stringify({ok:code==='OK',result}));return true;
 };
}
