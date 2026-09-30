import type { SaveSession } from './saveFormat';

export interface SessionStore {
  read(id?:string):Promise<unknown | null>;
  write(session:SaveSession, expectedUpdatedAt?:string,replaceExisting?:boolean):Promise<void>;
  list():Promise<{id:string;updatedAt:string}[]>;
}

export class IndexedSessionStore implements SessionStore {
  private db:Promise<IDBDatabase> | undefined;
  private open() {
    return this.db ??= new Promise<IDBDatabase>((resolve,reject)=>{
      const request=indexedDB.open('quartermaster-local',1);
      request.onupgradeneeded=()=>{request.result.createObjectStore('sessions');request.result.createObjectStore('meta');};
      request.onsuccess=()=>resolve(request.result);
      request.onerror=()=>reject(request.error);
      request.onblocked=()=>reject(new Error('存档数据库被其他窗口阻塞。'));
    });
  }
  async read(id?:string) {
    const db=await this.open();
    return new Promise<unknown|null>((resolve,reject)=>{
      const tx=db.transaction(['sessions','meta'],'readonly');
      let value:unknown=null;
      const get=(key:string)=>{const r=tx.objectStore('sessions').get(key);r.onsuccess=()=>{value=r.result??null;};};
      if(id)get(id);else {const r=tx.objectStore('meta').get('last');r.onsuccess=()=>{if(r.result)get(r.result);};}
      tx.oncomplete=()=>resolve(value);tx.onerror=()=>reject(tx.error);tx.onabort=()=>reject(tx.error);
    });
  }
  async write(session:SaveSession, expectedUpdatedAt?:string,replaceExisting=false) {
    const db=await this.open();
    await new Promise<void>((resolve,reject)=>{
      const tx=db.transaction(['sessions','meta'],'readwrite');
      const store=tx.objectStore('sessions'),read=store.get(session.state.gameId);
      let conflict=false;
      read.onsuccess=()=>{
        if(expectedUpdatedAt && (!read.result || read.result.updatedAt!==expectedUpdatedAt)) {conflict=true;tx.abort();return;}
        if(replaceExisting){store.clear();tx.objectStore('meta').clear();}
        store.put(session,session.state.gameId);tx.objectStore('meta').put(session.state.gameId,'last');
      };
      tx.oncomplete=()=>resolve();tx.onerror=()=>reject(tx.error);tx.onabort=()=>reject(conflict?new Error('另一窗口已更新此对局，请重新读取本地对局后继续。'):tx.error);
    });
  }
  async list() {
    const db=await this.open();
    return new Promise<{id:string;updatedAt:string}[]>((resolve,reject)=>{
      const tx=db.transaction('sessions','readonly'),r=tx.objectStore('sessions').getAll();
      tx.oncomplete=()=>resolve((r.result as SaveSession[]).map(s=>({id:s.state.gameId,updatedAt:s.updatedAt})).sort((a,b)=>b.updatedAt.localeCompare(a.updatedAt)));
      tx.onerror=()=>reject(tx.error);
    });
  }
}
