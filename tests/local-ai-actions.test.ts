import {it,expect} from 'vitest';
import {Room} from '../src/network/Room';
import {LocalAiAdapter} from '../src/localAi/adapter';
import {observePlayer} from '../src/localAi/observation';
import {continuation} from '../src/localAi/action';
import {startResolution} from '../src/core/resolution';
import {SEATS,type GameState,type Unit} from '../src/core';
import {boardOptions} from '../src/core/boardEffects';
import type {RoomSnapshot} from '../src/network/protocol';
import type {ActionIntent} from '../src/localAi/contract';
const pause=(ms=5)=>new Promise(r=>setTimeout(r,ms));
async function fixture(allies=false,store?:import('../src/localAi/contract').ReceiptStore){
 const room=new Room({read:async()=>null,write:async()=>{},list:async()=>[]},[],async()=>{},async()=>null);const gm=await room.createIdentity('GM'),ai=await room.createIdentity('AI');let g:RoomSnapshot,p:RoomSnapshot;
 await room.connect(gm.token,'gm',v=>{if(!('replaced'in v))g=v;});await room.connect(ai.token,'setup',v=>{if(!('replaced'in v))p=v;});
 const call=(token:string,connection:string,s:RoomSnapshot,method:string,args:unknown[])=>room.request(token,{id:crypto.randomUUID(),connection,epoch:s.room.epoch,revision:s.state?.revision??null,method,args});
 const admin=(method:string,...args:unknown[])=>call(gm.token,'gm',g!,method,args);
 await admin('seat',{kind:'gm'});const seats=allies?['united_kingdom','soviet_union','united_states'] as const:['germany','japan','italy'] as const;
 await call(ai.token,'setup',p!,'seat',[{kind:'player',seat:seats[0]}]);for(const seat of seats)await call(ai.token,'setup',p!,'binding',[seat,true]);
 await admin('dispatch',{type:'CREATE_GAME',gameId:'action-test',seed:17,prelude:false,balance:true});const adapter=new LocalAiAdapter(room,store);await adapter.connect(ai.token);
 return {room,adapter,token:ai.token,admin,get state(){return g!.state!;},async scene(prepare:(s:GameState)=>void){const s=structuredClone(g!.state!);s.status='PLAYING';s.phase='PLAY';s.round=1;s.setupCompleted=[...SEATS];s.resolution=null;s.activeSeat=s.viewSeat=s.operatorSeat='germany';for(const d of Object.values(s.decks)){d.drawPile.push(...d.hand.splice(0),...d.active.splice(0),...d.faceDown.splice(0));}s.units=[unit('g','germany','army','germany'),unit('gi','germany','army','italy'),unit('uk','united_kingdom','army','western_europe'),unit('gn','germany','navy','sea_north_sea'),unit('un','united_kingdom','navy','sea_baltic')];prepare(s);await admin('importSave',JSON.stringify({format:'quartermaster-save',version:1,updatedAt:new Date().toISOString(),state:s,replayBase:structuredClone(s),commands:[],undo:[],rounds:[],nations:[]}));return s;}};
}
function unit(id:string,country:Unit['country'],type:Unit['type'],regionId:string):Unit{return {id,country,type,regionId};}
function give(s:GameState,id:string,zone:'hand'|'active'|'faceDown'='hand'){for(const d of Object.values(s.decks))for(const z of ['drawPile','hand'] as const){const i=d[z].findIndex(c=>c.definitionId===id);if(i>=0){const c=d[z].splice(i,1)[0];d[zone].push(c);return c;}}throw Error('missing '+id);}
async function action(f:Awaited<ReturnType<typeof fixture>>,type:string,intent:ActionIntent,extra?:string){const o=await f.adapter.observe(f.token),offer=o.offers.find(v=>v.command.type===type&&(!extra||v.command.cardId===extra||v.command.action===extra))!;expect(offer,JSON.stringify(o.offers)).toBeTruthy();return {requestId:crypto.randomUUID(),gameId:o.gameId!,epoch:o.epoch,revision:o.revision!,offerId:offer.id,intent};}
it.each(['build_army','build_navy','land_battle','sea_battle'])('merges %s using formal target and required attacker choices',async id=>{
 const f=await fixture();let cardId='';await f.scene(s=>{cardId=give(s,id).id;});const opts=boardOptions(f.state,{kind:'action',country:'germany',action:id as any,label:'test'});const opt=opts.find(o=>id.includes('battle')?!!o.defenderId:id==='build_army'?o.regionId==='eastern_europe':!o.existingId)!;expect(opt).toBeTruthy();
 const r=await action(f,'PLAY_CARD',{regionId:opt.regionId,defenderId:opt.defenderId??(id.includes('battle')?'empty':undefined),attackerId:opt.attackerId},cardId);const result=await f.adapter.submitAction(f.token,r);expect(result.receipt.status,JSON.stringify(result.receipt)).toBe('completed');
 expect(result.receipt.statistics.engineSteps).toBeGreaterThanOrEqual(2);const before=JSON.stringify(f.state);expect((await f.adapter.submitAction(f.token,r) as any).duplicate).toBe(true);expect(JSON.stringify(f.state)).toBe(before);expect((await f.adapter.result(f.token,r.requestId)).receipt.steps).toEqual(result.receipt.steps);
});
it.each(['deploy','supremacy','move'])('merges air %s without consuming unrequested choices',async mode=>{
 const f=await fixture();let cardId='';await f.scene(s=>{s.phase='AIR';cardId=give(s,'air_power').id;s.units.push(unit('ga','germany','air','germany'),unit('ua','united_kingdom','air','western_europe'));if(mode==='deploy')s.units=s.units.filter(u=>u.id!=='ga');});
 const r=await action(f,'SELECT_AIR_ACTION',{cardId,regionId:mode==='supremacy'?'western_europe':'italy',airId:mode==='deploy'?undefined:'ga',defenderId:mode==='supremacy'?'ua':undefined},mode);
 const result=await f.adapter.submitAction(f.token,r);expect(result.receipt.status,JSON.stringify(result.receipt)).toBe('completed');if(mode==='supremacy')expect(f.state.units.some(u=>u.id==='ua')).toBe(false);if(mode==='move')expect(f.state.units.find(u=>u.id==='ga')!.regionId).toBe('italy');if(mode==='deploy')expect(f.state.units.some(u=>u.country==='germany'&&u.type==='air'&&u.regionId==='italy')).toBe(true);
});
it('recycling is explicit; omission pauses and repeated construction remains a successful formal fact',async()=>{
 for(const specify of [false,true]){const f=await fixture();let cardId='';await f.scene(s=>{cardId=give(s,'build_army').id;s.units=['germany','italy','eastern_europe','balkans','ukraine','scandinavia','western_europe'].map((r,i)=>unit('army'+i,'germany','army',r));});
 const opt=boardOptions(f.state,{kind:'action',country:'germany',action:'build_army',label:'build'}).find(o=>o.recycleId&&!o.existingId)!;const result=await f.adapter.submitAction(f.token,await action(f,'PLAY_CARD',{regionId:opt.regionId,...(specify?{recycleId:opt.recycleId}:{})},cardId));expect(result.receipt.status).toBe(specify?'completed':'partial');if(!specify)expect(result.receipt.stopReason).toBe('ambiguous_parameters');}
 const f=await fixture();let id='';await f.scene(s=>{id=give(s,'build_army').id;});const r=await f.adapter.submitAction(f.token,await action(f,'PLAY_CARD',{regionId:'germany'},id));expect(r.receipt.steps.flatMap((s:any)=>s.placements).some((p:any)=>p.repeated)).toBe(true);
});
it('enemy air defense remains open; no auto-resume after human changes the target',async()=>{
 const f=await fixture();let id='';await f.scene(s=>{id=give(s,'land_battle').id;s.units.push(unit('ua','united_kingdom','air','western_europe'),unit('ga','germany','air','germany'));});
 const r=await action(f,'PLAY_CARD',{regionId:'western_europe',defenderId:'uk',attackerId:'g',airIntercept:true},id),out=await f.adapter.submitAction(f.token,r);expect(out.receipt.status).toBe('waiting_other');expect(f.state.resolution!.choice!.kind).toBe('AIR_DEFENSE');
 const q=f.state.resolution!.choice!;await f.admin('dispatch',{type:'RESOLVE_ENGINE_CHOICE',seat:q.seat,expectedRevision:f.state.revision,choiceId:q.id,ids:['yes'],guided:true});expect(f.state.resolution!.choice!.kind).toBe('AIR_INTERCEPT');
 const edited=structuredClone(f.state);edited.units=edited.units.filter(u=>u.id!=='g');await f.admin('editScene',edited);expect(f.state.units.some(u=>u.id==='uk')).toBe(true);const before=JSON.stringify(f.state);const retry=await f.adapter.submitAction(f.token,r);expect((retry as any).duplicate).toBe(true);expect(JSON.stringify(f.state)).toBe(before);
});
it('post-attack Blitzkrieg is a new decision and is never triggered or skipped',async()=>{
 const f=await fixture();let id='';await f.scene(s=>{id=give(s,'land_battle').id;give(s,'special_136','active');});const result=await f.adapter.submitAction(f.token,await action(f,'PLAY_CARD',{regionId:'western_europe',defenderId:'uk',attackerId:'g'},id));expect(result.receipt.stopReason).toBe('new_decision');expect(f.state.resolution!.choice!.kind).toBe('TRIGGER');expect(f.state.units.some(u=>u.country==='germany'&&u.regionId==='western_europe')).toBe(false);
});
it('wrong target rejects before mutation; missing selection pauses; stale requests cannot play twice',async()=>{
 const f=await fixture();let id='';await f.scene(s=>{id=give(s,'build_army').id;});const wrong=await action(f,'PLAY_CARD',{regionId:'united_states'},id),before=JSON.stringify(f.state);await expect(f.adapter.submitAction(f.token,wrong)).rejects.toThrow('AI_ILLEGAL_TARGET');expect(JSON.stringify(f.state)).toBe(before);
 const missing=await action(f,'PLAY_CARD',{},id);const r=await f.adapter.submitAction(f.token,missing);expect(r.receipt.stopReason).toBe('missing_selection');await expect(f.adapter.submitAction(f.token,{...missing,requestId:crypto.randomUUID()})).rejects.toMatchObject({code:'ILLEGAL_CHOICE'});
});
it('wait ignores ordinary log/chat events, cancellation is scoped, and own decisions deduplicate',async()=>{
 const f=await fixture();await f.scene(s=>{s.activeSeat=s.operatorSeat=s.viewSeat='united_kingdom';});const wait=f.adapter.waitDecision(f.token,{waitId:'cancel',leaseMs:1000});let done=false;wait.then(()=>done=true);
 for(let i=0;i<3;i++){await f.admin('chatSend','ordinary '+i);await pause();expect(done).toBe(false);}f.adapter.cancelWait(f.token,'cancel');expect((await wait).status).toBe('cancelled');
 const waiting=f.adapter.waitDecision(f.token,{waitId:'own',leaseMs:1000});const edited=structuredClone(f.state);edited.activeSeat=edited.operatorSeat=edited.viewSeat='germany';await f.admin('editScene',edited);expect((await waiting).status).toBe('resync_required');
 await f.scene(s=>{give(s,'build_army');});
 const first=await f.adapter.waitDecision(f.token,{waitId:'first',leaseMs:100});expect(first.status).toBe('decision');const again=await f.adapter.waitDecision(f.token,{waitId:'dedup',after:first.cursor,leaseMs:10});expect(again.leaseExpired).toBe(true);
});
it('status pays explicit hand fees and attacks; a single response pays then recruits without starting another trigger',async()=>{
 const f=await fixture(true);let status='',fees:string[]=[];await f.scene(s=>{s.activeSeat=s.operatorSeat=s.viewSeat='united_kingdom';status=give(s,'special_1','active').id;
 fees=[];for(const id of ['build_army','build_navy']){const d=s.decks.united_kingdom,i=d.drawPile.findIndex(c=>c.definitionId===id);const c=d.drawPile.splice(i,1)[0];d.hand.push(c);fees.push(c.id);}
 });
 const output=await f.adapter.submitAction(f.token,await action(f,'STATUS_ACTION',{feeCardIds:fees,regionId:'italy',defenderId:'gi',attackerId:'uk'},status));expect(output.receipt.status,JSON.stringify(output.receipt)).toBe('completed');expect(f.state.decks.united_kingdom.hand.filter(c=>fees.includes(c.id))).toHaveLength(0);
 const response=await fixture(true);let source='';await response.scene(s=>{s.phase='SCORE';s.activeSeat=s.operatorSeat=s.viewSeat='united_kingdom';source=give(s,'special_36','faceDown').id;const d=s.decks.united_kingdom;d.hand.push(d.drawPile.shift()!);
 startResolution(s,'score','united_kingdom',[{kind:'signal',tag:'PHASE:SCORE',label:'score'}],[]);});
 const o=await response.adapter.observe(response.token);const rule=response.state.resolution!.rules.find(r=>r.sourceInstanceId===source)!,q=response.state.resolution!.choice!,id=q.options.find(v=>v.id.endsWith('/'+rule.id))!.id;
 const offer=o.offers.find(v=>v.command.type==='RESOLVE_ENGINE_CHOICE'&&v.selections)!,fee=response.state.decks.united_kingdom.hand[0].id;
 const result=await response.adapter.submitAction(response.token,{requestId:crypto.randomUUID(),gameId:o.gameId!,epoch:o.epoch,revision:o.revision!,offerId:offer.id,selections:{ids:[id]},intent:{feeCardIds:[fee],regionId:'eastern_europe'}});expect(result.receipt.status,JSON.stringify(result.receipt)).toBe('completed');expect(response.state.units.some(u=>u.country==='united_kingdom'&&u.regionId==='eastern_europe')).toBe(true);
});
it('wait returns on the actual next owned decision, out-of-turn defense and return from an insertion',async()=>{
 const f=await fixture();await f.scene(s=>{s.phase='DRAW';s.activeSeat=s.operatorSeat=s.viewSeat='united_kingdom';});
 const pending=f.adapter.waitDecision(f.token,{waitId:'turn',leaseMs:1000});await f.admin('dispatch',{type:'ADVANCE_PHASE',seat:'united_kingdom',expectedRevision:f.state.revision});expect((await pending).status).toBe('decision');
 const a=await fixture(true);let id='';await a.scene(s=>{id=give(s,'land_battle').id;s.units.push(unit('ua','united_kingdom','air','western_europe'));});const outside=a.adapter.waitDecision(a.token,{waitId:'defense',leaseMs:1000});
 await a.admin('dispatch',{type:'PLAY_CARD',seat:'germany',expectedRevision:a.state.revision,cardId:id,targetIds:[],effectIndices:[0],guided:true});for(let i=0;i<10&&a.state.resolution?.choice?.seat==='germany';i++){const q=a.state.resolution.choice;const chosen=q.field==='regionId'?'western_europe':q.field==='defenderId'?'uk':q.field==='attackerId'?'g':q.options[0].id;await a.admin('dispatch',{type:'RESOLVE_ENGINE_CHOICE',seat:q.seat,expectedRevision:a.state.revision,choiceId:q.id,ids:[chosen],guided:true});}
 expect((await outside).status).toBe('decision');
 const g=await fixture();let land='';await g.scene(s=>{land=give(s,'land_battle').id;s.units.push(unit('ua','united_kingdom','air','western_europe'),unit('ga','germany','air','germany'));});const paused=await g.adapter.submitAction(g.token,await action(g,'PLAY_CARD',{regionId:'western_europe',defenderId:'uk',attackerId:'g',airIntercept:true},land));expect(paused.receipt.status).toBe('waiting_other');
 const returning=g.adapter.waitDecision(g.token,{waitId:'return',leaseMs:1000});const q=g.state.resolution!.choice!;await g.admin('dispatch',{type:'RESOLVE_ENGINE_CHOICE',seat:q.seat,expectedRevision:g.state.revision,choiceId:q.id,ids:['yes'],guided:true});const returned=await returning;expect(returned.status).toBe('decision');expect('decisions'in returned.observation!&&returned.observation.decisions[0].kind).toBe('AIR_INTERCEPT');
});
it('bundle and single steps preserve formal state and recorded command inputs',async()=>{
 const a=await fixture(),b=await fixture();let id='';for(const f of [a,b])await f.scene(s=>{id=give(s,'build_army').id;});const output=await a.adapter.submitAction(a.token,await action(a,'PLAY_CARD',{regionId:'eastern_europe'},id));
 for(const step of output.receipt.steps){const o=await b.adapter.observe(b.token);const result=await b.adapter.submit(b.token,{requestId:crypto.randomUUID(),gameId:o.gameId!,epoch:o.epoch,revision:o.revision!,offerId:step.offerId,selections:step.selections});expect(result.result).toMatchObject({ok:true});}
 for(const k of ['units','scores','decks','phase','round','randomState'] as const)expect(a.state[k]).toEqual(b.state[k]);
 const records=(text:unknown)=>String(text).trim().split('\n').map(t=>JSON.parse(t)).filter(r=>r.type==='action_group').map(r=>({kind:r.root.kind,input:r.root.input,choices:r.root.choices.map((c:any)=>({...c,at:{...c.at,actionId:undefined}}))}));const ar=records(await a.admin('exportReplay')),br=records(await b.admin('exportReplay'));expect(ar.length).toBeGreaterThan(0);expect(ar).toEqual(br);
});
it('reconnection never reruns a partial bundle, permission loss and superseding identity terminate waits',async()=>{
 const f=await fixture();let id='';await f.scene(s=>{id=give(s,'build_army').id;});const req=await action(f,'PLAY_CARD',{},id),done=await f.adapter.submitAction(f.token,req);await f.adapter.disconnect(f.token);await f.adapter.connect(f.token);const before=JSON.stringify(f.state);expect((await f.adapter.submitAction(f.token,req)).receipt.steps).toEqual(done.receipt.steps);expect(JSON.stringify(f.state)).toBe(before);
 const waiting=f.adapter.waitDecision(f.token,{waitId:'replaced',after:(await f.adapter.waitDecision(f.token,{waitId:'once',leaseMs:1})).cursor,leaseMs:1000});await f.room.connect(f.token,'browser',()=>{});expect(await waiting).toMatchObject({status:'unavailable',error:{code:'DISCONNECTED'}});
});
it('visible new information interrupts a predeclared status target and an unfinished receipt is never rerun after adapter replacement',async()=>{
 const records=new Map<string,any>(),store={read:async(k:string)=>records.get(k),write:async(k:string,v:unknown)=>{records.set(k,structuredClone(v));}};
 const f=await fixture(false,store);let id='';await f.scene(s=>{id=give(s,'special_135','active').id;});const req=await action(f,'STATUS_ACTION',{regionId:'eastern_europe',answers:[{kind:'EFFECT_DECISION',ids:['execute']}]},id),result=await f.adapter.submitAction(f.token,req);expect(result.receipt.stopReason).toBe('new_information');expect(f.state.units.some(u=>u.country==='germany'&&u.regionId==='eastern_europe')).toBe(false);
 const [key,saved]=[...records.entries()][0];saved.receipt.status='executing';saved.receipt.inFlightStep=req.requestId+'.1';records.set(key,saved);
 const replacement=new LocalAiAdapter(f.room,store);await replacement.connect(f.token);const before=JSON.stringify(f.state),recovered=await replacement.submitAction(f.token,req);expect(recovered.receipt.status).toBe('uncertain');expect(JSON.stringify(f.state)).toBe(before);await expect(replacement.submitAction(f.token,{...req,intent:{}})).rejects.toMatchObject({code:'DUPLICATE_CONFLICT'});
});
it('a stale bundle, a conflicting rejected request and missing attacker stop without unintended effect',async()=>{
 const f=await fixture();let id='';await f.scene(s=>{id=give(s,'land_battle').id;});const r=await action(f,'PLAY_CARD',{regionId:'western_europe',defenderId:'uk'},id);const out=await f.adapter.submitAction(f.token,r);expect(out.receipt.stopReason).toBe('missing_selection');expect(f.state.resolution!.choice!.field).toBe('attackerId');expect(f.state.units.some(u=>u.id==='uk')).toBe(true);
 const g=await fixture();let build='';await g.scene(s=>{build=give(s,'build_army').id;});const stale=await action(g,'PLAY_CARD',{regionId:'eastern_europe'},build);const edit=structuredClone(g.state);edit.scores.germany++;await g.admin('editScene',edit);await expect(g.adapter.submitAction(g.token,stale)).rejects.toMatchObject({code:'WRONG_GAME'});await expect(g.adapter.submitAction(g.token,{...stale,intent:{regionId:'germany'}})).rejects.toMatchObject({code:'DUPLICATE_CONFLICT'});
});
it('the same wait lease scope detects a game generation change even between renewals',async()=>{
 const f=await fixture();await f.scene(s=>{s.activeSeat=s.operatorSeat=s.viewSeat='united_kingdom';});expect((await f.adapter.waitDecision(f.token,{waitId:'persistent-scope',leaseMs:1})).leaseExpired).toBe(true);const edited=structuredClone(f.state);edited.scores.united_kingdom++;await f.admin('editScene',edited);expect((await f.adapter.waitDecision(f.token,{waitId:'persistent-scope',leaseMs:1})).status).toBe('resync_required');
});
it('no queued command executes a later phase decision, and missing recycle / new search needs the model',async()=>{
 const f=await fixture();let id='';await f.scene(s=>{id=give(s,'build_army').id;});const request=await action(f,'PLAY_CARD',{regionId:'eastern_europe',answers:[{kind:'EFFECT_DECISION',effectIndex:0,ids:['execute']}]},id);const result=await f.adapter.submitAction(f.token,request);expect(result.receipt.status).toBe('completed');expect(result.receipt.remaining.unusedAnswers).toHaveLength(1);expect(result.receipt.stopBoundary).toBe('phase_changed');
});
it('finished game is terminal; removing bindings terminates a pending wait without game mutations',async()=>{
 const f=await fixture();await f.scene(s=>{s.status='FINISHED';s.winner='axis';s.victoryReason='AXIS_LEAD';});expect((await f.adapter.waitDecision(f.token,{waitId:'over',leaseMs:1})).status).toBe('finished');
 const g=await fixture();await g.scene(s=>{s.activeSeat=s.operatorSeat=s.viewSeat='united_kingdom';});const waiting=g.adapter.waitDecision(g.token,{waitId:'unbind',leaseMs:1000});await g.admin('binding','italy',false);const out=await waiting;expect(out.status).toBe('resync_required');
});

it('single and bundled request identities cannot collide, including an internal step suffix',async()=>{
 const f=await fixture();let id='';await f.scene(s=>{id=give(s,'build_army').id;});const request=await action(f,'PLAY_CARD',{regionId:'eastern_europe'},id);
 await f.adapter.submit(f.token,{...request,requestId:'shared'});const before=JSON.stringify(f.state);
 await expect(f.adapter.submitAction(f.token,{...request,requestId:'shared'})).rejects.toMatchObject({code:'DUPLICATE_CONFLICT'});expect(JSON.stringify(f.state)).toBe(before);
 const g=await fixture();let other='';await g.scene(s=>{other=give(s,'build_army').id;});const req=await action(g,'PLAY_CARD',{regionId:'eastern_europe'},other);
 await g.adapter.submit(g.token,{...req,requestId:'bundle.0'});
 await g.scene(s=>{other=give(s,'build_army').id;});const current=await action(g,'PLAY_CARD',{regionId:'eastern_europe'},other);
 const out=await g.adapter.submitAction(g.token,{...current,requestId:'bundle'});expect(out.receipt.status).toBe('completed');
 await expect(g.adapter.submit(g.token,{...req,requestId:'bundle'})).rejects.toMatchObject({code:'DUPLICATE_CONFLICT'});
});

it('a search after an earlier subeffect still pauses for new information despite a prefilled answer',async()=>{
 const f=await fixture();await f.scene(s=>{startResolution(s,'constructed-search','germany',[{kind:'trace',label:'earlier effect'},{kind:'cards',seat:'germany',from:'drawPile',to:'hand',min:1,max:1,label:'search'}],[],undefined,'discardPile',true);});
 const o=await f.adapter.observe(f.token);if(!('decisions'in o))throw Error('no observation');const q=o.decisions[0];expect(q.kind).toBe('CARDS');expect(q.effectIndex).toBe(1);
 expect(continuation(o,{answers:[{kind:'CARDS',ids:[q.options[0].id]}]},new Set())).toEqual({reason:'new_information'});
});

it('special_236 reveal barrier wakes participants and keeps nonparticipants waiting through every acknowledgement',async()=>{
 const f=await fixture(true);let card='';await f.scene(s=>{s.activeSeat=s.viewSeat=s.operatorSeat='italy';card=give(s,'special_236').id;for(const seat of ['germany','italy','japan'] as const){const d=s.decks[seat],i=d.drawPile.findIndex(c=>c.definitionId===(seat==='italy'?'special_219':'build_army'));d.discardPile.push(...d.drawPile.splice(i,1));}});
 const identity=await f.room.createIdentity('axis'),connection='axis-setup';let snapshot:RoomSnapshot;await f.room.connect(identity.token,connection,v=>{if(!('replaced'in v))snapshot=v;});
 const axisCall=(method:string,...args:unknown[])=>f.room.request(identity.token,{id:crypto.randomUUID(),connection,epoch:snapshot!.room.epoch,revision:snapshot!.state?.revision??null,method,args});
 await axisCall('seat',{kind:'player',seat:'germany'});for(const seat of ['germany','italy','japan'])await axisCall('binding',seat,true);const axis=new LocalAiAdapter(f.room);await axis.connect(identity.token);
 await f.admin('dispatch',{type:'PLAY_CARD',seat:'italy',expectedRevision:f.state.revision,cardId:card,effectIndices:[0],targetIds:[],guided:true});
 for(let n=0;n<8&&!f.state.resolution?.revealGroup;n++){const q=f.state.resolution!.choice!;await f.admin('dispatch',{type:'RESOLVE_ENGINE_CHOICE',seat:q.seat,expectedRevision:f.state.revision,choiceId:q.id,ids:q.options.slice(0,Math.max(q.min,1)).map(o=>o.id),guided:true});}
 expect(f.state.resolution!.revealGroup).toBeTruthy();expect(f.state.resolution!.choice).toBeNull();const group=structuredClone(f.state.resolution!.revealGroup!);
 const malformed=structuredClone(f.state);malformed.resolution!.revealGroup!.frameId='missing-frame';expect(observePlayer(malformed,['germany'],{epoch:'x',sequence:1,serverId:'s',userId:'u',name:'test',locked:false,replay:false}).status).toBe('unsupported');
 let participant=await axis.waitDecision(identity.token,{waitId:'reveal',leaseMs:100});expect(participant.status).toBe('decision');expect(participant.observation!.offers.some(o=>o.command.type==='ACK_RESPONSE_NOTICE')).toBe(true);
 let unrelatedDone=false;const unrelated=f.adapter.waitDecision(f.token,{waitId:'unrelated',leaseMs:1000});unrelated.then(()=>unrelatedDone=true);
 const ack=async(seat:typeof SEATS[number],noticeId:string)=>{await f.admin('dispatch',{type:'ACK_RESPONSE_NOTICE',seat,expectedRevision:f.state.revision,noticeId});const o=await f.adapter.observe(f.token);expect(o.status).toBe('waiting_other');expect(o.offers).toEqual([]);expect(JSON.stringify(o)).not.toContain('翻开的是');};
 await ack('japan',group.items.find(i=>i.seat==='japan')!.requestId);participant=await axis.waitDecision(identity.token,{waitId:'result',after:participant.cursor,leaseMs:100});expect(participant.status).toBe('decision');
 await ack('japan',group.items.find(i=>i.seat==='japan')!.resultId);await pause(5);expect(unrelatedDone).toBe(false);
 for(const seat of ['italy','germany'] as const){const item=group.items.find(i=>i.seat===seat)!;await ack(seat,item.requestId);await ack(seat,item.resultId);}
 expect(f.state.resolution!.revealGroup).toBeUndefined();expect(f.state.resolution!.choice!.seat).toBe('germany');expect((await axis.observe(identity.token)).status).toBe('needs_ai');
 expect((await unrelated).leaseExpired).toBe(true);
 for(let n=0;n<12&&f.state.resolution?.running;n++){const q=f.state.resolution!.choice!;await f.admin('dispatch',{type:'RESOLVE_ENGINE_CHOICE',seat:q.seat,expectedRevision:f.state.revision,choiceId:q.id,ids:[],guided:true});}
 expect(f.state.resolution?.running).toBe(false);expect((await f.adapter.observe(f.token)).status).not.toBe('unsupported');
 const broken=structuredClone(f.state);broken.resolution!.running=true;broken.resolution!.choice=null;delete broken.resolution!.revealGroup;expect(observePlayer(broken,['united_states'],{epoch:'x',sequence:1,serverId:'s',userId:'u',name:'test',locked:false,replay:false}).status).toBe('unsupported');
});
