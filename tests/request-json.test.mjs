import {it,expect} from 'vitest';
import {Readable} from 'node:stream';
import {readRequestJson} from '../scripts/request-json.mjs';
it('preserves Chinese game records across arbitrary byte boundaries',async()=>{
 const value={name:'分包中文测试',log:['德国打出建设陆军','苏联暗置响应']},bytes=Buffer.from(JSON.stringify(value));
 expect(await readRequestJson(Readable.from([...bytes].map(b=>Buffer.from([b]))))).toEqual(value);
});
it('limits total bytes rather than decoded characters',async()=>{
 await expect(readRequestJson(Readable.from([Buffer.from('"中文"')]),7)).rejects.toThrow('请求过大');
});
