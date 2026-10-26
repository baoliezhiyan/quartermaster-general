// @ts-expect-error Node-only constructed sample output.
import {mkdir,writeFile} from 'node:fs/promises';
import {it,expect} from 'vitest';
import {createGame,transition} from '../src/core/game';
import {SEATS,type GameState,type Command} from '../src/core/types';
import {startResolution,resolveChoice} from '../src/core/resolution';
import {publicDiscard,revealPublic,concealPublic,rememberPublicDiscards} from '../src/core/publicHistory';
import {putDiscardedCards} from '../src/core/decks';
import {projectState,publicDeckViews} from '../src/network/project';
import {balanceEffect} from '../src/core/balanceEffects';
import {unsuppliedForPhase} from '../src/core/supply';
import {fullTrigger} from '../src/core/fullCardTriggers';
import {LocalGameController} from '../src/controller/LocalGameController';
import {parseReplay,seal} from '../src/actionReplay/codec';
import {Player} from '../src/actionReplay/player';
import {stateHash} from '../src/actionReplay/state';
import {recordCommand,createRecording,captureTransition} from '../src/actionReplay/recorder';
function game(){const s=createGame('v183',17,'FULL',false,true,true);s.status='PLAYING';s.round=1;s.phase='PLAY';s.setupCompleted=[...SEATS];for(const d of Object.values(s.decks)){d.drawPile.push(...d.hand.splice(0));}return s;}
function answer(s:GameState,ids:string[],guided=false){const q=s.resolution!.choice!;expect(resolveChoice(s,q.seat,q.id,ids,guided)).toBe(true);}
it('keeps historical public discards after private recovery and deduplicates repeated public discards',()=>{
 const s=game(),d=s.decks.germany,c=d.drawPile.shift()!;putDiscardedCards(s,'germany',[c]);revealPublic(s,[c]);rememberPublicDiscards(s);
 d.discardPile=[];d.hand.push(c);concealPublic(s,[c.id]);
 expect(publicDiscard(s,'germany').map(c=>c.id)).toEqual([c.id]);
 const viewer=projectState(s,{kind:'public'},'germany')!;
 expect(viewer.decks.germany.hand[0].definitionId).toBe('hidden');expect(viewer.decks.germany.discardPile).toEqual([c]);expect(publicDeckViews(s).germany.discardPile).toEqual([c]);
 d.hand=[];putDiscardedCards(s,'germany',[c]);revealPublic(s,[c]);expect(publicDiscard(s,'germany')).toHaveLength(1);
});
for(const selected of ['shown','hidden'])it('reveal response discards '+selected+' with the correct visibility',()=>{
 const s=game(),d=s.decks.japan;
 for(const id of ['special_195','special_196']){const i=d.drawPile.findIndex(c=>c.definitionId===id);d.faceDown.push(...d.drawPile.splice(i,1));}
 startResolution(s,'Magic/Blue Division','united_states',[balanceEffect('japan','reveal-response')],[]);
 const shown=s.faceUpResponseIds![0];answer(s,[selected==='shown'?shown:'hidden']);
 expect(d.discardPile).toHaveLength(1);expect(publicDiscard(s,'japan').map(c=>c.id)).toEqual(selected==='shown'?[shown]:[]);
});
for(const reverse of [false,true])it('supply removes only the base and allows aircraft relocation; reversed='+reverse,()=>{
 const s=game();s.units=[{id:'home',country:'germany',type:'army',regionId:'germany'},{id:'lost',country:'germany',type:'army',regionId:'siberia'},{id:'air',country:'germany',type:'air',regionId:'siberia'}];
 expect(unsuppliedForPhase(s,'germany')).toEqual(['lost']);
 if(reverse)s.units.reverse();s.phase='AIR';
 const result=transition(s,{type:'ADVANCE_PHASE',seat:'germany',expectedRevision:s.revision});expect(result.ok).toBe(true);if(!result.ok)return;
 const n=result.state;expect(n.resolution?.choice?.kind).toBe('RELOCATE');answer(n,['germany']);
 expect(n.units.find(u=>u.id==='air')?.regionId).toBe('germany');expect(n.units.some(u=>u.id==='lost')).toBe(false);
});
it('Pearl Harbor ends neutrality without offering an effect decision for that cost',()=>{
 const s=game();s.activeSeat=s.viewSeat=s.operatorSeat='japan';const d=s.decks.japan,c=d.drawPile.find(c=>c.definitionId==='special_249')!;
 const rule=fullTrigger(s,c,{kind:'signal',tag:'PHASE:TURN_START_WINDOW',label:'start'},'After')!;expect(rule).toBeTruthy();
 startResolution(s,'Pearl Harbor','japan',rule.effects!,[],undefined,'discardPile',true);
 for(let i=0;s.resolution?.choice&&i<15;i++){const q=s.resolution.choice;expect(q.prompt).not.toBe('结束中立');answer(s,q.options.slice(0,q.min).map(o=>o.id),true);}
 expect(s.neutrality!.united_states.neutral).toBe(false);
});
it('records the exact guided flag of skipped trigger windows across successive resolutions',async()=>{
 let s=game();s.activeSeat=s.operatorSeat=s.viewSeat='japan';const d=s.decks.japan;d.hand.push(...d.drawPile.splice(0,3));const id=d.drawPile.findIndex(c=>c.definitionId==='special_189');d.active.push(...d.drawPile.splice(id,1));s.resolutionResume={phase:'TURN_START_WINDOW',apply:true};s.phase='TURN_START_WINDOW';startResolution(s,'first','japan',[{kind:'signal',tag:'PHASE:TURN_START_WINDOW',label:'turn start'}],[]);
 let recording=await createRecording(s);expect(s.resolution?.choice?.kind).toBe('TRIGGER');
 for(let i=0;i<10&&s.resolution?.choice;i++){
  const q=s.resolution.choice,c:Command={type:'RESOLVE_ENGINE_CHOICE',seat:q.seat,expectedRevision:s.revision,choiceId:q.id,ids:[],guided:true};
  const captures:Parameters<typeof captureTransition>[0]=[],r=captureTransition(captures,()=>transition(s,c));expect(r.ok).toBe(true);if(!r.ok)return;
  recording=await recordCommand(recording,s,r.state,c,captures);s=r.state;
 }
 const a=await parseReplay(await seal(recording.records));expect(a.groups.length).toBeGreaterThan(0);
 expect(await stateHash(await new Player(a).seek(a.groups.at(-1)!.root.actionId,true,true))).toBe(await stateHash(s));
});
it('GM edits preserve history, support before/after and can continue, undo and reload',async()=>{
 const c=new LocalGameController();await c.dispatch({type:'CREATE_GAME',gameId:'editor183',seed:1940,mode:'FULL',prelude:true,neutrality:true,balance:true});
 const initial=await stateHash(c.getSnapshot()!);let edited=structuredClone(c.getSnapshot()!);edited.scores.germany=9;await c.editScene(edited);
 let a=await parseReplay(await c.exportReplay());expect(a.groups.at(-1)!.root.kind).toBe('editor_change');const p=new Player(a),id=a.groups.at(-1)!.root.actionId;
 expect(await stateHash(await p.seek(id,false,true))).toBe(initial);expect((await p.seek(id,true,true)).scores.germany).toBe(9);
 edited=structuredClone(c.getSnapshot()!);edited.scores.italy=4;await c.editScene(edited);a=await parseReplay(await c.exportReplay());expect(a.groups.filter(g=>g.root.kind==='editor_change')).toHaveLength(2);
 expect(await stateHash(await new Player(a).seek(a.groups.at(-1)!.root.actionId,true,true))).toBe(await stateHash(c.getSnapshot()!));
 await mkdir('outputs/match-log-samples',{recursive:true});await writeFile('outputs/match-log-samples/client-gm-edit.jsonl',await c.exportReplay());
 const saved=await c.exportSave(),other=new LocalGameController();await other.importSave(saved);expect(other.getSnapshot()!.scores.italy).toBe(4);
 await c.undo();a=await parseReplay(await c.exportReplay());expect(a.groups.filter(g=>g.root.kind==='editor_change')).toHaveLength(1);
});

for(const protectedBase of [false,true])it('aircraft survives with a protected base, otherwise returns to reserve without destinations: '+protectedBase,()=>{
 const s=game();s.units=[{id:'lost',country:'germany',type:'army',regionId:'siberia'},{id:'air',country:'germany',type:'air',regionId:'siberia'}];
 if(protectedBase)s.turnFlags={protected:['lost'],battleProtected:[],supplied:[],supplyCountries:[],supplyRegions:[],suppressed:[],noAirDefense:false};s.phase='AIR';
 const r=transition(s,{type:'ADVANCE_PHASE',seat:'germany',expectedRevision:s.revision});expect(r.ok).toBe(true);if(!r.ok)return;
 expect(r.state.units.some(u=>u.id==='air')).toBe(protectedBase);
 expect(r.state.units.some(u=>u.id==='lost')).toBe(protectedBase);
 expect(r.state.events.some(e=>'code' in e&&e.code==='AIR_REMOVED')).toBe(!protectedBase);
 expect(r.state.pendingAir).toEqual([]);
});
it('rejects a direct supply removal of aircraft even when its base is unsupplied',()=>{
 const s=game();s.units=[{id:'air',country:'germany',type:'air',regionId:'siberia'}];
 startResolution(s,'obsolete supply removal','germany',[{kind:'remove',unit:{...s.units[0]},supplied:false,cause:'supply',label:'obsolete'}],[]);
 expect(s.units.map(u=>u.id)).toEqual(['air']);
});
