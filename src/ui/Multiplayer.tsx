import {useEffect,useState,useSyncExternalStore} from 'react';
import {NetworkGameController} from '../network/NetworkGameController';
import type {Identity} from '../network/protocol';
import {App} from './App';
import {normalizeIdentities,type LocalIdentity} from './localIdentities';
const client=(window as Window & {qmClient?:{origin:string;roomId:string}}).qmClient;
const identityKey=client?'quartermaster-identities:'+client.roomId:'quartermaster-identities';
function saveIdentities(list:LocalIdentity[]){try{localStorage.setItem(identityKey,JSON.stringify(list));}catch{}}
function identities():LocalIdentity[]{try{const list=normalizeIdentities(JSON.parse(localStorage.getItem(identityKey)||'[]'));saveIdentities(list);return list;}catch{return [];}}
export function Multiplayer(){
 const [token,setToken]=useState(()=>new URLSearchParams(location.hash.slice(1)).get('identity')||'');
 const [oldLink,setOldLink]=useState('');
 const [name,setName]=useState(''),[error,setError]=useState(''),[busy,setBusy]=useState(false);
 const [saved,setSaved]=useState(identities),[online,setOnline]=useState<Set<string>>(()=>new Set());
 useEffect(()=>{
  if(token)return;
  let cancelled=false;
  async function refresh(){
   const list=identities();if(cancelled)return;setSaved(list);
   try{
    const statuses:{token:string;valid:boolean;online:boolean}[]=[];
    for(let start=0;start<list.length;start+=500){const response=await fetch('/api/identity-status',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({tokens:list.slice(start,start+500).map(i=>i.token)}),signal:AbortSignal.timeout(5000)});const data=await response.json();if(!data.ok||!Array.isArray(data.result))throw Error('检测失败');statuses.push(...data.result);}
    if(cancelled)return;
    const invalid=new Set(statuses.filter(s=>!s.valid).map(s=>s.token)),remaining=identities().filter(i=>!invalid.has(i.token));saveIdentities(remaining);setSaved(remaining);setOnline(new Set(statuses.filter(s=>s.online).map(s=>s.token)));
   }catch{if(!cancelled)setOnline(new Set());}
  }
  void refresh();const timer=setInterval(()=>void refresh(),15000);return ()=>{cancelled=true;clearInterval(timer);};
 },[token]);
 const choose=(id:string)=>{location.hash=new URLSearchParams({identity:id}).toString();setToken(id);};
 if(token)return <Connected key={token} token={token} exit={()=>choose('')}/>;
 return <main className="identity-entry"><h1>战场军需官 · 多人联机</h1><p>所有页面进入同一个房间。创建不同身份，即可分别入座六国。</p><form onSubmit={async e=>{e.preventDefault();setBusy(true);setError('');try{const res=await fetch('/api/identity',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name})});const data=await res.json();if(!data.ok)throw new Error(data.error);const i=data.result as Identity;saveIdentities([{...i,createdAt:Date.now()},...identities()]);choose(i.token);}catch(e){setError(String(e));}finally{setBusy(false);}}}><label>用户名 <input maxLength={32} required value={name} onChange={e=>setName(e.target.value)}/></label><button disabled={busy||!name.trim()}>创建用户并进入</button></form>{error&&<p role="alert">{error}</p>}<h2>返回已有用户</h2><button disabled={!saved.length} onClick={()=>{saveIdentities([]);setSaved([]);setOnline(new Set());}}>清除本地用户记录</button><div>{saved.map(i=><button key={i.id} title={`创建时间：${new Date(i.createdAt).toLocaleString()}`} onClick={()=>choose(i.token)}>{i.name} · {i.id.slice(0,6)}{online.has(i.token)&&<small className="identity-online">游戏中</small>}<small className="identity-created">{new Date(i.createdAt).toLocaleString()}</small></button>)}</div><p>收藏进入后的地址可找回此身份；打开普通入口可以另建身份。个人返回链接只供本人使用。</p><details><summary>用旧返回链接找回身份</summary><p>隧道网址变了？粘贴原来的个人返回链接，可继续使用原身份。服务器需要保留原身份数据。</p><form onSubmit={e=>{e.preventDefault();try{const url=new URL(oldLink.trim());const id=new URLSearchParams(url.hash.slice(1)).get('identity');if(!id)throw new Error('链接中没有身份信息，请粘贴完整的个人返回链接。');choose(id);}catch(e){setError(String(e));}}}><label>旧身份返回链接 <input type="url" required value={oldLink} onChange={e=>setOldLink(e.target.value)}/></label><button>找回身份</button></form></details></main>;
}
function Connected({token,exit}:{token:string;exit:()=>void}){
 const [controller]=useState(()=>new NetworkGameController(token));
 const info=useSyncExternalStore(controller.subscribe,controller.getSessionInfo),room=info.room!;
 const [message,setMessage]=useState('');
 useEffect(()=>()=>controller.close(),[controller]);
 useEffect(()=>{if(room.connected&&room.userId){try{const all=identities(),createdAt=all.find(i=>i.token===token)?.createdAt??Date.now();saveIdentities(normalizeIdentities([...all.filter(i=>i.token!==token),{id:room.userId,name:room.name,token,createdAt}]));}catch{/* The current return link still works when browser storage is unavailable. */}}},[room.connected,room.userId,room.name,token]);
 return <><div className="network-bar"><strong>{room.name||'连接房间'}</strong><span>{room.connected?'已连接':'未连接'}{client?' · 本地资源客户端':''}</span><button onClick={()=>{controller.close();exit();}}>返回身份入口</button><a href="/" target="_blank" rel="noreferrer">新页面加入</a><button onClick={()=>void navigator.clipboard.writeText(client?client.origin+'/'+location.hash:location.href).then(()=>setMessage('身份返回链接已复制。')).catch(()=>setMessage('请收藏或复制地址栏链接。'))}>复制我的返回链接</button>{room.access.kind==='gm'&&room.recoveryAvailable&&!controller.getSnapshot()&&<button onClick={()=>void controller.request('restore').catch(e=>setMessage(String(e)))}>恢复上一局</button>}<span role="status">{room.error||message}</span></div>{room.connected||controller.getSnapshot()?<App controller={controller}/>:<main><p>{room.error||'正在连接服务…'}</p></main>}</>;
}
