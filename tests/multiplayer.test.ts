import {parseMatchLog} from '../src/matchLog/codec';
import {replayNode} from '../src/matchLog/view';
import {GAME_VERSION} from '../src/matchLog/normalize';
import {describe,it,expect} from 'vitest';
import {Room} from '../src/network/Room';
import type {Identity,RoomSnapshot,RoomRequest} from '../src/network/protocol';
import type {SaveSession} from '../src/controller/saveFormat';
import {SEATS} from '../src/core';
import {projectState} from '../src/network/project';
import {createGame} from '../src/core';
import {responsePreset} from '../src/controller/responsePresets';
import {startResolution,resolveChoice} from '../src/core/resolution';
async function fixture(){
 let saved:SaveSession|null=null;const ids:Identity[]=[];
 const store={read:async()=>saved,write:async(s:SaveSession)=>{saved=structuredClone(s);},list:async()=>[]};
 const room=new Room(store,ids,async next=>{ids.splice(0,ids.length,...next);},async()=>saved?JSON.stringify(saved):null);
 async function join(name:string){const identity=await room.createIdentity(name);let snapshot:RoomSnapshot;let replaced=false;let conn=crypto.randomUUID();const send=(v:RoomSnapshot|{replaced:true})=>{'replaced' in v?replaced=true:snapshot=v;};await room.connect(identity.token,conn,send);
  const request=(method:string,...args:unknown[]):RoomRequest=>({id:crypto.randomUUID(),connection:conn,epoch:snapshot.room.epoch,revision:snapshot.state?.revision??null,method,args});
  return {identity,get snapshot(){return snapshot;},get replaced(){return replaced;},request,call:(method:string,...args:unknown[])=>room.request(identity.token,request(method,...args)),raw:(r:RoomRequest)=>room.request(identity.token,r),disconnect:()=>room.disconnect(identity.token,conn),reconnect:async()=>{conn=crypto.randomUUID();await room.connect(identity.token,conn,send);}};
 }
 return {room,join,store,ids,get saved(){return saved;}};
}
describe('multiplayer room',()=>{
 it('scene lock blocks player mutations but permits GM edits, reads, and automatic unlock',async()=>{
  const f=await fixture(),gm=await f.join('GM'),de=await f.join('德国');
  await gm.call('seat',{kind:'gm'});await de.call('seat',{kind:'player',seat:'germany'});
  await gm.call('dispatch',{type:'CREATE_GAME',gameId:'locked',seed:9,prelude:true});
  const pending=de.request('dispatch',{type:'DISCARD_PRELUDE_TOP',seat:'germany',expectedRevision:de.snapshot.state!.revision});
  await expect(de.call('sceneLock',true)).rejects.toThrow('只有GM');
  await gm.call('sceneLock',true);expect(de.snapshot.room.sceneLocked).toBe(true);
  const before=structuredClone(gm.snapshot.state);
  await expect(de.raw(pending)).rejects.toThrow('锁定');await expect(de.call('undo')).rejects.toThrow('锁定');
  expect(gm.snapshot.state).toEqual(before);await de.call('sync');
  const edited=structuredClone(gm.snapshot.state!);edited.scores.germany=7;
  await gm.call('editScene',edited);expect(de.snapshot.state!.scores.germany).toBe(7);
  await gm.call('sceneLock',false);expect(de.snapshot.room.sceneLocked).toBe(false);
  expect(await de.call('dispatch',{type:'DISCARD_PRELUDE_TOP',seat:'germany',expectedRevision:de.snapshot.state!.revision})).toMatchObject({ok:true});
  await gm.call('sceneLock',true);await gm.disconnect();expect(de.snapshot.room.sceneLocked).toBe(false);
  await gm.reconnect();await gm.call('sceneLock',true);await gm.call('seat',{kind:'public'});expect(de.snapshot.room.sceneLocked).toBe(false);
 });

 it('keeps armament prompts and payment usable after repeated cached player projections',async()=>{
  const f=await fixture(),gm=await f.join('GM'),de=await f.join('德国'),uk=await f.join('英国');
  await gm.call('seat',{kind:'gm'});await de.call('seat',{kind:'player',seat:'germany'});await uk.call('seat',{kind:'player',seat:'united_kingdom'});
  await gm.call('dispatch',{type:'CREATE_GAME',gameId:'armament-projection',seed:19,prelude:true,balance:true});
  const s=structuredClone(gm.snapshot.state!);s.prelude!.active=false;s.status='PLAYING';s.phase='SUPPLY';s.round=1;s.setupCompleted=[...SEATS];
  const p=s.prelude!.decks.germany;
  for(const zone of ['hand','drawPile','discardPile'] as const){const i=p[zone].findIndex(c=>c.definitionId==='prelude_DE-08');if(i>=0)s.decks.germany.faceDown.push(...p[zone].splice(i,1));}
  const save=responsePreset('keep-calm','armament-projection');save.state=s;save.replayBase=structuredClone(s);
  await gm.call('importSave',JSON.stringify(save));
  await de.call('sync');await uk.call('sync');await de.call('sync');
  const dispatch=async(command:Record<string,unknown>)=>de.call('dispatch',{seat:'germany',expectedRevision:de.snapshot.state!.revision,...command});
  expect(await dispatch({type:'ADVANCE_PHASE'})).toMatchObject({ok:true});
  let choice=de.snapshot.state!.resolution!.choice!;
  expect(choice?.kind).toBe('TRIGGER');
  const option=choice.options.find(o=>o.label===gm.snapshot.state!.resolution!.rules.find(r=>r.scopeId==='prelude_DE-08')?.label)!;
  expect(option).toBeDefined();expect(uk.snapshot.state!.resolution!.choice).toBeNull();
  expect(await dispatch({type:'RESOLVE_ENGINE_CHOICE',choiceId:choice.id,ids:[option.id]})).toMatchObject({ok:true});
  choice=de.snapshot.state!.resolution!.choice!;expect(choice.kind).toBe('CARDS');
  expect(await dispatch({type:'RESOLVE_ENGINE_CHOICE',choiceId:choice.id,ids:[choice.options[0].id]})).toMatchObject({ok:true});
  choice=de.snapshot.state!.resolution!.choice!;expect(choice.kind).toBe('ACTION');
  expect(choice.options.length).toBeGreaterThan(0);
 });
 it('GM edits prelude tension and ends prelude for all clients; players cannot edit',async()=>{
  const f=await fixture(),gm=await f.join('GM'),player=await f.join('玩家');await gm.call('seat',{kind:'gm'});await player.call('seat',{kind:'player',seat:'japan'});
  await gm.call('dispatch',{type:'CREATE_GAME',gameId:'scene-prelude',seed:1,prelude:true});
  const s=structuredClone(gm.snapshot.state!);s.prelude!.tension=-3;
  await expect(player.call('editScene',s,{endPrelude:true})).rejects.toThrow('GM');
  await gm.call('editScene',s);expect(player.snapshot.state!.prelude!.tension).toBe(-3);
  await gm.call('editScene',structuredClone(gm.snapshot.state!),{endPrelude:true});
  expect(player.snapshot.state!.phase).toBe('SETUP');expect(player.snapshot.state!.prelude!.active).toBe(false);
  expect(player.snapshot.state!.decks.japan.hand).toHaveLength(12);expect(await gm.call('checkReplay')).toBe(true);
 });
 it('persists neutrality entry from a GM edit and broadcasts it to every seat and observer',async()=>{
  const f=await fixture(),gm=await f.join('中立GM'),su=await f.join('苏联'),observer=await f.join('美国观察者'),watch=await f.join('公众');
  await gm.call('seat',{kind:'gm'});await su.call('seat',{kind:'player',seat:'soviet_union'});await observer.call('seat',{kind:'observer',seat:'united_states'});
  await gm.call('dispatch',{type:'CREATE_GAME',gameId:'neutral-room',seed:1940,prelude:true,neutrality:true});
  const state=structuredClone(gm.snapshot.state!);
  state.units=state.units.filter(u=>u.regionId!=='western_europe');
  state.units.push({id:'axis-west',country:'germany',type:'army',regionId:'western_europe'},{id:'axis-ukraine',country:'germany',type:'army',regionId:'ukraine'},{id:'axis-east',country:'italy',type:'army',regionId:'eastern_europe'},{id:'axis-india',country:'japan',type:'army',regionId:'india'});
  const deck=state.decks.united_kingdom;for(const zone of ['hand','drawPile'] as const){const i=deck[zone].findIndex(c=>c.definitionId==='special_7');if(i>=0)deck.active.push(...deck[zone].splice(i,1));}
  await gm.call('editScene',state);
  for(const peer of [gm,su,observer,watch]){expect(peer.snapshot.state!.neutrality!.united_states.neutral).toBe(false);expect(peer.snapshot.state!.neutralityNotices).toHaveLength(1);expect(peer.snapshot.state!.scores.united_states).toBe(4);}
  expect(watch.snapshot.state!.decks.soviet_union.hand.every(c=>c.definitionId==='hidden')).toBe(true);
  const save=await gm.call('exportSave');await gm.call('importSave',save);expect(gm.snapshot.state!.scores.united_states).toBe(4);expect(await gm.call('checkReplay')).toBe(true);
  const archive=await parseMatchLog(await gm.call('exportReplay') as string,GAME_VERSION);expect(archive.frames.at(-1)!.state.scores.bySeat.united_states).toBe(4);await expect(gm.call('importReplay',await gm.call('exportReplay'))).rejects.toThrow('只读');
  expect(gm.snapshot.info.replayMode).toBe(false);expect(gm.snapshot.state!.neutrality!.united_states.neutral).toBe(false);expect(gm.snapshot.state!.scores.united_states).toBe(4);
 });
 it('six prelude seats keep private hands, fixed views, and recoverable replay nodes',async()=>{
  const f=await fixture(),gm=await f.join('序章GM');await gm.call('seat',{kind:'gm'});
  const players=[];for(const seat of SEATS){const p=await f.join(seat);await p.call('seat',{kind:'player',seat});players.push(p);}
  await gm.call('dispatch',{type:'CREATE_GAME',gameId:'prelude-room',seed:1940,mode:'FULL',prelude:true});
  for(let i=0;i<6;i++){const s=players[i].snapshot.state!,seat=SEATS[i];expect(s.phase).toBe('PRELUDE');expect(s.viewSeat).toBe(seat);expect(s.decks[seat].hand).toHaveLength(12);expect(s.prelude!.decks[seat].hand.every(c=>c.definitionId.startsWith('prelude_'))).toBe(true);const other=SEATS[(i+1)%6];expect(s.prelude!.decks[other].hand.every(c=>c.definitionId==='hidden')).toBe(true);}
  const de=players[0];let s=de.snapshot.state!;await de.call('dispatch',{type:'DISCARD_PRELUDE_TOP',seat:'germany',expectedRevision:s.revision});s=de.snapshot.state!;
  await de.call('dispatch',{type:'PLAY_PRELUDE',seat:'germany',expectedRevision:s.revision,cardId:s.prelude!.decks.germany.hand[0].id});
  expect(de.snapshot.state!.viewSeat).toBe('germany');expect(gm.snapshot.state!.viewSeat).toBe('united_kingdom');expect(players[1].snapshot.state!.activeSeat).toBe('united_kingdom');
  expect(await gm.call('checkReplay')).toBe(true);const archive=await parseMatchLog(await gm.call('exportReplay') as string,GAME_VERSION);expect(archive.frames.at(-1)!.state.prelude?.active).toBe(true);const own=replayNode(archive,archive.frames.at(-1)!.seq,false,'germany').state;expect(own.areas.find(a=>a.areaId==='united_kingdom/prelude_hand')!.cardIds).toEqual([]);expect(gm.snapshot.info.replayMode).toBe(false);
 });
 it('sends a hidden response only to its country then reveals it after activation',async()=>{
  const f=await fixture(),gm=await f.join('GM'),de=await f.join('德国'),uk=await f.join('英国'),watch=await f.join('观察者');
  await gm.call('seat',{kind:'gm'});await de.call('seat',{kind:'player',seat:'germany'});await uk.call('seat',{kind:'player',seat:'united_kingdom'});
  await gm.call('importSave',JSON.stringify(responsePreset('anti-submarine','response')));
  const s=de.snapshot.state!,card=s.decks.germany.hand.find(c=>c.definitionId==='special_168')!;
  await de.call('dispatch',{type:'PLAY_CARD',seat:'germany',expectedRevision:s.revision,cardId:card.id,effectIndices:[0,1],targetIds:[]});
  const c=uk.snapshot.state!.resolution!.choice!;expect(c.seat).toBe('united_kingdom');expect(de.snapshot.state!.resolution!.choice).toBeNull();expect(watch.snapshot.state!.resolution!.choice).toBeNull();
  expect(JSON.stringify(watch.snapshot.state)).not.toContain('反潜战术');expect(JSON.stringify(watch.snapshot.state)).not.toContain('rollback');
  await uk.call('dispatch',{type:'RESOLVE_ENGINE_CHOICE',seat:'united_kingdom',expectedRevision:uk.snapshot.state!.revision,choiceId:c.id,ids:[c.options.find(o=>o.label.includes('反潜战术'))!.id]});
  expect(watch.snapshot.state!.publicLog!.some(l=>l.text.includes('反潜战术'))).toBe(true);expect(de.snapshot.state!.viewSeat).toBe('germany');expect(uk.snapshot.state!.viewSeat).toBe('united_kingdom');expect(await gm.call('checkReplay')).toBe(true);const archive=await parseMatchLog(await gm.call('exportReplay') as string,GAME_VERSION);expect(archive.frames.some(f=>f.events.some(e=>e.eventType==='window_opened'))).toBe(true);expect(archive.frames.some(f=>'action'in f&&f.action?.actorSeat==='united_kingdom')).toBe(true);
 });
 it('accepts simultaneous reveal acknowledgements and replays the result barrier deterministically',async()=>{
  const f=await fixture(),gm=await f.join('GM');await gm.call('seat',{kind:'gm'});
  const players=[];for(const seat of ['germany','italy','japan'] as const){const p=await f.join(seat);await p.call('seat',{kind:'player',seat});players.push(p);}
  const save=responsePreset('anti-submarine','batch'),s=save.state;
  for(const d of Object.values(s.decks)){d.drawPile.push(...d.hand,...d.faceDown);d.hand=[];d.faceDown=[];}
  for(const [seat,id,zone] of [['italy','special_236','hand'],['germany','build_army','discardPile'],['italy','special_219','discardPile'],['japan','build_army','discardPile']] as const){const d=s.decks[seat],i=d.drawPile.findIndex(c=>c.definitionId===id);d[zone].push(...d.drawPile.splice(i,1));}
  s.activeSeat=s.operatorSeat=s.viewSeat='italy';save.replayBase=structuredClone(s);save.rounds=[];save.nations=[];
  await gm.call('importSave',JSON.stringify(save));const it=players[1];
  await it.call('dispatch',{type:'PLAY_CARD',seat:'italy',expectedRevision:it.snapshot.state!.revision,cardId:s.decks.italy.hand[0].id,effectIndices:[0],targetIds:[]});
  for(let n=0;n<5&&!gm.snapshot.state!.resolution!.revealGroup;n++){const c=it.snapshot.state!.resolution!.choice!;await it.call('dispatch',{type:'RESOLVE_ENGINE_CHOICE',seat:'italy',expectedRevision:it.snapshot.state!.revision,choiceId:c.id,ids:[c.options[0].id]});}
  for(let stage=0;stage<2;stage++){
   const requests=players.map(p=>{const s=p.snapshot.state!,seat=s.viewSeat;const notice=s.responseNotices!.find(n=>!n.readBy.includes(seat))!;return p.request('dispatch',{type:'ACK_RESPONSE_NOTICE',seat,expectedRevision:s.revision,noticeId:notice.id});});
   const results=await Promise.all(players.map((p,i)=>p.raw(requests[i])));expect(results.every(r=>(r as {ok:boolean}).ok)).toBe(true);
   if(stage===0){expect(gm.snapshot.state!.resolution!.choice).toBeNull();expect(players[1].snapshot.state!.responseNotices!.some(n=>n.title==='翻牌结果'&&n.text.includes('不能打出'))).toBe(true);}
  }
  expect(gm.snapshot.state!.resolution!.choice!.seat).toBe('germany');expect(players[2].snapshot.state!.resolution!.waiting).toBe(true);expect(players[2].snapshot.state!.resolution).not.toHaveProperty('waitingFor');expect(gm.snapshot.state!.resolution!.choice!.seat).toBe('germany');
  expect(await gm.call('checkReplay')).toBe(true);
  const archive=await parseMatchLog(await gm.call('exportReplay') as string,GAME_VERSION);expect(archive.frames.filter(f=>'action'in f&&f.action?.selection&&JSON.stringify(f.action.selection).includes('ACK_RESPONSE_NOTICE'))).toHaveLength(6);expect(archive.frames.at(-1)!.state.pendingDecisions.some(d=>d.decisionSeat==='germany')).toBe(true);
 });
 it('upgrades an imported legacy snapshot while retaining a replayable legacy history',async()=>{
  const f=await fixture(),gm=await f.join('GM');await gm.call('seat',{kind:'gm'});
  const save=responsePreset('anti-submarine','legacy-save');delete save.state.resolutionVersion;save.replayBase=structuredClone(save.state);save.rounds=[];save.nations=[];
  await gm.call('importSave',JSON.stringify(save));expect(gm.snapshot.state!.resolutionVersion).toBe(3);expect(await gm.call('checkReplay')).toBe(true);
  const file=await parseMatchLog(await gm.call('exportReplay') as string,GAME_VERSION);expect(file.header.origin.kind).toBe('snapshot');expect(file.start.state.phase).toBe(gm.snapshot.state!.phase);
 });
 it('starts empty, supports exclusive seats, unlimited observers and any vacant GM',async()=>{
  const f=await fixture(),a=await f.join('甲'),b=await f.join('乙');expect(a.snapshot.state).toBeNull();expect(a.snapshot.room.access.kind).toBe('public');
  await a.call('seat',{kind:'player',seat:'germany'});await expect(b.call('seat',{kind:'player',seat:'germany'})).rejects.toThrow('已有人');expect(b.snapshot.room.access.kind).toBe('public');
  await expect(a.call('dispatch',{type:'CREATE_GAME',gameId:'x',seed:1})).rejects.toThrow('GM');
  await a.call('seat',{kind:'observer',seat:'germany'});await b.call('seat',{kind:'observer',seat:'germany'});
  await b.call('seat',{kind:'gm'});await b.call('dispatch',{type:'CREATE_GAME',gameId:'x',seed:1});expect(a.snapshot.state?.gameId).toBe('x');
 });
 it('six independent countries keep opening hands and complete a round with response windows',async()=>{
  const f=await fixture(),gm=await f.join('GM');await gm.call('seat',{kind:'gm'});
  const players=[];for(const seat of SEATS){const p=await f.join(seat);await p.call('seat',{kind:'player',seat});players.push(p);}
  await gm.call('dispatch',{type:'CREATE_GAME',gameId:'full',seed:1940});
  for(let i=0;i<6;i++){const p=players[i],s=p.snapshot.state!;await p.call('dispatch',{type:'KEEP_OPENING',seat:SEATS[i],expectedRevision:s.revision,cardIds:s.decks[SEATS[i]].hand.slice(0,7).map(c=>c.id)});expect(p.snapshot.state?.viewSeat).toBe(SEATS[i]);}
  expect(gm.snapshot.state?.round).toBe(1);
  let count=0;while(gm.snapshot.state!.round<2&&count++<100){const s=gm.snapshot.state!,c=s.resolution?.choice,seat=c?.seat??s.activeSeat,p=players[SEATS.indexOf(seat)];const command=c?{type:'RESOLVE_ENGINE_CHOICE',choiceId:c.id,ids:c.kind==='TRIGGER'||c.canSkip||c.min===0?[]:c.options.slice(0,c.min).map(o=>o.id),seat,expectedRevision:s.revision}:s.phase==='DISCARD'?{type:'DISCARD_HAND',cardIds:[],seat,expectedRevision:s.revision}:{type:'ADVANCE_PHASE',seat,expectedRevision:s.revision};const result=await p.call('dispatch',command);expect(result,`${s.phase} ${seat}`).toEqual({ok:true});}
  expect(gm.snapshot.state?.round).toBe(2);expect(await gm.call('checkReplay')).toBe(true);
 },60000);
 it('does not leak foreign identities, seed, private notices or rollback snapshots',()=>{
  const s=createGame('privacy',81232,'FULL');s.responseNotices=[{id:'secret',recipients:['japan'],readBy:[],text:'private notification',cards:s.decks.japan.hand.slice(0,1)}];
  const view=projectState(s,{kind:'player',seat:'germany'},'germany')!;
  expect(view.decks.japan.hand.length).toBe(12);expect(view.seed).toBe(0);expect(view.responseNotices).toEqual([]);
  const json=JSON.stringify(view);for(const c of [...s.decks.japan.hand,...s.decks.japan.drawPile])expect(json).not.toContain(`"${c.id}"`);
  expect(view.decks.germany.hand).toEqual(s.decks.germany.hand);expect(view.decks.germany.drawPile.map(c=>c.definitionId)).toEqual([...view.decks.germany.drawPile.map(c=>c.definitionId)].sort());
 });
 it('rejects observer mutations, foreign commands and stale requests; deduplicates accepted commands',async()=>{
  const f=await fixture(),gm=await f.join('GM'),p=await f.join('P');await gm.call('seat',{kind:'gm'});await gm.call('dispatch',{type:'CREATE_GAME',gameId:'q',seed:1});
  await expect(p.call('exportSave')).rejects.toThrow('GM');await expect(p.call('undo')).rejects.toThrow();
  await p.call('seat',{kind:'player',seat:'germany'});const s=p.snapshot.state!;
  await expect(p.call('dispatch',{type:'KEEP_OPENING',seat:'japan',expectedRevision:s.revision,cardIds:[]})).rejects.toThrow('其他国家');
  const req=p.request('dispatch',{type:'KEEP_OPENING',seat:'germany',expectedRevision:s.revision,cardIds:s.decks.germany.hand.slice(0,7).map(c=>c.id)});
  await p.raw(req);const revision=p.snapshot.state!.revision;await p.raw(req);expect(p.snapshot.state!.revision).toBe(revision);
  await expect(p.raw({...req,id:crypto.randomUUID()})).rejects.toThrow('局面已更新');
 });
 it('keeps offline seats and invalidates a replaced connection',async()=>{
  const f=await fixture(),p=await f.join('P');await p.call('seat',{kind:'player',seat:'germany'});const old=p.request('seat',{kind:'public'});
  await p.disconnect();await p.reconnect();expect(p.snapshot.room.access).toEqual({kind:'player',seat:'germany'});await expect(p.raw(old)).rejects.toThrow('接管');
  await f.room.connect(p.identity.token,'replacement',()=>{});expect(p.replaced).toBe(true);
 });
 it('replay stays independent and cannot replace the room; server restart stays empty',async()=>{
  const f=await fixture(),gm=await f.join('GM'),p=await f.join('P');await gm.call('seat',{kind:'gm'});await p.call('seat',{kind:'player',seat:'germany'});await gm.call('dispatch',{type:'CREATE_GAME',gameId:'r',seed:1});
  const replay=await gm.call('exportReplay');const archive=await parseMatchLog(replay as string,GAME_VERSION);const previous=structuredClone(gm.snapshot.state);replayNode(archive,1);await expect(gm.call('importReplay',replay)).rejects.toThrow('只读');expect(gm.snapshot.state).toEqual(previous);expect(p.snapshot.room.access.kind).toBe('player');
  const restarted=new Room(f.store,f.ids,async()=>{},async()=>JSON.stringify(f.saved));let snap:RoomSnapshot|undefined;await restarted.connect(gm.identity.token,'new',v=>{if(!('replaced'in v))snap=v;});expect(snap!.state).toBeNull();expect(snap!.room.access.kind).toBe('public');expect(snap!.room.recoveryAvailable).toBe(true);
 });
});

it('keeps independent opening decisions valid across six simultaneous confirmations',async()=>{
 const f=await fixture(),gm=await f.join('GM');await gm.call('seat',{kind:'gm'});const players=[];
 for(const seat of SEATS){const p=await f.join(seat);await p.call('seat',{kind:'player',seat});players.push(p);}
 await gm.call('dispatch',{type:'CREATE_GAME',gameId:'simultaneous',seed:1940});
 const requests=players.map((p,i)=>({...p.request('dispatch',{type:'KEEP_OPENING',seat:SEATS[i],expectedRevision:p.snapshot.state!.revision,cardIds:p.snapshot.state!.decks[SEATS[i]].hand.slice(0,7).map(c=>c.id)}),decision:p.snapshot.room.decision}));
 const results=await Promise.all(players.map((p,i)=>p.raw(requests[i])));expect(results.every(r=>(r as {ok:boolean}).ok)).toBe(true);
 expect(gm.snapshot.state!.setupCompleted).toHaveLength(6);expect(await gm.call('checkReplay')).toBe(true);
 const revision=gm.snapshot.state!.revision;await players[0].raw(requests[0]);expect(gm.snapshot.state!.revision).toBe(revision);
 await expect(players[0].raw({...requests[0],id:crypto.randomUUID()})).rejects.toThrow('局面已更新');
});
it('does not invalidate a decision on seat/presence or another response preference; rejects it after GM edit',async()=>{
 const f=await fixture(),gm=await f.join('GM'),de=await f.join('DE'),uk=await f.join('UK');await gm.call('seat',{kind:'gm'});await de.call('seat',{kind:'player',seat:'germany'});await uk.call('seat',{kind:'player',seat:'united_kingdom'});
 const save=responsePreset('anti-submarine','decision');await gm.call('importSave',JSON.stringify(save));
 const s=de.snapshot.state!,request={...de.request('dispatch',{type:'ADVANCE_PHASE',seat:'germany',expectedRevision:s.revision}),decision:de.snapshot.room.decision};
 const response=uk.snapshot.state!.decks.united_kingdom.faceDown[0];
 await uk.call('dispatch',{type:'SET_CARD_RESPONSE',seat:'united_kingdom',expectedRevision:uk.snapshot.state!.revision,cardId:response.id,enabled:false});
 await gm.call('view','japan');const observer=await f.join('observer');await observer.call('seat',{kind:'observer',seat:'germany'});
 expect(de.snapshot.room.decision).toBe(request.decision);expect(await de.raw(request)).toMatchObject({ok:true});
 const before=de.snapshot.state!,pending={...de.request('dispatch',{type:'ADVANCE_PHASE',seat:'germany',expectedRevision:before.revision}),decision:de.snapshot.room.decision};
 await gm.call('importSave',JSON.stringify(save));await expect(de.raw(pending)).rejects.toThrow('局面已更新');
});
it('allocates all six countries atomically to concurrent public observers and reports a full room',async()=>{
 const f=await fixture(),gm=await f.join('GM');await gm.call('seat',{kind:'gm'});const players=[];for(let i=0;i<7;i++)players.push(await f.join('draw'+i));
 const requests=players.map(p=>p.request('drawCountry'));const outcomes=await Promise.allSettled(players.map((p,i)=>p.raw(requests[i])));
 expect(outcomes.filter(r=>r.status==='fulfilled')).toHaveLength(6);expect(String((outcomes.find(r=>r.status==='rejected') as PromiseRejectedResult).reason)).toContain('已经满了');
 const assigned=players.filter(p=>p.snapshot.room.access.kind==='player');expect(new Set(assigned.map(p=>(p.snapshot.room.access as {seat:string}).seat)).size).toBe(6);expect(gm.snapshot.room.access.kind).toBe('gm');
 const original=players[0].snapshot.room.access;await players[0].raw(requests[0]);expect(players[0].snapshot.room.access).toEqual(original);await expect(gm.call('drawCountry')).rejects.toThrow('通用观察者');
});
it('random seating respects offline reservations and observer/replay restrictions',async()=>{
 const f=await fixture(),gm=await f.join('GM'),held=await f.join('held'),watch=await f.join('watch');await gm.call('seat',{kind:'gm'});await held.call('seat',{kind:'player',seat:'germany'});await held.disconnect();
 await watch.call('seat',{kind:'observer',seat:'germany'});await expect(watch.call('drawCountry')).rejects.toThrow('通用观察者');await watch.call('seat',{kind:'public'});await watch.call('drawCountry');expect(watch.snapshot.room.access).not.toEqual({kind:'player',seat:'germany'});
 await gm.call('dispatch',{type:'CREATE_GAME',gameId:'draw-replay',seed:1940});await expect(gm.call('importReplay',await gm.call('exportReplay'))).rejects.toThrow('只读');await watch.call('seat',{kind:'public'});await watch.call('drawCountry');expect(watch.snapshot.room.access.kind).toBe('player');
});

it('binds multiple countries exclusively, reconnects to first, and lets GM unbind offline holders',async()=>{
 const f=await fixture(),p=await f.join('多国'),other=await f.join('其他'),gm=await f.join('管理');
 await p.call('seat',{kind:'player',seat:'japan'});await p.call('binding','japan',true);await p.call('binding','italy',true);
 expect(p.snapshot.room.bindings).toEqual(['japan','italy']);
 await expect(other.call('seat',{kind:'player',seat:'italy'})).rejects.toThrow('有人');
 await expect(p.call('seat',{kind:'observer',seat:'japan'})).rejects.toThrow('绑定');
 await expect(p.call('seat',{kind:'player',seat:'germany'})).rejects.toThrow('绑定');
 await p.call('seat',{kind:'player',seat:'italy'});await p.disconnect();await p.reconnect();expect(p.snapshot.room.access).toEqual({kind:'player',seat:'japan'});
 await p.call('binding','japan',false);expect(p.snapshot.room.access).toEqual({kind:'player',seat:'italy'});
 await p.call('binding','italy',false);expect(p.snapshot.room.access).toEqual({kind:'player',seat:'italy'});expect(p.snapshot.room.bindings).toEqual([]);
 await p.call('binding','italy',true);await p.call('binding','germany',true);await p.disconnect();
 await gm.call('seat',{kind:'gm'});await expect(gm.call('binding','united_states',true)).rejects.toThrow();
 await gm.call('binding','italy',false);await gm.call('binding','germany',false);await other.call('seat',{kind:'player',seat:'germany'});
 await p.reconnect();expect(p.snapshot.room.access.kind).toBe('public');expect(p.snapshot.room.bindings).toEqual([]);
});
it('serializes competing bindings and entering GM releases only the entrant bindings',async()=>{
 const f=await fixture(),a=await f.join('甲'),b=await f.join('乙');
 await a.call('seat',{kind:'player',seat:'japan'});await b.call('seat',{kind:'player',seat:'germany'});await a.call('binding','japan',true);await b.call('binding','germany',true);
 const results=await Promise.allSettled([a.call('binding','italy',true),b.call('binding','italy',true)]);expect(results.filter(r=>r.status==='fulfilled')).toHaveLength(1);
 await expect(b.call('binding','japan',false)).rejects.toThrow();await a.call('seat',{kind:'gm'});expect(a.snapshot.room.bindings).toEqual([]);expect(b.snapshot.room.bindings).toContain('germany');
});
it('restores bindings from identity storage after server restart and preserves them when adding users',async()=>{
 const f=await fixture(),a=await f.join('保留');await a.call('seat',{kind:'player',seat:'italy'});await a.call('binding','italy',true);await a.call('binding','japan',true);await f.join('新用户');
 expect(f.ids.find(i=>i.id===a.identity.id)?.bindings).toEqual(['japan','italy']);
 const restarted=new Room(f.store,structuredClone(f.ids),async()=>{},async()=>null);let snapshot:RoomSnapshot|undefined;
 await restarted.connect(a.identity.token,'restart',v=>{if(!('replaced' in v))snapshot=v;});expect(snapshot!.room.access).toEqual({kind:'player',seat:'japan'});expect(snapshot!.room.bindings).toEqual(['japan','italy']);
});
it('sends bound-country attention only to its owner, with fixed keys across presence updates',async()=>{
 const f=await fixture(),gm=await f.join('GM'),p=await f.join('多国'),watch=await f.join('旁观');await gm.call('seat',{kind:'gm'});await p.call('seat',{kind:'player',seat:'japan'});await p.call('binding','japan',true);await p.call('binding','germany',true);
 await gm.call('dispatch',{type:'CREATE_GAME',gameId:'attention',seed:1,mode:'FULL',prelude:true});
 const attention=p.snapshot.room.bindingAttention!;expect(attention.some(a=>a.kind==='turn'&&a.seat==='germany')).toBe(true);expect(watch.snapshot.room.bindingAttention).toEqual([]);
 await f.join('presence');expect(p.snapshot.room.bindingAttention).toEqual(attention);expect(p.snapshot.state!.decks.germany.hand.every(c=>c.definitionId==='hidden')).toBe(true);
 await p.call('seat',{kind:'player',seat:'germany'});expect(p.snapshot.state!.decks.germany.hand.every(c=>c.definitionId!=='hidden')).toBe(true);
});

it('chat is shared, bounded, attributed at send time and independent of edits/load/undo',async()=>{
 const f=await fixture(),gm=await f.join('GM'),p=await f.join('多国'),watch=await f.join('观察');
 await gm.call('seat',{kind:'gm'});await p.call('seat',{kind:'player',seat:'united_kingdom'});await p.call('binding','united_kingdom',true);await p.call('binding','united_states',true);await p.call('binding','soviet_union',true);
 await gm.call('dispatch',{type:'CREATE_GAME',gameId:'chat',seed:1,prelude:true});
 const original=structuredClone(gm.snapshot.state),req=p.request('chatSend','<b>你好</b>');await p.raw(req);await p.raw(req);
 expect(gm.snapshot.state).toEqual(original);expect(watch.snapshot.room.chat).toHaveLength(1);
 expect(watch.snapshot.room.chat![0]).toMatchObject({name:'多国',seats:['英国','苏联','美国'],text:'<b>你好</b>'});
 await expect(p.call('chatSend','a'.repeat(301))).rejects.toThrow('300');await expect(p.call('chatSend',' ')).rejects.toThrow('不能为空');await p.call('chatSend','😀'.repeat(300));
 await gm.call('sceneLock',true);await watch.call('chatSend','锁定时仍可聊天');
 const save=await gm.call('exportSave');expect(save).not.toContain('锁定时仍可聊天');
 const edited=structuredClone(gm.snapshot.state!);edited.scores.germany=5;await gm.call('editScene',edited);await gm.call('undo');await gm.call('importSave',save);
 expect(p.snapshot.room.chat).toHaveLength(3);expect(p.snapshot.room.chat![0].seats).toEqual(['英国','苏联','美国']);
 const id=p.snapshot.room.chat![0].id;await expect(p.call('chatDelete',id)).rejects.toThrow('只有GM');await expect(watch.call('chatClear')).rejects.toThrow('只有GM');
 await gm.call('chatDelete',id);expect(p.snapshot.room.chat).toHaveLength(2);await gm.call('chatClear');expect(watch.snapshot.room.chat).toEqual([]);
});

it('fresh repeated air defense requests notify the controller of another bound country',async()=>{
 const f=await fixture(),gm=await f.join('GM'),p=await f.join('英美苏');await gm.call('seat',{kind:'gm'});
 await p.call('seat',{kind:'player',seat:'united_states'});for(const seat of ['united_states','united_kingdom','soviet_union'])await p.call('binding',seat,true);
 const state=createGame('repeat-air-defense',1,'FULL',false,false,false);state.phase='PLAY';state.status='PLAYING';state.round=1;state.settings.ignoreOtherPlayerInterrupts=false;
 for(const d of Object.values(state.decks)){d.drawPile.push(...d.hand,...d.active,...d.faceDown);d.hand=[];d.active=[];d.faceDown=[];}
 state.units=[{id:'de',country:'germany',type:'army',regionId:'germany'},{id:'uk',country:'united_kingdom',type:'army',regionId:'western_europe'},{id:'air',country:'united_kingdom',type:'air',regionId:'western_europe'}];
 function begin(){const deck=state.decks.germany;deck.drawPile.push(...deck.resolving.splice(0));const card=deck.drawPile.splice(deck.drawPile.findIndex(c=>c.definitionId==='land_battle'),1)[0];deck.hand.push(card);startResolution(state,'攻击','germany',[{kind:'action',country:'germany',action:'land_battle',regions:['western_europe'],label:'攻击西欧'}],[],card.id,'discardPile',true);for(let n=0;n<6&&state.resolution?.choice?.kind==='ACTION';n++){const c=state.resolution.choice;resolveChoice(state,c.seat,c.id,[c.options[0].id]);}expect(state.resolution!.choice!.kind).toBe('AIR_DEFENSE');}
 async function publish(){const save=responsePreset('guided-battle','repeat-air-defense');save.state=structuredClone(state);save.replayBase=structuredClone(state);await gm.call('importSave',JSON.stringify(save));}
 begin();await publish();const first=p.snapshot.room.bindingAttention!.find(a=>a.kind==='response'&&a.seat==='united_kingdom')!;
 expect(first.text).toContain('空军防御');expect(p.snapshot.state!.resolution!.choice).toBeNull();
 await p.call('chatSend','我在美国视角');expect(p.snapshot.room.bindingAttention!.find(a=>a.kind==='response')!.key).toBe(first.key);
 const oldSerial=state.balanceResolutionSerial;state.resolution!.running=false;begin();expect(state.balanceResolutionSerial).toBe(oldSerial!+1);await publish();
 const second=p.snapshot.room.bindingAttention!.find(a=>a.kind==='response'&&a.seat==='united_kingdom')!;expect(second.key).not.toBe(first.key);
 await p.call('seat',{kind:'player',seat:'united_kingdom'});expect(p.snapshot.state!.resolution!.choice!.kind).toBe('AIR_DEFENSE');
});

it('chat storage survives room restart and failed writes never publish a message',async()=>{
 let messages:import('../src/network/protocol').ChatMessage[]=[],fail=false;
 const store={read:async()=>null,list:async()=>[],write:async()=>{}};
 const chatStore={read:async()=>structuredClone(messages),write:async(next:typeof messages)=>{if(fail)throw Error('disk failure');messages=structuredClone(next);}};
 const room=new Room(store,[],async()=>{},async()=>null,chatStore),user=await room.createIdentity('聊天用户');let snapshot:RoomSnapshot;
 await room.connect(user.token,'c',v=>{if(!('replaced' in v))snapshot=v;});
 const send=(text:string)=>room.request(user.token,{id:crypto.randomUUID(),connection:'c',epoch:snapshot.room.epoch,revision:null,method:'chatSend',args:[text]});
 await send('保留');fail=true;await expect(send('不能保存')).rejects.toThrow('disk failure');expect(snapshot!.room.chat).toHaveLength(1);
 const next=new Room(store,[user],async()=>{},async()=>null,chatStore);await next.connect(user.token,'new',v=>{if(!('replaced' in v))snapshot=v;});expect(snapshot!.room.chat![0].text).toBe('保留');
});

it('identity checks do not connect users or replace their active page',async()=>{
 const f=await fixture(),p=await f.join('用户');
 expect(f.room.identityStatus([p.identity.token,'invalid'])).toEqual([{token:p.identity.token,valid:true,online:true},{token:'invalid',valid:false,online:false}]);
 expect(p.replaced).toBe(false);await p.disconnect();expect(f.room.identityStatus([p.identity.token])[0]).toMatchObject({valid:true,online:false});
});
it('chat tones are assigned at send time and surviving messages retain them after deletion',async()=>{
 const f=await fixture(),gm=await f.join('GM');await gm.call('seat',{kind:'gm'});
 for(const text of ['a','b','c'])await gm.call('chatSend',text);
 expect(gm.snapshot.room.chat!.map(m=>m.tone)).toEqual([0,1,0]);
 const middle=gm.snapshot.room.chat![1];await gm.call('chatDelete',gm.snapshot.room.chat![2].id);
 await gm.call('chatSend','d');expect(gm.snapshot.room.chat!.map(m=>m.tone)).toEqual([0,1,1]);
 await gm.call('chatDelete',gm.snapshot.room.chat![0].id);expect(gm.snapshot.room.chat![0]).toEqual(middle);
});
