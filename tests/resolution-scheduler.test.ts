import {stateHash} from '../src/actionReplay/state';
import {it,expect} from 'vitest';
import {createGame} from '../src/core/game';
import {startResolution,resolveChoice} from '../src/core/resolution';
import {specialCard} from '../src/core/cardCatalog';
import {validateState} from '../src/controller/saveFormat';
import {projectState} from '../src/network/project';
import {resolutionTargets} from '../src/ui/map/targetChoices';
import type {GameState,SeatId} from '../src/core';
import {Room} from '../src/network/Room';
import type {RoomSnapshot,RoomRequest} from '../src/network/protocol';
import type {SaveSession} from '../src/controller/saveFormat';
import type {TriggerRule} from '../src/core/resolutionTypes';

function game(seat:SeatId='germany'){
 const s=createGame('scheduler',1940,'FULL',true);s.prelude!.active=false;s.phase='PLAY';s.status='PLAYING';s.round=2;s.activeSeat=s.viewSeat=s.operatorSeat=seat;s.settings.ignoreOtherPlayerInterrupts=false;
 for(const d of Object.values(s.decks)){d.drawPile.push(...d.hand,...d.active,...d.faceDown);d.hand=[];d.active=[];d.faceDown=[];}
 return s;
}
function add(s:GameState,id:string,zone:'active'|'hand'|'faceDown'){
 const d=specialCard(id)!;const deck=s.decks[d.deckOwner],index=deck.drawPile.findIndex(c=>c.definitionId===id);const c=deck.drawPile.splice(index,1)[0];expect(c).toBeTruthy();deck[zone].push(c);return c;
}
function choose(s:GameState,label?:string){const c=s.resolution!.choice!;expect(c).toBeTruthy();const o=label?c.options.find(o=>o.id===label||o.label===label):undefined;if(label)expect(o,JSON.stringify(c)).toBeDefined();expect(resolveChoice(s,c.seat,c.id,o?[o.id]:[])).toBe(true);}
function actions(s:GameState,region:string){for(let n=0;n<10&&s.resolution?.choice?.kind==='ACTION';n++){const c=s.resolution.choice;choose(s,c.options.find(o=>o.id===region)?.id??c.options[0].id);}}
function settle(s:GameState){for(let i=0;i<80&&s.resolution?.choice;i++){const c=s.resolution.choice;choose(s,c.min?c.options[0].id:undefined);}expect(s.resolution?.running).toBe(false);}
function blitz(){
 const s=game();add(s,'special_134','active');add(s,'special_136','active');
 s.units=[{id:'g',country:'germany',type:'army',regionId:'germany'},{id:'e',country:'germany',type:'army',regionId:'eastern_europe'},{id:'u',country:'soviet_union',type:'army',regionId:'ukraine'},{id:'b',country:'soviet_union',type:'army',regionId:'balkans'}];
 startResolution(s,'陆攻','germany',[{kind:'action',country:'germany',action:'land_battle',regions:['balkans'],label:'攻击A'}],[]);actions(s,'balkans');choose(s,'俯冲式轰炸机');actions(s,'ukraine');return s;
}
it.each(['balkans','ukraine'])('merged Blitzkrieg builds in %s and charges once',region=>{
 const s=blitz(),before=s.decks.germany.drawPile.length;
 expect(s.resolution!.choice!.options.filter(o=>o.label==='闪电战')).toHaveLength(1);
 choose(s,'闪电战');expect(s.resolution!.choice!.options.map(o=>o.id).sort()).toEqual(['balkans','ukraine']);
 const view=projectState(s,{kind:'player',seat:'germany'},'germany')!;
 expect(resolutionTargets(view).map(o=>o.regionId).sort()).toEqual(['balkans','ukraine']);
 choose(s,region);settle(s);
 expect(s.units.some(u=>u.country==='germany'&&u.regionId===region)).toBe(true);
 expect(s.decks.germany.drawPile.length).toBe(before-1);
 expect(s.resolution!.frames.filter(f=>f.cardId==='germany:special_136')).toHaveLength(1);
 expect(s.resolution!.events.filter(e=>e.effect?.kind==='action'&&e.effect.action==='land_battle').every(e=>e.outcome==='succeeded')).toBe(true);
});
it('merged target request survives serialization and rejects foreign/stale targets without paying',()=>{
 const s=blitz();choose(s,'闪电战');const copy=JSON.parse(JSON.stringify(s)) as GameState;validateState(copy);
 const c=copy.resolution!.choice!,before=JSON.stringify(copy);
 expect(resolveChoice(copy,'japan',c.id,['balkans'])).toBe(false);expect(resolveChoice(copy,c.seat,c.id,['moscow'])).toBe(false);expect(JSON.stringify(copy)).toBe(before);
 choose(copy,'ukraine');settle(copy);choose(s,'ukraine');settle(s);expect(copy).toEqual(s);
});
function scoring(){const s=game();s.phase='SCORE';add(s,'special_131','active');add(s,'special_139','active');add(s,'special_37','faceDown');add(s,'special_17','faceDown');s.decks.united_kingdom.hand.push(...s.decks.united_kingdom.drawPile.splice(0,2));s.units=[{id:'n',country:'germany',type:'navy',regionId:'sea_baltic'},{id:'u',country:'germany',type:'army',regionId:'ukraine'}];startResolution(s,'计分','germany',[{kind:'signal',tag:'PHASE:SCORE',label:'计分开始'}],[]);return s;}
it('scoring offers all Calm targets before any score, then all eligible Enigma targets after scores',()=>{
 const s=scoring(),c=s.resolution!.choice!;expect(c.seat).toBe('united_kingdom');expect(c.options).toHaveLength(2);expect(c.options.every(o=>o.label.startsWith('保持冷静，继续前进 →'))).toBe(true);expect(s.scores.germany).toBe(0);
 choose(s);expect(s.scores.germany).toBe(2);expect(s.resolution!.choice!.options).toHaveLength(2);expect(s.resolution!.choice!.options.every(o=>o.label.startsWith('破译恩尼格玛密码 →'))).toBe(true);
 choose(s,s.resolution!.choice!.options[0].id);settle(s);expect(s.scores.germany).toBe(2);expect(s.decks.germany.discardPile.filter(c=>['special_131','special_139'].includes(c.definitionId))).toHaveLength(1);
});
it.each([0,1])('Calm cancels chosen batch member %s without losing the other member',index=>{
 const s=scoring(),choice=s.resolution!.choice!;choose(s,choice.options[index].id);
 expect(s.resolution!.choice!.kind).toBe('PAY_COST');choose(s,s.resolution!.choice!.options[0].id);
 expect(s.scores.germany).toBe(1);expect(s.resolution!.choice!.options).toHaveLength(1);expect(s.resolution!.choice!.options[0].label).toContain('破译恩尼格玛密码');choose(s);settle(s);
 expect(s.decks.germany.active.filter(c=>['special_131','special_139'].includes(c.definitionId))).toHaveLength(2);
 expect(s.resolution!.frames.filter(f=>f.scoreBatchId).every(f=>f.status==='COMPLETE')).toBe(true);
});
it('batch before/fee/after decisions resume identically from serialized snapshots',()=>{
 const original=scoring();
 for(let n=0;n<20&&original.resolution?.choice;n++){
  const restored=JSON.parse(JSON.stringify(original)) as GameState,c=original.resolution.choice;validateState(restored);
  const ids=c.min||n===0?[c.options[0].id]:[];
  expect(resolveChoice(original,c.seat,c.id,ids)).toBe(true);expect(resolveChoice(restored,c.seat,c.id,ids)).toBe(true);expect(restored).toEqual(original);
 }
 expect(original.resolution!.running).toBe(false);
});
it('restricted network views omit internal batch state and opponent responses',()=>{
 const s=scoring(),de=projectState(s,{kind:'player',seat:'germany'},'germany')!,uk=projectState(s,{kind:'player',seat:'united_kingdom'},'united_kingdom')!;
 expect(de.resolution!.choice).toBeNull();expect(de.resolution!.scoreBatches).toBeUndefined();expect(JSON.stringify(de.resolution)).not.toContain('united_kingdom:special_37');expect(uk.resolution!.choice!.options).toHaveLength(2);
});
it('a multi-effect status completes after its last effect, not after its first score',()=>{
 const s=game(),card=add(s,'special_134','active');add(s,'special_17','faceDown');
 startResolution(s,'俯冲式轰炸机','germany',[{kind:'score',seat:'germany',amount:1,label:'子效果一'},{kind:'score',seat:'germany',amount:2,label:'子效果二'}],[],card.id,'active');
 expect(s.scores.germany).toBe(3);expect(s.resolution!.choice!.options[0].label).toBe('破译恩尼格玛密码');
 const events=s.resolution!.events.filter(e=>e.effect?.kind==='score');expect(events).toHaveLength(2);expect(events.every(e=>e.started&&e.ended&&e.outcome==='succeeded')).toBe(true);
 expect(s.events.filter(e=>e.type==='RULE_EVENT'&&e.code==='CARD_OWN_EFFECTS_COMPLETE'&&e.text.includes('俯冲'))).toHaveLength(1);choose(s);settle(s);
 expect(s.events.filter(e=>e.type==='RULE_EVENT'&&e.code==='CARD_OWN_EFFECTS_COMPLETE'&&e.text.includes('俯冲'))).toHaveLength(1);
});
it('an invalid last subeffect has a terminal record and does not invent a success trigger',()=>{
 const s=game(),card=add(s,'special_134','active');s.units=[];
 startResolution(s,'多段测试','germany',[{kind:'score',seat:'germany',amount:1,label:'首段'},{kind:'action',country:'germany',action:'land_battle',regions:['moscow'],label:'无法发起'}],[],card.id,'active');
 expect(s.resolution!.events.find(e=>e.label==='无法发起')).toMatchObject({outcome:'invalid',ended:true,started:false,applied:false});expect(s.resolution!.running).toBe(false);expect(s.scores.germany).toBe(1);
});
it.each(['japan','italy'] as SeatId[])('pure %s scores use one pre-score response batch without owner sorting',seat=>{
 const s=game(seat);s.phase='SCORE';for(const id of seat==='japan'?['special_172','special_173','special_174','special_175']:['special_212','special_214','special_216','special_217'])add(s,id,'active');
 add(s,'special_37','faceDown');s.decks.united_kingdom.hand.push(s.decks.united_kingdom.drawPile.shift()!);
 startResolution(s,'计分',seat,[{kind:'signal',tag:'PHASE:SCORE',label:'计分开始'}],[]);
 expect(s.resolution!.choice!.seat).toBe('united_kingdom');expect(s.resolution!.choice!.options).toHaveLength(4);choose(s);settle(s);expect(s.resolution!.scoreBatches).toHaveLength(1);
});
it('optional scoring remains an explicit choice outside the mandatory score batch',()=>{
 const s=game('italy');s.phase='SCORE';add(s,'special_212','active');add(s,'special_217','active');add(s,'special_225','hand');
 startResolution(s,'计分','italy',[{kind:'signal',tag:'PHASE:SCORE',label:'计分开始'}],[]);
 expect(s.resolution!.choice!.seat).toBe('italy');expect(s.resolution!.choice!.options.map(o=>o.label)).toContain(specialCard('special_225')!.name);choose(s);settle(s);
});
it('corrupt batch and merged-target references are rejected by save validation',()=>{
 const s=scoring();s.resolution!.scoreBatches![0].frameIds.push('missing');expect(()=>validateState(s)).toThrow();
 const b=blitz();choose(b,'闪电战');b.resolution!.choice!.triggerTargets!.balkans.ruleId='missing';expect(()=>validateState(b)).toThrow();
});
async function roomFixture(state:GameState){
 let saved:SaveSession|null=null;const store={read:async()=>saved,write:async(value:SaveSession)=>{saved=structuredClone(value);},list:async()=>[]};
 const room=new Room(store,[],async()=>{},async()=>null);
 async function peer(name:string,access:{kind:'gm'}|{kind:'player';seat:SeatId}){
  const identity=await room.createIdentity(name);let snapshot!:RoomSnapshot;let connection=crypto.randomUUID();
  const receive=(value:RoomSnapshot|{replaced:true})=>{if(!('replaced' in value))snapshot=value;};await room.connect(identity.token,connection,receive);
  const request=(method:string,...args:unknown[]):RoomRequest=>({id:crypto.randomUUID(),connection,epoch:snapshot.room.epoch,revision:snapshot.state?.revision??null,method,args});
  const call=(method:string,...args:unknown[])=>room.request(identity.token,request(method,...args));await call('seat',access);
  return {get snapshot(){return snapshot;},call,request,raw:(r:RoomRequest)=>room.request(identity.token,r),reconnect:async()=>{await room.disconnect(identity.token,connection);connection=crypto.randomUUID();await room.connect(identity.token,connection,receive);}};
 }
 const gm=await peer('GM',{kind:'gm'}),de=await peer('DE',{kind:'player',seat:'germany'}),uk=await peer('UK',{kind:'player',seat:'united_kingdom'});
 const session:SaveSession={format:'quartermaster-save',version:1,updatedAt:new Date().toISOString(),state,replayBase:structuredClone(state),rounds:[],nations:[],undo:[],commands:[]};
 await gm.call('importSave',JSON.stringify(session));return {gm,de,uk};
}
it('multiplayer batch survives reconnect/save/reload and duplicate commands do not score twice',async()=>{
 const {gm,de,uk}=await roomFixture(scoring());expect(de.snapshot.state!.resolution!.choice).toBeNull();await uk.reconnect();
 const s=uk.snapshot.state!,c=s.resolution!.choice!;expect(c.options).toHaveLength(2);
 const request=uk.request('dispatch',{type:'RESOLVE_ENGINE_CHOICE',seat:'united_kingdom',expectedRevision:s.revision,choiceId:c.id,ids:[]});
 expect(await uk.raw(request)).toMatchObject({ok:true});expect(await uk.raw(request)).toMatchObject({ok:true});expect(uk.snapshot.state!.scores.germany).toBe(2);
 const hashBefore=await stateHash(gm.snapshot.state! as GameState);const save=await gm.call('exportSave');await gm.call('importSave',save);expect(await stateHash(gm.snapshot.state! as GameState)).toBe(hashBefore);expect(uk.snapshot.state!.resolution!.choice!.options).toHaveLength(2);
 const next=uk.snapshot.state!,choice=next.resolution!.choice!;expect(await uk.call('dispatch',{type:'RESOLVE_ENGINE_CHOICE',seat:'united_kingdom',expectedRevision:next.revision,choiceId:choice.id,ids:[choice.options[0].id]})).toMatchObject({ok:true});
 expect(uk.snapshot.state!.scores.germany).toBe(2);expect(await gm.call('checkReplay')).toBe(true);
});
it('multiplayer merged map targets remain selectable after reconnect and save reload',async()=>{
 const s=blitz();choose(s,'闪电战');const {gm,de}=await roomFixture(s);await de.reconnect();
 expect(resolutionTargets(de.snapshot.state!).map(t=>t.id).sort()).toEqual(['balkans','ukraine']);await gm.call('importSave',await gm.call('exportSave'));
 const state=de.snapshot.state!,c=state.resolution!.choice!;expect(await de.call('dispatch',{type:'RESOLVE_ENGINE_CHOICE',seat:'germany',expectedRevision:state.revision,choiceId:c.id,ids:['balkans']})).toMatchObject({ok:true});
 expect(de.snapshot.state!.units.some(u=>u.country==='germany'&&u.regionId==='balkans')).toBe(true);expect(await gm.call('checkReplay')).toBe(true);
});
it('guided merged activation can decline the fee and restore a usable target choice',()=>{
 const s=blitz();choose(s,'闪电战');const c=s.resolution!.choice!,count=s.decks.germany.drawPile.length;
 expect(resolveChoice(s,c.seat,c.id,['ukraine'],true)).toBe(true);expect(s.resolution!.choice!.kind).toBe('EFFECT_DECISION');choose(s);
 expect(s.resolution!.choice!.triggerTargets).toBeDefined();expect(s.decks.germany.drawPile.length).toBe(count);validateState(s);
 choose(s,'balkans');expect(s.resolution!.choice!.kind).toBe('EFFECT_DECISION');choose(s,'execute');settle(s);expect(s.units.some(u=>u.country==='germany'&&u.regionId==='balkans')).toBe(true);expect(s.decks.germany.drawPile.length).toBe(count-1);
});
it('selecting a sibling closes the abandoned descendant window',()=>{
 const s=game();const rule=(id:string,on:string,label:string):TriggerRule=>({id,label:id,sourceInstanceId:id,owner:'germany',timing:'After',on,mandatory:false,source:'system',effects:[{kind:'trace',label}]});
 startResolution(s,'root','germany',[{kind:'trace',label:'A'}],[rule('B','A','B-effect'),rule('C','A','C-effect'),rule('D','B-effect','D-effect')]);
 choose(s,'B');expect(s.resolution!.choice!.options.map(o=>o.label).sort()).toEqual(['C','D']);choose(s,'C');settle(s);
 expect(s.resolution!.trace.filter(x=>x.endsWith('-effect'))).toEqual(['B-effect','C-effect']);
});
it('declining a child window does not decline the same country in its ancestor window',()=>{
 const s=game();const rule=(id:string,on:string):TriggerRule=>({id,label:id,sourceInstanceId:id,owner:'germany',timing:'After',on,mandatory:false,source:'system',effects:[{kind:'trace',label:id}]});
 startResolution(s,'root','germany',[{kind:'trace',label:'A'}],[rule('B','A'),rule('C','A'),rule('D','B')]);choose(s,'B');choose(s);expect(s.resolution!.choice!.options.map(o=>o.label)).toEqual(['C']);choose(s,'C');settle(s);expect(s.resolution!.trace).not.toContain('D');
});
it.each(Array.from({length:12},(_,i)=>i))('batch branch %i has unique completion and card conservation through every saved decision',branch=>{
 const s=scoring(),initial=Object.values(s.decks).flatMap(d=>Object.values(d).flat()).map(c=>c.id).sort();
 for(let n=0;n<30&&s.resolution?.choice;n++){
  validateState(JSON.parse(JSON.stringify(s)));const c=s.resolution.choice;
  const selected=c.min?c.options[0].id:c.kind==='TRIGGER'&&(branch+n)%3!==0?c.options[(branch+n)%c.options.length].id:undefined;choose(s,selected);
 }
 expect(s.resolution!.running).toBe(false);expect(s.resolution!.frames.every(f=>f.status==='COMPLETE')).toBe(true);
 expect(Object.values(s.decks).flatMap(d=>Object.values(d).flat()).map(c=>c.id).sort()).toEqual(initial);
 expect(s.scores.germany).toBeGreaterThanOrEqual(1);expect(s.scores.germany).toBeLessThanOrEqual(2);
 for(const f of s.resolution!.frames.filter(f=>f.cardId))expect(s.events.filter(e=>e.type==='RULE_EVENT'&&e.code==='FINISH_CARD_RESOLUTION'&&e.text.startsWith(`【${f.source}】`))).toHaveLength(1);
});

it.each([false,true])('leaving Blitzkrieg construction for sibling dive bombers closes Synthetic Fuel (guided=%s)',guided=>{
 const s=game();add(s,'special_130','active');add(s,'special_134','active');add(s,'special_136','active');
 s.units=[{id:'g',country:'germany',type:'army',regionId:'germany'},{id:'e',country:'germany',type:'army',regionId:'eastern_europe'},{id:'r',country:'soviet_union',type:'army',regionId:'ross_region'},{id:'si',country:'soviet_union',type:'army',regionId:'siberia'}];
 startResolution(s,'陆攻','germany',[{kind:'action',country:'germany',action:'land_battle',regions:['ross_region'],label:'根攻击'}],[],undefined,undefined,guided);
 actions(s,'ross_region');choose(s,'闪电战');if(s.resolution?.choice?.kind==='EFFECT_DECISION')choose(s,'execute');actions(s,'ross_region');
 expect(s.resolution!.choice!.options.some(o=>o.label==='合成燃料')).toBe(true);
 choose(s,'俯冲式轰炸机');if(s.resolution?.choice?.kind==='EFFECT_DECISION')choose(s,'execute');actions(s,'siberia');
 expect(s.units.some(u=>u.id==='si')).toBe(false);
 expect(s.resolution!.choice?.options.some(o=>o.label==='合成燃料')??false).toBe(false);
 expect(s.resolution!.windows.some(w=>w.closeReason==='branch-left')).toBe(true);
 settle(s);expect(s.units.some(u=>u.country==='germany'&&u.regionId==='siberia')).toBe(false);
});
it('Synthetic Fuel remains usable inside Blitzkrieg construction before selecting a sibling',()=>{
 const s=game();add(s,'special_130','active');add(s,'special_134','active');add(s,'special_136','active');
 s.units=[{id:'g',country:'germany',type:'army',regionId:'germany'},{id:'e',country:'germany',type:'army',regionId:'eastern_europe'},{id:'r',country:'soviet_union',type:'army',regionId:'ross_region'}];
 startResolution(s,'陆攻','germany',[{kind:'action',country:'germany',action:'land_battle',regions:['ross_region'],label:'根攻击'}],[]);
 actions(s,'ross_region');choose(s,'闪电战');actions(s,'ross_region');choose(s,'合成燃料');actions(s,'siberia');
 expect(s.units.some(u=>u.country==='germany'&&u.regionId==='siberia')).toBe(true);settle(s);
});

it('a later printed sea battle cannot reopen the preceding naval construction window',()=>{
 const s=game('united_states');add(s,'special_84','active');
 s.units=[{id:'us',country:'united_states',type:'army',regionId:'hawaii'},{id:'n',country:'united_states',type:'navy',regionId:'sea_north_pacific'},{id:'j',country:'japan',type:'navy',regionId:'sea_central_pacific'}];
 startResolution(s,'先建后攻','united_states',[{kind:'action',country:'united_states',action:'build_navy',regions:['sea_east_pacific'],label:'建设海军'},{kind:'action',country:'united_states',action:'sea_battle',regions:['sea_central_pacific'],label:'后续海战'}],[]);
 actions(s,'sea_east_pacific');expect(s.resolution!.choice!.options.some(o=>o.label==='先进造船厂')).toBe(true);choose(s);actions(s,'sea_central_pacific');
 expect(s.resolution!.choice?.options.some(o=>o.label==='先进造船厂')??false).toBe(false);settle(s);
});
