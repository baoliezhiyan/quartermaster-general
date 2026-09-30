import {readFile,readdir} from 'node:fs/promises';
import {join,extname} from 'node:path';
import {createHash} from 'node:crypto';
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const mime={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.png':'image/png','.svg':'image/svg+xml','.json':'application/json','.ico':'image/x-icon','.woff2':'font/woff2'};
/** Immutable inventory for this process/build. No filesystem reads on subsequent asset requests. */
export async function loadStaticAssets(root){
 const files=new Map();
 async function scan(dir,prefix=''){for(const entry of await readdir(dir,{withFileTypes:true})){if(entry.isSymbolicLink())continue;const name=prefix+entry.name;if(entry.isDirectory())await scan(join(dir,entry.name),name+'/');else {const content=await readFile(join(dir,entry.name));files.set('/'+name,{content,hash:hash(content)});}}}
 await scan(root);
 const fingerprint=hash(JSON.stringify([...files].map(([name,f])=>[name,f.hash]).sort((a,b)=>a[0].localeCompare(b[0],'en'))));
 return {fingerprint,serve(req,res,url,client){
  if(!['GET','HEAD'].includes(req.method)){res.writeHead(405).end();return;}
  const path=decodeURIComponent(url.pathname),name=path==='/'?'/index.html':path,file=files.get(name);
  if(!file){res.writeHead(404).end('文件不存在。');return;}
  let content=file.content;
  if(extname(name)==='.html'){
   res.setHeader('Cache-Control','no-store');
   if(client)content=Buffer.from(content.toString('utf8').replace('<head>','<head><script>window.qmClient='+JSON.stringify(client).replaceAll('<','\\u003c')+';</script>'));
  }else{
   const versioned=url.searchParams.get('v')===file.hash||/^\/assets\/[^/]+-[\w-]{8,}\.(js|css)$/.test(name);
   res.setHeader('Cache-Control',versioned?'public, max-age=31536000, immutable':'no-cache');
   res.setHeader('ETag',`"${file.hash}"`);
   if(req.headers['if-none-match']?.split(',').some(tag=>tag.trim().replace(/^W\//,'')===`"${file.hash}"`||tag.trim()==='*')){res.writeHead(304).end();return;}
  }
  res.writeHead(200,{'Content-Type':mime[extname(name)]||'application/octet-stream','Content-Length':content.length}).end(req.method==='HEAD'?undefined:content);
 }};
}
