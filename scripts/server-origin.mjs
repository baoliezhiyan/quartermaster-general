/** Explicit published origins; forwarding headers never grant access. */
export function connectionPolicy(port,configured='') {
 const localOrigin=`http://127.0.0.1:${port}`;
 let publicOrigin='';
 if(configured){
  let u;try{u=new URL(configured.trim());}catch{throw new Error('公网入口必须是完整的 HTTPS 网址。');}
  if(u.protocol!=='https:'||u.username||u.password||u.pathname!=='/'||u.search||u.hash)throw new Error('公网入口只填写 https://网址，不要附带路径或身份链接。');
  publicOrigin=u.origin;
 }
 const hosts=new Set([new URL(localOrigin).host,...(publicOrigin?[new URL(publicOrigin).host]:[])]);
 const origins=new Set([localOrigin,...(publicOrigin?[publicOrigin]:[])]);
 return {localOrigin,publicOrigin,hostAllowed:headers=>typeof headers.host==='string'&&hosts.has(headers.host),
  originAllowed:(headers,required=false)=>headers.origin===undefined?!required:typeof headers.origin==='string'&&origins.has(headers.origin)};
}
