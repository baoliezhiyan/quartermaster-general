import {it,expect} from 'vitest';
import {Room} from '../src/network/Room';
import {LocalAiAdapter} from '../src/localAi/adapter';
import {observePlayer,offersFor} from '../src/localAi/observation';
import {compileOffer} from '../src/localAi/contract';
import {createGame,SEATS} from '../src/core';
import {startResolution} from '../src/core/resolution';
import type {GameState} from '../src/core';
import type {RoomSnapshot} from '../src/network/protocol';
async function fixture(allies=false){
 const room=new Room({read:async()=>null,write:async()=>{},list:async()=>[]},[],async()=>{},async()=>null);
 const gm=await room.createIdentity('GM'),ai=await room.createIdentity('AI');let g:RoomSnapshot,player:RoomSnapshot;
 await room.connect(gm.token,'gm',v=>{if(!('replaced'in v))g=v;});await room.connect(ai.token,'human-setup',v=>{if(!('replaced'in v))player=v;});
 const request=(token:string,connection:string,method:string,args:unknown[],snapshot:RoomSnapshot)=>room.request(token,{id:crypto.randomUUID(),connection,epoch:snapshot.room.epoch,revision:snapshot.state?.revision??null,method,args});
 const admin=(method:string,...args:unknown[])=>request(gm.token,'gm',method,args,g!);
 await admin('seat',{kind:'gm'});await request(ai.token,'human-setup','seat',[{kind:'player',seat:allies?'united_kingdom':'germany'}],player!);
 for(const seat of allies?['united_kingdom','soviet_union','united_states']:['germany','italy','japan'])await request(ai.token,'human-setup','binding',[seat,true],player!);
 await admin('dispatch',{type:'CREATE_GAME',gameId:'ai-interface-test',seed:17,mode:'FULL',prelude:false,balance:true});
 const adapter=new LocalAiAdapter(room);await adapter.connect(ai.token);
 return {room,adapter,token:ai.token,admin,get state(){return g!.state!;}};
}
function request(o:Awaited<ReturnType<LocalAiAdapter['observe']>>,offerId:string,selections:Record<string,string[]>={}){return {requestId:crypto.randomUUID(),gameId:o.gameId!,epoch:o.epoch,revision:o.revision!,offerId,selections};}
it('summarizes three lawful seats without hidden order, seed, opponent private cards or rollback state',async()=>{
 const f=await fixture(),o=await f.adapter.observe(f.token);expect(o.bindings).toEqual(['germany','japan','italy']);if(!('privateCountries'in o))throw Error();
 const serialized=JSON.stringify(o);expect(serialized).not.toContain('randomState');expect(serialized).not.toContain('rollback');expect(serialized).not.toContain('extraRollback');
 for(const seat of ['united_kingdom','soviet_union','united_states'] as const)for(const c of f.state.decks[seat].hand)expect(serialized).not.toContain(c.id);
 for(const seat of o.bindings){const ids=o.privateCountries[seat].deckComposition.map(c=>c.id);expect(ids).toEqual([...f.state.decks[seat].drawPile].sort((a,b)=>a.definitionId.localeCompare(b.definitionId)||a.id.localeCompare(b.id)).map(c=>c.id));}
 const before=JSON.stringify(f.state);await f.adapter.observe(f.token);await f.adapter.wait(f.token,o.sequence,5);expect(JSON.stringify(f.state)).toBe(before);
});
it('opening through ordinary permission path is identical to client, duplicate does not execute twice, stale/foreign/invalid reject',async()=>{
 const f=await fixture();const o=await f.adapter.observe(f.token),offer=o.offers.find(x=>x.seat==='italy')!;
 const ids=offer.selections!.cardIds.ids.slice(0,7),r=request(o,offer.id,{cardIds:ids});
 const [result,concurrent]=await Promise.all([f.adapter.submit(f.token,r),f.adapter.submit(f.token,r)]);expect(concurrent.result).toEqual(result.result);expect(result.result).toMatchObject({ok:true});expect(f.state.setupCompleted).toContain('italy');
 const before=JSON.stringify(f.state);expect((await f.adapter.submit(f.token,r)).result).toEqual(result.result);expect(JSON.stringify(f.state)).toBe(before);
 await expect(f.adapter.submit(f.token,{...r,requestId:crypto.randomUUID()})).rejects.toMatchObject({code:'STALE'});
 const now=await f.adapter.observe(f.token);
 await expect(f.adapter.submit(f.token,{...request(now,now.offers[0].id),gameId:'other'})).rejects.toMatchObject({code:'WRONG_GAME'});
 await expect(f.adapter.submit(f.token,request(now,'united_states:opening'))).rejects.toMatchObject({code:'ILLEGAL_CHOICE'});
 await expect(f.adapter.submit(f.token,request(now,now.offers[0].id,{cardIds:['invented']}))).rejects.toMatchObject({code:'ILLEGAL_CHOICE'});
 expect(JSON.stringify(f.state)).toBe(before);
 await f.adapter.disconnect(f.token);await expect(f.adapter.observe(f.token)).rejects.toMatchObject({code:'DISCONNECTED'});await f.adapter.connect(f.token);expect((await f.adapter.observe(f.token)).gameId).toBe(o.gameId);
});
it('ordinary attack can be completed via the interface with inserted enemy air defense',async()=>{
 const f=await fixture();
 const {responsePreset}=await import('../src/controller/responsePresets');
 await f.admin('importSave',JSON.stringify(responsePreset('guided-battle','ai-interface-test')));
 let o=await f.adapter.observe(f.token);const play=o.offers.find(x=>x.command.type==='PLAY_CARD'&&String(x.command.cardId).includes('land_battle'))!;expect(play).toBeTruthy();
 expect((await f.adapter.submit(f.token,request(o,play.id))).result).toMatchObject({ok:true});
 let waiting=false;
 for(let i=0;i<25;i++){
  o=await f.adapter.observe(f.token);const choice=o.offers.find(x=>x.command.type==='RESOLVE_ENGINE_CHOICE'&&x.selections);
  if(!choice){waiting=true;break;}
  const spec=choice.selections!.ids,decision='decisions'in o?o.decisions[0]:null;
  const preferred=decision?.options.find(x=>x.regionId==='western_europe');
  await f.adapter.submit(f.token,request(o,choice.id,{ids:spec.min?[preferred?.id??spec.ids[0]]:[]}));
 }
 expect(waiting).toBe(true);expect(f.state.activeSeat).toBe('germany');
 expect(f.state.resolution!.choice!.seat).toBe('united_kingdom');expect(f.state.resolution!.choice!.kind).toBe('AIR_DEFENSE');
 // Human player's ordinary response, never an AI impersonation.
 const q=f.state.resolution!.choice!;await f.admin('dispatch',{type:'RESOLVE_ENGINE_CHOICE',seat:q.seat,expectedRevision:f.state.revision,choiceId:q.id,ids:[],guided:true});
 for(let i=0;i<35;i++){
  o=await f.adapter.observe(f.token);const choice=o.offers.find(x=>x.command.type==='RESOLVE_ENGINE_CHOICE'&&x.selections&&x.selections);if(!choice){const q=f.state.resolution?.choice;if(q){expect(q.seat).toBe('united_kingdom');await f.admin('dispatch',{type:'RESOLVE_ENGINE_CHOICE',seat:q.seat,expectedRevision:f.state.revision,choiceId:q.id,ids:q.options.slice(0,q.min).map(o=>o.id),guided:true});continue;}break;}
  const spec=choice.selections!.ids;expect((await f.adapter.submit(f.token,request(o,choice.id,{ids:spec.ids.slice(0,spec.min)}))).result).toMatchObject({ok:true});
 }
 expect(f.state.resolution?.running).toBe(false);
});
it('out-of-turn bound Britain answers the human Germany attack',async()=>{
 const f=await fixture(true);const {responsePreset}=await import('../src/controller/responsePresets');await f.admin('importSave',JSON.stringify(responsePreset('guided-battle','ai-interface-test')));
 const c=f.state.decks.germany.hand.find(c=>c.definitionId==='land_battle')!;
 await f.admin('dispatch',{type:'PLAY_CARD',seat:'germany',expectedRevision:f.state.revision,cardId:c.id,effectIndices:[0],targetIds:[],guided:true});
 for(let i=0;i<15&&f.state.resolution?.choice?.seat==='germany';i++){const q=f.state.resolution.choice;await f.admin('dispatch',{type:'RESOLVE_ENGINE_CHOICE',seat:q.seat,expectedRevision:f.state.revision,choiceId:q.id,ids:[q.options.find(o=>o.id==='western_europe')?.id??q.options[0].id],guided:true});}
 expect(f.state.resolution!.choice!.kind).toBe('AIR_DEFENSE');
 const o=await f.adapter.observe(f.token),choice=o.offers.find(x=>x.command.type==='RESOLVE_ENGINE_CHOICE'&&x.selections)!;expect(choice.seat).toBe('united_kingdom');
 const spec=choice.selections!.ids;expect((await f.adapter.submit(f.token,request(o,choice.id,{ids:spec.ids.slice(0,spec.min)}))).result).toMatchObject({ok:true});
});
function game():GameState {const s=createGame('read',42,'FULL',true,false,true);s.prelude!.active=false;s.status='PLAYING';s.phase='PLAY';s.round=1;s.setupCompleted=[...SEATS];return s;}
const meta={epoch:'e',sequence:1,serverId:'server',userId:'ai',name:'AI',locked:false,replay:false};
it('exposes precise ordered multi-select, cost constraints and read-only context without enemy menus',()=>{
 const s=game();startResolution(s,'sorting','germany',[{kind:'cards',seat:'germany',from:'drawPile',to:'drawPile',bottom:true,min:2,max:2,order:true,label:'选择排序两张牌'}],[]);
 const o=observePlayer(s,['germany','italy','japan'],meta),offer=o.offers.find(x=>x.command.type==='RESOLVE_ENGINE_CHOICE'&&x.selections)!;expect(offer.selections!.ids).toMatchObject({min:2,max:2,ordered:true});
 const ids=offer.selections!.ids.ids.slice(0,2).reverse();expect(compileOffer(o.offers,request(o,offer.id,{ids}))).toMatchObject({ids,guided:true});
 const foreign=observePlayer(s,['united_states'],meta);expect(JSON.stringify(foreign)).not.toContain(s.resolution!.choice!.options[0].id);
});
it('unsupported modes stop explicitly and prelude targets use only the shown top',()=>{
 const s=game();s.prelude!.active=true;const p=s.prelude!.decks.germany;const offers=offersFor(s,'germany');expect(offers.filter(o=>o.command.type==='PLAY_PRELUDE').map(o=>o.command.cardId)).toEqual([...p.hand,...p.drawPile.slice(0,1)].map(c=>c.id));
 s.mode='BASIC_DEBUG';expect(observePlayer(s,['germany'],meta).status).toBe('unsupported');expect(observePlayer(s,['germany'],meta).offers).toEqual([]);
});
it('payment, deck search and ordered return execute through the bridge without resource-pool semantics',async()=>{
 const f=await fixture();const {responsePreset}=await import('../src/controller/responsePresets');const saved=responsePreset('guided-battle','ai-interface-test'),s=saved.state;
 const beforeHand=s.decks.germany.hand.length,beforeDeck=s.decks.germany.drawPile.length;
 startResolution(s,'constructed cost-search-order','germany',[
 {kind:'cards',seat:'germany',from:'hand',to:'discardPile',min:1,max:1,fee:true,label:'支付一张手牌'},
 {kind:'cards',seat:'germany',from:'drawPile',to:'hand',filter:'状态',min:1,max:1,label:'检索状态'},
 {kind:'cards',seat:'germany',from:'hand',to:'drawPile',bottom:true,order:true,min:2,max:2,label:'两张牌按选择顺序放牌库底'}],[]);
 saved.replayBase=structuredClone(s);await f.admin('importSave',JSON.stringify(saved));
 let last:string[]=[];
 for(let i=0;i<3;i++){const o=await f.adapter.observe(f.token),offer=o.offers.find(x=>x.command.type==='RESOLVE_ENGINE_CHOICE'&&x.selections)!;expect(offer).toBeTruthy();const spec=offer.selections!.ids;last=spec.ids.slice(0,spec.min).reverse();expect((await f.adapter.submit(f.token,request(o,offer.id,{ids:last}))).result).toMatchObject({ok:true});}
 expect(f.state.resolution?.running).toBe(false);expect(f.state.decks.germany.hand).toHaveLength(beforeHand-2);expect(f.state.decks.germany.drawPile).toHaveLength(beforeDeck+1);expect(f.state.decks.germany.drawPile.slice(-2).map(c=>c.id)).toEqual(last);
});
it('unknown identity, GM identity and mixed alliance cannot obtain AI observation',async()=>{
 const f=await fixture();await expect(f.adapter.connect('invalid')).rejects.toThrow();
 const u=await f.room.createIdentity('unbound');await expect(f.adapter.connect(u.token)).rejects.toThrow('AI_REQUIRES_BOUND_ALLIANCE');
});
it('bridge and ordinary Room submission produce the same representative state',async()=>{
 const ai=await fixture(),normal=await fixture(),o=await ai.adapter.observe(ai.token),offer=o.offers.find(x=>x.seat==='italy')!,ids=offer.selections!.cardIds.ids.slice(0,7);
 await ai.adapter.submit(ai.token,request(o,offer.id,{cardIds:ids}));
 let snap:RoomSnapshot;await normal.room.connect(normal.token,'comparison',v=>{if(!('replaced'in v))snap=v;});
 const call=(method:string,args:unknown[])=>normal.room.request(normal.token,{id:crypto.randomUUID(),connection:'comparison',epoch:snap!.room.epoch,revision:snap!.state?.revision??null,method,args});
 await call('seat',[{kind:'player',seat:'italy'}]);expect(await call('dispatch',[{type:'KEEP_OPENING',seat:'italy',expectedRevision:snap!.state!.revision,cardIds:ids}])).toMatchObject({ok:true});
 for(const key of ['decks','units','scores','phase','round','activeSeat','randomState','setupCompleted'] as const)expect(ai.state[key]).toEqual(normal.state[key]);
});
