import {expect,it} from 'vitest';
// @ts-expect-error Node fixture output.
import {mkdir,writeFile} from 'node:fs/promises';
import {createGame} from '../src/core/game';
import {boardOptions} from '../src/core/boardEffects';
import {REGIONS} from '../src/core/map';
import {SEATS} from '../src/core/types';
import {ENGINE} from '../src/actionReplay/state';
import {createTrainingScene,applyScene,trainingSceneHash} from '../src/actionReplay/trainingScene';
import {parseTrainingReplay,sealTraining} from '../src/actionReplay/trainingCodec';
import {TrainingController} from '../src/actionReplay/TrainingController';
import {applyResource} from '../src/actionReplay/resources';
import {openReplay} from '../src/actionReplay/openReplay';
import type {TrainingHeader,TrainingStart,TrainingStep,TrainingCard} from '../src/actionReplay/trainingContract';
const cards:TrainingCard[]=[{id:'a',definitionId:'build_army',country:'germany',deckOwner:'germany',name:'建设陆军',text:'训练卡面：建设一支陆军',type:'基本牌'},{id:'b',definitionId:'training-custom-card',country:'germany',deckOwner:'germany',name:'构造测试卡',text:'仅用于验证文件内卡面',type:'事件'}];
async function fixture(){
 const header:TrainingHeader={type:'header',seq:0,format:'quartermaster-match-log',formatVersion:3,recordingModel:'scene_actions',mode:'resource_pool',replayAdapter:{id:'quartermaster-training-scene',version:'1.0.0'},recordingId:'constructed-example',gameId:'constructed-training',gameVersion:'trainer-base-unrelated-version',producer:{name:'constructed-client-contract-fixture-NOT-real-training',version:'99.0'},sceneEngineFingerprint:ENGINE,requiredCapabilities:['scene.board.v1','scene.score.v1','resources.independent.v1'],training:{courseId:'constructed',courseVersion:'1',configuration:{availability:'A',constructed:true},ruleOverrides:[]},cards};
 const start:TrainingStart={type:'start',seq:1,scene:{units:createGame('x',1,'FULL').units,scores:Object.fromEntries(SEATS.map(s=>[s,0])) as any,round:1,phase:'PLAY',activeSeat:'germany',balance:true},resources:['hand','drawPile','discardPile','resourcePool'].map(zone=>({seat:'germany',zone:zone as any,ids:zone==='discardPile'?[]:['a'],visibility:'owner'}))};
 const map=new Map(cards.map(c=>[c.id,c])),s=createTrainingScene(start.scene,header.gameId,map);
 const option=boardOptions(s,{kind:'action',country:'germany',action:'build_army',label:'test'}).find(o=>!o.recycleId&&!o.existingId)!;
 const first:TrainingStep={type:'training_action',seq:2,id:'build',seat:'germany',activeSeat:'germany',round:1,phase:'PLAY',cardId:'a',operations:[{kind:'board',country:'germany',action:'build_army',regionId:option.regionId,newUnitId:'training-army'}],sceneHash:''};
 applyScene(s,first.operations[0] as any,map);first.sceneHash=await trainingSceneHash(s);
 const second:TrainingStep={type:'training_action',seq:3,id:'resources',seat:'germany',activeSeat:'germany',round:1,phase:'PLAY',cardId:'b',operations:[{kind:'resource',change:{op:'move',id:'a',from:{seat:'germany',zone:'drawPile'},to:{seat:'germany',zone:'discardPile'}}},{kind:'resource',change:{op:'set',seat:'germany',zone:'hand',ids:['b'],visibility:'owner'}},{kind:'resource',change:{op:'add',seat:'germany',zone:'resourcePool',id:'b',index:0}},{kind:'score',seat:'germany',amount:2}],sceneHash:''};
 applyScene(s,{kind:'score',seat:'germany',amount:2},map);second.sceneHash=await trainingSceneHash(s);
 return [header,start,first,second] as [TrainingHeader,TrainingStart,TrainingStep,TrainingStep];
}
it('keeps scene execution independent from all four resources, supports full/delta and backwards seek',async()=>{
 const lines=await fixture(),text=await sealTraining(lines),c=new TrainingController(await parseTrainingReplay(text));await c.checkReplay();
 await c.seek('build',true);let s=c.getSnapshot() as any;
 expect(s.units.some((u:any)=>u.id==='training-army')).toBe(true);
 expect(s.decks.germany.hand.map((c:any)=>c.id)).toEqual(['a']);expect(s.decks.germany.discardPile).toEqual([]);expect(s.resourcePool.germany.map((c:any)=>c.id)).toEqual(['a']);
 await c.seek('resources',true);s=c.getSnapshot() as any;expect(s.decks.germany.drawPile).toEqual([]);expect(s.decks.germany.discardPile.map((c:any)=>c.id)).toEqual(['a']);expect(s.decks.germany.hand.map((c:any)=>c.id)).toEqual(['b']);expect(s.resourcePool.germany.map((c:any)=>c.id)).toEqual(['b','a']);expect(s.scores.germany).toBe(2);
 await c.seek('resources',false);expect(c.getSnapshot().scores.germany).toBe(0);expect(c.getSnapshot().decks.germany.hand[0].id).toBe('a');
 await c.seek('resources@operation:0',true);expect(c.getSnapshot().decks.germany.discardPile[0].id).toBe('a');expect(c.getSnapshot().decks.germany.hand[0].id).toBe('a');
 expect(await c.dispatch({type:'ADVANCE_PHASE',seat:'germany',expectedRevision:0})).toEqual({ok:false,error:'WRONG_OPERATOR'});
 await mkdir('outputs/match-log-samples',{recursive:true});await writeFile('outputs/match-log-samples/constructed-training-resources.jsonl',text);
});
it('omitted zones stay unavailable; foreign/private cards and file card text are filtered',async()=>{
 const lines=await fixture();delete lines[1].resources;lines.splice(3,1);const c=await openReplay(await sealTraining(lines));await c.seek('build',true);
 expect((c.getSnapshot() as any).trainingReplay.available).toEqual([]);expect(c.getSnapshot().decks.germany.hand).toEqual([]);
 const own=new TrainingController(await parseTrainingReplay(await sealTraining(await fixture())));own.setRoomAccess({kind:'observer',seat:'japan'});expect(own.getSnapshot().decks.germany.hand).toEqual([]);
 own.setRoomAccess({kind:'observer',seat:'germany'});expect((own.getSnapshot().decks.germany.hand[0] as any).__replayCard.text).toContain('训练卡面');
});
it('resource operations are atomic, ordered and permit duplicates only across zones',()=>{
 const known=new Set(['a','b']);let r=applyResource(new Map(),{op:'set',seat:'germany',zone:'hand',visibility:'owner',ids:['a']},known);
 r=applyResource(r,{op:'set',seat:'germany',zone:'resourcePool',visibility:'public',ids:['a']},known);
 expect(()=>applyResource(r,{op:'move',id:'a',from:{seat:'germany',zone:'hand'},to:{seat:'germany',zone:'resourcePool'}},known)).toThrow('重复');expect(r.get('germany:hand')!.ids).toEqual(['a']);
 r=applyResource(r,{op:'remove',seat:'germany',zone:'resourcePool',id:'a'},known);expect(r.get('germany:hand')!.ids).toEqual(['a']);expect(r.get('germany:resourcePool')!.ids).toEqual([]);
 expect(()=>applyResource(r,{op:'add',seat:'japan',zone:'drawPile',id:'b'},known)).toThrow('初始化');
 expect(()=>applyResource(r,{op:'set',seat:'germany',zone:'hand',visibility:'owner',ids:['a','a']},known)).toThrow('重复');
});
it('does not gate trainer versions but rejects unknown capabilities, overrides, truncation and illegal scene actions',async()=>{
 const lines=await fixture();await expect(parseTrainingReplay(await sealTraining(lines))).resolves.toBeTruthy();
 lines[0].requiredCapabilities.push('unknown.v1');await expect(parseTrainingReplay(await sealTraining(lines))).rejects.toThrow('缺少必需能力');lines[0].requiredCapabilities.pop();
 lines[0].training.ruleOverrides=['invented'];await expect(parseTrainingReplay(await sealTraining(lines))).rejects.toThrow('规则覆盖');lines[0].training.ruleOverrides=[];
 const text=await sealTraining(lines);await expect(parseTrainingReplay(text.slice(0,text.lastIndexOf('\n',text.length-2)+1))).rejects.toThrow();
 (lines[2].operations[0] as any).regionId=REGIONS.find(r=>r.type==='SEA')!.id;await expect(openReplay(await sealTraining(lines))).rejects.toThrow('不合法');
});
it('rejects wrong board result hashes and unknown card references',async()=>{
 const lines=await fixture();lines[2].sceneHash='0'.repeat(64);await expect(openReplay(await sealTraining(lines))).rejects.toThrow('场面摘要');lines[2].cardId='missing';await expect(parseTrainingReplay(await sealTraining(lines))).rejects.toThrow('来源卡未知');
});
