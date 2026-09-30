import {it,expect} from 'vitest';
import {LocalGameController} from '../src/controller/LocalGameController';
import {createGame} from '../src/core/game';
import {cardEffects} from '../src/core/specialCards';
import {parseMatchLog} from '../src/matchLog/codec';
import {GAME_VERSION} from '../src/matchLog/normalize';
import {parseReplay} from '../src/actionReplay/codec';
import {Player} from '../src/actionReplay/player';
import type {Command} from '../src/core';
import {observeFacts} from '../src/core/factObserver';
import {factCapture,recordTransaction} from '../src/matchLog/recorder';
import {localControllers} from '../src/matchLog/normalize';
import {sealMatchLog} from '../src/matchLog/codec';
import {startResolution,resolveChoice} from '../src/core/resolution';
function fixture(id:string){const s=createGame('chain-'+id,1940,'FULL',false,false,false);s.status='PLAYING';s.round=1;s.phase='PLAY';s.setupCompleted=['germany','united_kingdom','japan','soviet_union','italy','united_states'];for(const d of Object.values(s.decks)){d.drawPile.push(...d.hand);d.hand=[];}const d=s.decks.germany,index=d.drawPile.findIndex(c=>c.definitionId===id),card=d.drawPile.splice(index,1)[0];d.hand.push(card);return {s,card};}
it.each(['special_158','special_162'])('records each ordered battle/build child of %s, before and after choices',async id=>{
 const {s,card}=fixture(id);if(id==='special_162')s.units=[{id:'g1',country:'germany',type:'army',regionId:'germany'},{id:'g2',country:'germany',type:'army',regionId:'ukraine'},{id:'su1',country:'soviet_union',type:'army',regionId:'eastern_europe'},{id:'su2',country:'soviet_union',type:'army',regionId:'moscow'}];
 const c=new LocalGameController();await c.importSave(JSON.stringify({format:'quartermaster-save',version:1,updatedAt:new Date().toISOString(),state:s,replayBase:s,rounds:[],nations:[],undo:[],commands:[]}));
 const dispatch=async(command:Record<string,unknown>)=>{const state=c.getSnapshot()!;if(state.viewSeat!==state.operatorSeat)await c.dispatch({type:'SET_VIEW',seat:state.operatorSeat,expectedRevision:state.revision});const live=c.getSnapshot()!;expect(await c.dispatch({seat:live.operatorSeat,expectedRevision:live.revision,...command} as Command)).toMatchObject({ok:true});};
 const targets=id==='special_162'?['su1','su2']:[];await dispatch({type:'PLAY_CARD',cardId:card.id,targetIds:targets,effectIndices:cardEffects(s,card,targets).map((_,i)=>i)});
 for(let i=0;c.getSnapshot()!.resolution?.running&&i<70;i++){const q=c.getSnapshot()!.resolution!.choice!;expect(q).toBeTruthy();await dispatch({type:'RESOLVE_ENGINE_CHOICE',choiceId:q.id,ids:q.kind==='TRIGGER'?[]:q.options.slice(0,q.min).map(o=>o.id)});}
 expect(c.getSnapshot()!.resolution?.running).toBe(false);const a=await parseReplay(await c.exportReplay());expect(a.groups).toHaveLength(1);const player=new Player(a);expect((await player.seek(a.groups[0].root.actionId,true)).units).toEqual(c.getSnapshot()!.units);expect((await player.seek(a.groups[0].root.actionId)).units).toEqual(s.units);
},60000);
it('explicit response choice and automatic mandatory choice are distinct recorded decisions',async()=>{
 const {s}=fixture('special_158'),captures:ReturnType<typeof factCapture>[]=[];const rule={id:'forced-score',label:'必发测试',owner:'germany' as const,source:'system' as const,sourceInstanceId:'system-score',timing:'After' as const,on:'signal',mandatory:true,effects:[{kind:'score' as const,seat:'germany' as const,amount:1,label:'强制得分'}]};
 observeFacts((state,b)=>captures.push(factCapture(state,b,localControllers(),0)),()=>{startResolution(s,'测试必发','germany',[{kind:'signal',tag:'test',label:'signal'}],[rule]);for(let i=0;s.resolution?.choice&&i<15;i++){const q=s.resolution.choice;resolveChoice(s,q.seat,q.id,q.options.slice(0,q.min).map(o=>o.id));}});
 const r=await recordTransaction(undefined,null,s,{type:'CREATE_GAME',gameId:s.gameId,seed:s.seed},captures);const a=await parseMatchLog(await sealMatchLog(r.records),GAME_VERSION);expect(a.frames.some(f=>f.kind==='automatic'&&'action'in f&&f.action)).toBe(true);expect(a.frames.some(f=>f.events.some(e=>e.eventType==='window_opened'))).toBe(true);
});
