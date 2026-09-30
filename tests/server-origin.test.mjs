import {test} from 'vitest';import assert from 'node:assert/strict';import {connectionPolicy} from '../scripts/server-origin.mjs';
test('local-only defaults reject public hosts and forwarded-header spoofing',()=>{
 const p=connectionPolicy(4183);assert(p.hostAllowed({host:'127.0.0.1:4183'}));assert(!p.hostAllowed({host:'evil.example','x-forwarded-host':'127.0.0.1:4183'}));assert(!p.originAllowed({origin:'https://evil.example','x-forwarded-proto':'https'}));assert(!p.originAllowed({},true));
});
test('a configured HTTPS entry admits HTTP and WebSocket requests, including host-header override',()=>{
 const p=connectionPolicy(4183,' https://test.trycloudflare.com/ ');assert.equal(p.publicOrigin,'https://test.trycloudflare.com');
 for(const host of ['test.trycloudflare.com','127.0.0.1:4183']){assert(p.hostAllowed({host}));assert(p.originAllowed({host,origin:'https://test.trycloudflare.com'},true));}
 assert(!p.originAllowed({origin:'https://other.trycloudflare.com'},true));assert(!p.hostAllowed({host:'test.trycloudflare.com.evil.example'}));assert(!p.originAllowed({origin:'http://test.trycloudflare.com'},true));assert(!p.originAllowed({origin:'null'},true));
});
test('rejects malformed, insecure and identity-bearing public entry configuration',()=>{
 for(const url of ['bad','http://test.example','https://user:pass@test.example','https://test.example/path','https://test.example/#identity=secret','https://test.example/?q=1'])assert.throws(()=>connectionPolicy(4183,url));
});
