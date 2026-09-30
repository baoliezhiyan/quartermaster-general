/** Decode only after receiving all bytes: a network chunk may split a UTF-8 character. */
export async function readRequestJson(stream,limit=70*1024*1024){
 const chunks=[];let size=0;
 for await(const chunk of stream){const bytes=Buffer.isBuffer(chunk)?chunk:Buffer.from(chunk);size+=bytes.length;if(size>limit)throw new Error('请求过大。');chunks.push(bytes);}
 return JSON.parse(Buffer.concat(chunks,size).toString('utf8')||'{}');
}
