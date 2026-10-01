import {it,expect} from 'vitest';
import http from 'node:http';
import {once} from 'node:events';
import {gunzipSync} from 'node:zlib';
import {sendText} from '../scripts/http-response.mjs';
it('compresses large history downloads and preserves exact UTF-8 bytes without a JSON envelope',async()=>{
 const text=('{"动作":"德国建设陆军"}\n').repeat(20000);
 const server=http.createServer((req,res)=>void sendText(req,res,text,{contentType:'application/x-ndjson; charset=utf-8',filename:'history.jsonl'}));server.listen(0,'127.0.0.1');await once(server,'listening');
 const request=encoding=>new Promise((resolve,reject)=>http.get(`http://127.0.0.1:${server.address().port}/`,{headers:{'Accept-Encoding':encoding}},res=>{const chunks=[];res.on('data',c=>chunks.push(c));res.on('end',()=>resolve({headers:res.headers,body:Buffer.concat(chunks)}));res.on('error',reject);}).on('error',reject));
 try{const zipped=await request('gzip');expect(zipped.headers['content-encoding']).toBe('gzip');expect(zipped.headers['content-disposition']).toContain('attachment');expect(gunzipSync(zipped.body).toString()).toBe(text);expect(zipped.body.length).toBeLessThan(Buffer.byteLength(text)/10);
 const plain=await request('gzip;q=0');expect(plain.headers['content-encoding']).toBeUndefined();expect(plain.body.toString()).toBe(text);
 }finally{server.closeAllConnections();await new Promise(r=>server.close(r));}
});
