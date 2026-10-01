import {afterEach,it,expect,vi} from 'vitest';
import {NetworkGameController} from '../src/network/NetworkGameController';
import {createGame} from '../src/core';
import type {RoomSnapshot} from '../src/network/protocol';
import {diffValue} from '../src/network/jsonPatch';
class Socket {static sockets:Socket[]=[];onopen?:()=>void;onmessage?:(e:{data:string})=>void;onclose?:()=>void;constructor(){Socket.sockets.push(this);}send(){}close(){} }
function fixture(){vi.stubGlobal('location',{protocol:'http:',host:'test'});vi.stubGlobal('WebSocket',Socket);const controller=new NetworkGameController('identity');const ws=Socket.sockets.at(-1)!;const s=createGame('network',1940);const snapshot:RoomSnapshot={state:s,info:{ready:true,canUndo:false,undoCount:0,savedAt:null,storageError:'',rounds:[],nations:[],replayMode:false,replayCursor:0,replayEntries:[]},room:{userId:'de',name:'DE',access:{kind:'player',seat:'germany'},members:[],connected:true,recoveryAvailable:true,epoch:'game-epoch',decision:'own-decision',serverId:'server',sequence:1}};const push=(v:RoomSnapshot)=>ws.onmessage?.({data:JSON.stringify(v)});push(snapshot);return{controller,ws,snapshot,push};}
afterEach(()=>{vi.unstubAllGlobals();vi.useRealTimers();});
it('applies consecutive deltas and requests a full snapshot when a delta is missing',async()=>{
 const f=fixture(),next=structuredClone(f.snapshot);next.room.sequence=2;next.state!.revision=1;
 f.ws.onmessage?.({data:JSON.stringify({...next,state:undefined,baseSequence:1,statePatch:diffValue(f.snapshot.state,next.state)})});
 expect(f.controller.getSnapshot()!.revision).toBe(1);expect(f.snapshot.state!.revision).toBe(0);
 const recovered=structuredClone(next);recovered.room.sequence=4;recovered.state!.revision=3;
 const fetcher=vi.fn(async(_url,options)=>{expect(JSON.parse(options.body).method).toBe('sync');return{json:async()=>({ok:true,result:recovered})};});vi.stubGlobal('fetch',fetcher);
 f.ws.onmessage?.({data:JSON.stringify({...recovered,state:undefined,baseSequence:3,statePatch:[{op:'set',path:['revision'],value:999}]})});
 expect(f.controller.getSnapshot()!.revision).toBe(1);await vi.waitFor(()=>expect(f.controller.getSnapshot()!.revision).toBe(3));expect(fetcher).toHaveBeenCalledTimes(1);f.controller.close();
});
it('retries a lost reply with the same request ID and blocks a second concurrent action',async()=>{
 const f=fixture();let release!:()=>void;const gate=new Promise<void>(r=>release=r),bodies:any[]=[];
 vi.stubGlobal('fetch',vi.fn(async(_url,options)=>{bodies.push(JSON.parse(options.body));if(bodies.length===1){await gate;throw Error('reply lost');}return{json:async()=>({ok:true,result:{ok:true}})};}));
 const command={type:'KEEP_OPENING' as const,seat:'germany' as const,expectedRevision:0,cardIds:f.snapshot.state!.decks.germany.hand.slice(0,7).map(c=>c.id)};
 const pending=f.controller.dispatch(command);await expect(f.controller.dispatch(command)).rejects.toThrow('正在提交');release();expect(await pending).toEqual({ok:true});expect(bodies).toHaveLength(2);expect(bodies[0]).toEqual(bodies[1]);expect(bodies[0].decision).toBe('own-decision');f.controller.close();
});
it('retains the last view on disconnect, and ignores older snapshots even across an epoch change',()=>{
 vi.useFakeTimers();const f=fixture();f.ws.onclose?.();expect(f.controller.getSnapshot()?.gameId).toBe('network');expect(f.controller.getSessionInfo().room?.connected).toBe(false);
 const newer=structuredClone(f.snapshot);newer.room.sequence=3;newer.room.epoch='new-epoch';newer.state!.revision=1;f.push(newer);f.push(f.snapshot);expect(f.controller.getSessionInfo().room!.epoch).toBe('new-epoch');expect(f.controller.getSnapshot()!.revision).toBe(1);f.controller.close();
});
it('uses the decision associated with the displayed command revision, not a later question',async()=>{
 const f=fixture(),newer=structuredClone(f.snapshot);newer.state!.revision=1;newer.room.sequence=2;newer.room.decision='next-decision';f.push(newer);let body:any;
 vi.stubGlobal('fetch',vi.fn(async(_url,options)=>{body=JSON.parse(options.body);return{json:async()=>({ok:false,error:'局面已更新'})};}));
 await expect(f.controller.dispatch({type:'ADVANCE_PHASE',seat:'germany',expectedRevision:0})).rejects.toThrow('局面已更新');expect(body.decision).toBe('own-decision');expect(body.revision).toBe(0);f.controller.close();
});

it('keeps submission pending until the acknowledged snapshot is visible',async()=>{
 vi.useFakeTimers();const f=fixture();vi.stubGlobal('fetch',vi.fn(async()=>({json:async()=>({ok:true,result:{ok:true,appliedRevision:1,epoch:'game-epoch'}})})));
 let done=false;const pending=f.controller.dispatch({type:'ADVANCE_PHASE',seat:'germany',expectedRevision:0}).then(()=>{done=true;});await vi.advanceTimersByTimeAsync(100);expect(done).toBe(false);
 const next=structuredClone(f.snapshot);next.state!.revision=1;next.room.sequence=2;f.push(next);await vi.advanceTimersByTimeAsync(50);await pending;expect(done).toBe(true);f.controller.close();
});
it('automatically reconciles an uncertain submission using the original ID',async()=>{
 vi.useFakeTimers();const f=fixture(),ids:string[]=[];vi.stubGlobal('fetch',vi.fn(async(_url,options)=>{ids.push(JSON.parse(options.body).id);if(ids.length<=3)throw Error('offline');return{json:async()=>({ok:true,result:{ok:true}})};}));
 await expect(f.controller.dispatch({type:'ADVANCE_PHASE',seat:'germany',expectedRevision:0})).rejects.toThrow('待确认');await vi.advanceTimersByTimeAsync(2000);expect(ids).toHaveLength(4);expect(new Set(ids).size).toBe(1);expect(f.controller.getSessionInfo().room!.error).toContain('已核对');f.controller.close();
});
it('loads GM replay entries on demand and retains them across metadata deltas',async()=>{
 const f=fixture(),s=structuredClone(f.snapshot);s.room.access={kind:'gm'};s.room.sequence=2;s.info.replayMode=true;f.push(s);const entries=[{index:0,text:'SECRET REPLAY',round:1}];
 const fetcher=vi.fn(async()=>({json:async()=>({ok:true,result:entries})}));vi.stubGlobal('fetch',fetcher);expect(f.controller.getSessionInfo().replayEntries).toEqual([]);await f.controller.loadReplayEntries();await f.controller.loadReplayEntries();expect(fetcher).toHaveBeenCalledTimes(1);
 f.ws.onmessage?.({data:JSON.stringify({room:{...s.room,sequence:3},statePatch:[],infoPatch:[{op:'set',path:['replayCursor'],value:1}],baseSequence:2})});expect(f.controller.getSessionInfo().replayEntries).toEqual(entries);
 const observer=structuredClone(s);observer.room.sequence=4;observer.room.access={kind:'public'};f.push(observer);expect(f.controller.getSessionInfo().replayEntries).toEqual([]);f.controller.close();
});
it('waits for replay import acknowledgement before lazy-loading entries',async()=>{
 const f=fixture();let release!:()=>void;const gate=new Promise<void>(r=>release=r),methods:string[]=[];
 vi.stubGlobal('fetch',vi.fn(async(_url,options)=>{const method=JSON.parse(options.body).method;methods.push(method);if(method==='importReplay'){await gate;return{json:async()=>({ok:true,result:null})};}return{json:async()=>({ok:true,result:[{index:0,text:'entry',round:0}]})};}));
 const importing=f.controller.importReplay('{}');const s=structuredClone(f.snapshot);s.room.access={kind:'gm'};s.room.sequence=2;s.info.replayMode=true;f.push(s);const loading=f.controller.loadReplayEntries();await Promise.resolve();expect(methods).toEqual(['importReplay']);release();await importing;await loading;expect(methods).toEqual(['importReplay','replayEntries']);expect(f.controller.getSessionInfo().replayEntries).toHaveLength(1);f.controller.close();
});
it('applies the random seat response even before a websocket update arrives',async()=>{
 const f=fixture(),s=structuredClone(f.snapshot);s.room.access={kind:'player',seat:'japan'};s.room.sequence=2;s.state!.viewSeat='japan';vi.stubGlobal('fetch',vi.fn(async()=>({json:async()=>({ok:true,result:s})})));
 await f.controller.drawCountry();expect(f.controller.getSessionInfo().room!.access).toEqual({kind:'player',seat:'japan'});expect(f.controller.getSnapshot()!.viewSeat).toBe('japan');f.controller.close();
});

it('accepts undo delta with previous epoch, clears old command context and ignores delayed old snapshots',async()=>{
 const f=fixture(),forward=structuredClone(f.snapshot);forward.room.sequence=2;forward.state!.revision=9;forward.state!.scores.germany=10;f.push(forward);
 const undo=structuredClone(f.snapshot);undo.room.sequence=3;undo.room.epoch='undo-epoch';undo.room.decision='undo-decision';
 f.ws.onmessage?.({data:JSON.stringify({...undo,state:undefined,baseEpoch:forward.room.epoch,baseSequence:2,statePatch:diffValue(forward.state,undo.state)})});
 expect(f.controller.getSnapshot()).toEqual(undo.state);expect(f.controller.getSessionInfo().room!.epoch).toBe('undo-epoch');f.push(forward);expect(f.controller.getSnapshot()).toEqual(undo.state);
 let body:any;vi.stubGlobal('fetch',vi.fn(async(_url,options)=>{body=JSON.parse(options.body);return{json:async()=>({ok:true,result:{ok:true}})};}));await f.controller.dispatch({type:'ADVANCE_PHASE',seat:'germany',expectedRevision:0});expect(body.epoch).toBe('undo-epoch');expect(body.decision).toBe('undo-decision');f.controller.close();
});
it('resyncs instead of applying a reverse delta to a different epoch',async()=>{
 const f=fixture(),recovered=structuredClone(f.snapshot);recovered.room.epoch='recovered';recovered.room.sequence=3;
 const fetcher=vi.fn(async()=>({json:async()=>({ok:true,result:recovered})}));vi.stubGlobal('fetch',fetcher);
 f.ws.onmessage?.({data:JSON.stringify({room:{...recovered.room,epoch:'undo'},baseEpoch:'wrong',baseSequence:1,statePatch:[{op:'set',path:['scores','germany'],value:999}]})});
 expect(f.controller.getSnapshot()!.scores.germany).not.toBe(999);await vi.waitFor(()=>expect(f.controller.getSessionInfo().room!.epoch).toBe('recovered'));expect(fetcher).toHaveBeenCalledTimes(1);f.controller.close();
});

it('retains chat on gameplay deltas and applies chat deletion without changing the game',()=>{
 const f=fixture(),chat=[{id:'msg',userId:'u',name:'玩家',seats:['英国'],text:'你好',sentAt:'now'}];
 const full={...f.snapshot,room:{...f.snapshot.room,chat}};f.push(full);
 f.ws.onmessage?.({data:JSON.stringify({room:{...f.snapshot.room,sequence:2},baseSequence:1,statePatch:[],infoPatch:[],chatPatch:[]})});
 expect(f.controller.getSessionInfo().room?.chat).toEqual(chat);
 f.ws.onmessage?.({data:JSON.stringify({room:{...f.snapshot.room,sequence:3},baseSequence:2,statePatch:[],infoPatch:[],chatPatch:diffValue(chat,[])})});
 expect(f.controller.getSessionInfo().room?.chat).toEqual([]);expect(f.controller.getSnapshot()).toEqual(f.snapshot.state);f.controller.close();
});

it('downloads host history outside command submission, without the 12-second timer or uncertainty state',async()=>{
 vi.useFakeTimers();const f=fixture();let release!:()=>void;const gate=new Promise<void>(r=>release=r);let signal:AbortSignal|undefined;
 vi.stubGlobal('fetch',vi.fn(async(url,options)=>{expect(url).toBe('/api/history-export');expect(JSON.parse(options.body)).toEqual({pointId:'nation:2:japan'});signal=options.signal;await gate;return {ok:true,text:async()=>'{"type":"header"}\n'};}));
 const pending=f.controller.exportSave('nation:2:japan');await vi.advanceTimersByTimeAsync(13000);expect(signal?.aborted).toBe(false);release();expect(await pending).toBe('{"type":"header"}\n');expect(f.controller.getSessionInfo().room?.error).toBeUndefined();f.controller.close();
});
it('reports an export error as a download failure without marking game actions uncertain',async()=>{
 const f=fixture();vi.stubGlobal('fetch',vi.fn(async()=>({ok:false,json:async()=>({error:'此功能仅GM可用。'})})));
 await expect(f.controller.exportSave()).rejects.toThrow('仅GM');expect(f.controller.getSessionInfo().room?.error).toBeUndefined();f.controller.close();
});
