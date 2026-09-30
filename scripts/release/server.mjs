import http from 'node:http';
import { readFile, readdir } from 'node:fs/promises';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';

const MIME={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.json':'application/json; charset=utf-8','.png':'image/png','.svg':'image/svg+xml','.ico':'image/x-icon','.woff2':'font/woff2'};
export async function createLocalServer(root) {
  const meta=JSON.parse(await readFile(join(root,'release.json'),'utf8'));
  const assets=new Map();
  async function collect(folder,prefix='') {
    for(const item of await readdir(folder,{withFileTypes:true})) {
      if(item.isSymbolicLink())throw new Error('Symbolic links are not supported in release assets.');
      const path=join(folder,item.name),url=`${prefix}/${item.name}`;
      if(item.isDirectory())await collect(path,url);
      else if(item.isFile())assets.set(url,path);
    }
  }
  await collect(join(root,'dist'));
  if(!assets.has('/index.html'))throw new Error('Missing dist/index.html. Extract the entire ZIP before starting.');
  return http.createServer(async(req,res)=>{
    try {
      const address=res.socket.localAddress;
      if(address!=='127.0.0.1') {res.writeHead(403).end();return;}
      const port=res.socket.localPort;
      if(![`127.0.0.1:${port}`,`localhost:${port}`].includes(req.headers.host)) {res.writeHead(403).end();return;}
      if(!['GET','HEAD'].includes(req.method)) {res.writeHead(405,{Allow:'GET, HEAD'}).end();return;}
      const url=new URL(req.url,'http://127.0.0.1');
      let path;
      try {path=decodeURIComponent(url.pathname);}catch {res.writeHead(400).end();return;}
      if(path.includes('\\')||path.includes('\0')||path.split('/').includes('..')) {res.writeHead(400).end();return;}
      const headers={'Cache-Control':'no-store','X-Content-Type-Options':'nosniff'};
      if(path==='/__quartermaster__/status') {
        res.writeHead(200,{...headers,'Content-Type':MIME['.json']});res.end(req.method==='HEAD'?undefined:JSON.stringify(meta));return;
      }
      if(path==='/')path='/index.html';
      const file=assets.get(path);
      if(!file){res.writeHead(404,headers).end('Not found');return;}
      const data=await readFile(file),ext=path.slice(path.lastIndexOf('.'));
      res.writeHead(200,{...headers,'Content-Type':MIME[ext]??'application/octet-stream','Content-Length':data.length});
      res.end(req.method==='HEAD'?undefined:data);
    }catch {if(!res.headersSent)res.writeHead(500);res.end('Unable to read release assets.');}
  });
}
function openBrowser(url) {
  const child=spawn('rundll32.exe',['url.dll,FileProtocolHandler',url],{windowsHide:true,stdio:'ignore',detached:true});
  child.on('error',()=>console.log(`Please open ${url} in your browser.`));child.unref();
}
async function main() {
  const root=dirname(fileURLToPath(import.meta.url));
  const args=process.argv.slice(2),unknown=args.filter(a=>a!=='--no-open'&&!/^--port=\d+$/.test(a));
  if(unknown.length)throw new Error(`Unknown argument: ${unknown[0]}`);
  const port=Number(args.find(a=>a.startsWith('--port='))?.slice(7)??4173);
  if(!Number.isInteger(port)||port<1024||port>65535)throw new Error('Invalid port.');
  const url=`http://127.0.0.1:${port}/`,meta=JSON.parse(await readFile(join(root,'release.json'),'utf8'));
  const server=await createLocalServer(root);
  try {
    await new Promise((ok,fail)=>{server.once('error',fail);server.listen(port,'127.0.0.1',ok);});
  }catch(error) {
    if(error.code!=='EADDRINUSE')throw error;
    let running;
    try {const r=await fetch(`${url}__quartermaster__/status`,{signal:AbortSignal.timeout(1500)});if(r.ok)running=await r.json();}catch {}
    if(running?.appId===meta.appId&&running?.buildId===meta.buildId) {
      console.log(`This release is already running: ${url}`);
      if(!args.includes('--no-open'))openBrowser(url);
      return;
    }
    throw new Error(`Port ${port} is in use by another application or release. Close its launch window, then try again. The port is fixed to keep your browser saves available.`);
  }
  console.log(`Quartermaster General v${meta.version} / Rules ${meta.rulesVersion}`);
  console.log(`Local game: ${url}`);
  console.log('Keep this window open while playing. Press Ctrl+C or close this window to stop.');
  console.log('Saves are stored in your browser. Export JSON backups from the game.');
  if(!args.includes('--no-open'))openBrowser(url);
  const stop=()=>{server.close();server.closeAllConnections();};
  process.on('SIGINT',stop);process.on('SIGTERM',stop);
}
if(process.argv[1]&&pathToFileURL(resolve(process.argv[1])).href===import.meta.url)main().catch(error=>{console.error(`Cannot start the game: ${error.message}`);process.exitCode=1;});
