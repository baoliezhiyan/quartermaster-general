import type {GameState,Command,SeatId} from '../core/types';
import {COUNTRY_NAMES,cardName} from '../core/basic';
import {observeFacts} from '../core/factObserver';
import {withReplayHooks} from '../core/replayHooks';
import type {ReplayBoundary} from '../core/replayHooks';
import type {Action,ActionGroup,Header,RecordLine,Shuffle} from './contract';
import {ADAPTER,ENGINE,VERSION,snapshot,stateHash,hash} from './state';
import {anchor,compactCommand,omitted,selectedRule} from './anchors';
export interface Capture {kind:'boundary'|'shuffle'; state?:GameState; boundary?:ReplayBoundary; round?:number; atState?:GameState; ids?:string[]; randomAfter?:number;owner?:SeatId;zone?:string;}
interface Cursor {seq:number;groupId?:string;order:number;frontier?:Extract<ActionGroup,{status:'pending'}>['frontier'];}
export interface Recording {records:Exclude<RecordLine,{type:'end'}>[];cursors:Record<string,Cursor>;groupStarts?:Record<string,string>;}
export function captureTransition<T>(captures:Capture[],run:()=>T):T {
 return withReplayHooks({boundary:(s,b,n)=>{captures.push({kind:'boundary',state:structuredClone(s),boundary:b,round:n});return false;}},()=>observeFacts((s,b)=>{
  if(!b.random)return;
  const values=b.random.output as {id?:string;deckOwner?:SeatId}[];
  if(!values.every(v=>typeof v?.id==='string'))throw Error('尚未支持该非卡牌随机排列');
  const ids=values.map(v=>v.id!),owner=values[0]?.deckOwner??s.activeSeat;
  const zone=Object.entries(s.decks[owner]).find(([,cards])=>cards.length===ids.length&&cards.every((c:{id:string})=>ids.includes(c.id)))?.[0]??(s.prelude&&Object.entries(s.prelude.decks[owner]).find(([,cards])=>cards.length===ids.length&&cards.every(c=>ids.includes(c.id)))?'prelude.drawPile':'selection');
  // Only the tiny anchor context is needed; no per-effect game snapshots are retained.
  const context={...s,decks:{} as GameState['decks'],events:[],publicLog:[],resolution:s.resolution?structuredClone(s.resolution):null};
  if(context.resolution)for(const f of context.resolution.frames){delete f.rollback;delete f.extraRollback;}
  captures.push({kind:'shuffle',atState:context,ids,randomAfter:b.random.after,owner,zone});
 },run));
}
const id=()=>crypto.randomUUID();
export const actions=(root:Action):Action[]=>[root,...root.interventions.flatMap(x=>actions(x.action))];
export function groupOrder(g:ActionGroup,records:Recording['records']){return Math.max(0,...actions(g.root).flatMap(a=>[...a.choices.map(c=>c.order),...a.interventions.map(i=>i.order)]),...records.filter((r):r is Shuffle=>r.type==='shuffle'&&r.groupId===g.groupId).map(r=>r.order));}
function group(s:GameState,input:Command|{type:'CONTINUE_BOUNDARY';boundary:ReplayBoundary},seat:SeatId):ActionGroup {
 const c=input as Command,card='cardId'in c?Object.values(s.decks).flatMap(d=>Object.values(d).flat()).concat(s.prelude?Object.values(s.prelude.decks).flatMap(d=>Object.values(d).flat()):[]).find(x=>x.id===c.cardId):undefined;
 const kind:Action['kind']=c.type==='KEEP_OPENING'?'opening_keep':c.type==='DISCARD_HAND'||c.type==='DISCARD_PRELUDE_TOP'?'discard':c.type==='REDISTRIBUTE'?'resource_reorganize':c.type==='STATUS_ACTION'?'activate':card?'play_card':'phase_advance';
 return {type:'action_group',seq:0,groupId:id(),stage:s.prelude?.active?'prelude':s.phase==='SETUP'?'opening':'formal',round:s.round,root:{actionId:id(),kind,decisionSeat:seat,...(card?{cardInstanceId:card.id,cardDefinitionId:card.definitionId,unitCountry:card.country}:{}),input:compactCommand(s,c),choices:[],interventions:[],summary:card?`${COUNTRY_NAMES[seat]}${kind==='activate'?'发动':'打出'}【${cardName(card)}】`:c.type==='KEEP_OPENING'?`${COUNTRY_NAMES[seat]}选择起手牌`:c.type==='DISCARD_HAND'?`${COUNTRY_NAMES[seat]}弃牌`:c.type==='DISCARD_PRELUDE_TOP'?`${COUNTRY_NAMES[seat]}弃置序章牌库顶`:c.type==='REDISTRIBUTE'?`${COUNTRY_NAMES[seat]}资源重整`:`${COUNTRY_NAMES[seat]}推进阶段`},status:'pending',frontier:{at:anchor(s,''),decisionKind:'idle'}};
}
export async function createRecording(s:GameState,origin:Header['origin']='snapshot'):Promise<Recording>{
 const header:Header={type:'header',seq:0,format:'quartermaster-match-log',formatVersion:3,recordingModel:'action_replay',recordingId:id(),recordingRevision:0,gameId:s.gameId,origin,mode:'standard',gameVersion:VERSION,engineFingerprint:ENGINE,replayAdapter:ADAPTER,commandSchemaVersion:'1',checkpointSchemaVersion:'1',rulesFingerprint:await hash(s.rules??{}),catalogFingerprint:ENGINE,mapFingerprint:ENGINE,rulesConfig:JSON.parse(JSON.stringify(s.rules??{})),producer:{name:'quartermaster-client',version:VERSION},digest:{algorithm:'SHA-256',canonicalization:'qm-sorted-json-v1'}};
 const state=snapshot(s),r:Recording={records:[header,{type:'start',seq:1,checkpointId:id(),state,stateHash:await hash(state)}],cursors:{}};
 r.cursors[await stateHash(s)]={seq:1,order:0};return r;
}
function activeAction(g:ActionGroup,s:GameState):Action {
 const q=s.resolution?.choice,r=s.resolution,rule=r?.rules.find(x=>x.id===q?.triggerId),frame=r?.frames.find(x=>x.id===q?.frameId)??r?.frames.find(x=>x.id===[...(r?.stack??[])].reverse().find(x=>x.kind==='frame')?.id);
 const effect=frame?.effects[frame.nextEffectIndex],selected=effect?.kind==='extraPlay'?effect.selectedCardId:undefined;
 const all=actions(g.root);return [...all].reverse().find(a=>a.cardInstanceId&&(a.cardInstanceId===selected||a.cardInstanceId===rule?.sourceInstanceId||a.cardInstanceId===frame?.cardId))??g.root;
}
export async function recordCommand(old:Recording|undefined,base:GameState|null,next:GameState,c:Command,captures:Capture[]):Promise<Recording>{
 if(!base||c.type==='CREATE_GAME')return createRecording(next,'creation');
 const r:Recording=old?{records:[...old.records],cursors:{...old.cursors},groupStarts:{...old.groupStarts}}:await createRecording(base);
 const skipInput=omitted(base,c)&&!(c.type==='ACK_RESPONSE_NOTICE'&&base.resolution?.revealGroup);
 if(skipInput&&!captures.length){
  if(c.type!=='SET_VIEW')await finish(r,next);
  return r;
 }
 let g=r.records.at(-1)?.type==='action_group'&&(r.records.at(-1) as ActionGroup).status==='pending'?structuredClone(r.records.pop() as ActionGroup):null;
 const choice=c.type==='RESOLVE_ENGINE_CHOICE';
 if(g&&!choice&&!['ACK_RESPONSE_NOTICE','RELOCATE_AIR','RESOLVE_FORCED_DISCARD','SET_CARD_RESPONSE','SET_INTERRUPTS'].includes(c.type)){
  const complete={...g,status:'complete',afterHash:await stateHash(base)} as any;delete complete.frontier;r.records.push(complete);g=null;
 }
 if(!g){g=group(base,c,'seat'in c?c.seat:base.activeSeat);(r.groupStarts??={})[g.groupId]=await stateHash(base);}
 else if(c.type!=='ACK_RESPONSE_NOTICE'&&!skipInput){
  const owner=activeAction(g,base),at=anchor(base,owner.actionId),order=groupOrder(g,r.records)+1;
  if(choice&&['TRIGGER','EXTRA_CARD'].includes(base.resolution?.choice?.kind??'')&&c.ids.length){
   const extra=base.resolution?.choice?.kind==='EXTRA_CARD',rule=extra?undefined:selectedRule(base,c.ids[0]);
   const card=Object.values(base.decks).flatMap(d=>Object.values(d).flat()).find(x=>x.id===(extra?c.ids[0]:rule?.sourceInstanceId));
   const action:Action={actionId:id(),kind:extra?'play_card':rule?.source==='active'?'activate':'response',decisionSeat:c.seat,sourceSeat:rule?.owner,...(card?{cardInstanceId:card.id,cardDefinitionId:card.definitionId,unitCountry:card.country}:{}),input:compactCommand(base,c),choices:[],interventions:[],summary:`${COUNTRY_NAMES[c.seat]}${extra?'额外打出':'发动'}【${card?cardName(card):'响应'}】`};owner.interventions.push({at,order,action});
  }else owner.choices.push({at,order,decisionSeat:'seat'in c?c.seat:base.activeSeat,kind:base.resolution?.choice?.kind??c.type,answer:compactCommand(base,c)});
 }
 for(const capture of captures){
  if(capture.kind==='shuffle'){
   const owner=activeAction(g,capture.atState!),at=anchor(capture.atState!,owner.actionId);r.records.push({type:'shuffle',seq:r.records.length,shuffleId:id(),groupId:g.groupId,at,order:groupOrder(g,r.records)+1,owner:capture.owner!,zone:capture.zone!,cardInstanceIds:capture.ids!,randomStreamAfter:{randomState:capture.randomAfter!}});
  }else{
   const s=capture.state!,done={...g,status:'complete',seq:r.records.length,afterHash:await stateHash(s)} as any;delete done.frontier;r.records.push(done);
   const state=snapshot(s);r.records.push({type:'checkpoint',seq:r.records.length,checkpointId:id(),boundary:capture.boundary!,completedRound:capture.round!,afterGroupId:g.groupId,state,stateHash:await hash(state)});
   g=group(s,{type:'CONTINUE_BOUNDARY',boundary:capture.boundary!},s.activeSeat);
  }
 }
 g.seq=r.records.length;r.records.push(g);await finish(r,next);return r;
}
async function finish(r:Recording,s:GameState){
 const last=r.records.at(-1);if(last?.type==='action_group'){
  const g=structuredClone(last),a=activeAction(g,s),q=s.resolution?.choice;
  if(s.resolution?.running||s.pendingAir.length||s.pendingDiscard){g.status='pending';(g as any).frontier={at:anchor(s,a.actionId),decisionSeat:q?.seat??s.operatorSeat,decisionKind:q?.kind??(s.resolution?.revealGroup?'reveal':s.pendingAir.length?'RELOCATE':'FORCE_HAND')};delete (g as any).afterHash;}
  else {g.status='complete';delete (g as any).frontier;(g as any).afterHash=await stateHash(s);}
  if(g.status==='complete'&&r.groupStarts?.[g.groupId]===g.afterHash){r.records=r.records.filter(line=>!('groupId'in line)||line.groupId!==g.groupId).map((line,seq)=>line.type==='header'?line:{...line,seq});r.cursors=Object.fromEntries(Object.entries(r.cursors).filter(([,c])=>c.groupId!==g.groupId));return;}
  r.records[r.records.length-1]=g;
  r.cursors[await stateHash(s)]={seq:g.seq,groupId:g.groupId,order:groupOrder(g,r.records),...(g.status==='pending'?{frontier:g.frontier}:{})};
 }
}
export async function restoreRecording(old:Recording|undefined,s:GameState,edit=false):Promise<Recording>{
 const cursor=old?.cursors[await stateHash(s)];if(!old||!cursor||edit)return createRecording(s);
 const targetIndex=cursor.groupId?old.records.findIndex(r=>r.type==='action_group'&&r.groupId===cursor.groupId):cursor.seq;
 if(targetIndex<1)throw Error('回退动作前缀不存在');
 const records=old.records.slice(0,targetIndex+1).filter(r=>r.type!=='shuffle'||r.order<=cursor.order||r.groupId!==cursor.groupId);
 const last=records.at(-1);if(last?.type==='action_group'){
  const g=structuredClone(last);function trim(a:Action){a.choices=a.choices.filter(c=>c.order<=cursor!.order);a.interventions=a.interventions.filter(i=>i.order<=cursor!.order);a.interventions.forEach(i=>trim(i.action));}trim(g.root);
  if(cursor.frontier){g.status='pending';(g as any).frontier=cursor.frontier;delete (g as any).afterHash;}else{g.status='complete';delete (g as any).frontier;(g as any).afterHash=await stateHash(s);}records[records.length-1]=g;
 }
 records.forEach((r,i)=>{records[i]={...r,seq:i} as any;});records[0]={...records[0],recordingRevision:(records[0] as Header).recordingRevision+1} as Header;
 return {records,groupStarts:old.groupStarts,cursors:Object.fromEntries(Object.entries(old.cursors).filter(([,c])=>{const n=c.groupId?old.records.findIndex(r=>r.type==='action_group'&&r.groupId===c.groupId):c.seq;return n<targetIndex||n===targetIndex&&c.order<=cursor.order;}))};
}
