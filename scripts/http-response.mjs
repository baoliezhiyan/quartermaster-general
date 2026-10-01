import {Readable} from 'node:stream';
import {pipeline} from 'node:stream/promises';
import {createGzip} from 'node:zlib';
/** HTTP compression complements websocket compression (downloads never use WS). */
export async function sendText(req,res,text,{contentType='application/json; charset=utf-8',filename}={}){
 const bytes=Buffer.from(text),gzip=bytes.length>=4096&&/(?:^|,)\s*gzip(?:\s*;\s*q=(?!0(?:\.0*)?(?:,|$))[0-9.]+)?\s*(?:,|$)/i.test(req.headers['accept-encoding']??'');
 const headers={'Content-Type':contentType,Vary:'Accept-Encoding'};
 if(filename)headers['Content-Disposition']=`attachment; filename="${filename}"`;
 if(gzip)headers['Content-Encoding']='gzip';else headers['Content-Length']=bytes.length;
 res.writeHead(200,headers);
 if(gzip)await pipeline(Readable.from([bytes]),createGzip({level:1}),res);else res.end(bytes);
}
