import {it,expect} from 'vitest';
import {createGame} from '../src/core/game';
import {SEATS} from '../src/core/types';
import {openReplay} from '../src/actionReplay/openReplay';
import {parseRealHandTrainingReplay,sealRealHandTrainingReplay,realHandReplayStateHash,AUDITED_HAND_IDENTITIES} from '../src/actionReplay/realHandTrainingReplay';
import {visibleMapPanels} from '../src/ui/MapPanels';
// @ts-expect-error node test only
import {readFile} from 'node:fs/promises';
async function fixture(){const s=createGame('h-fixture',1940,'FULL',false,false,true);s.trainingHand={version:'ppo-real-hand-v1'};
 const header:any={type:'header',seq:0,format:'quartermaster-match-log',formatVersion:4,recordingModel:'full_state',mode:'real_hand',recordingId:'synthetic',gameId:s.gameId,...AUDITED_HAND_IDENTITIES[0],courseVersion:'ppo-real-hand-v1',producer:{name:'synthetic-test',version:'1'},visibility:'gm-audit'};
 return sealRealHandTrainingReplay([header,{type:'start',seq:1,state:s,stateHash:await realHandReplayStateHash(s)},{type:'training_action',seq:2,id:'hand-training-1',seat:'germany',round:0,summary:'起手留牌',state:s,stateHash:await realHandReplayStateHash(s)}]);}
it('accepts audited identities without current engine execution and restricts public view',async()=>{
 const text=await fixture(),c=await openReplay(text);await c.seek('hand-training-1',true);expect(visibleMapPanels(c.getSnapshot(),false,true).some(([id])=>id==='resource-pool')).toBe(false);
 c.setRoomAccess?.({kind:'public'});for(const seat of SEATS)expect(c.getSnapshot().decks[seat].hand.every(c=>c.definitionId==='hidden')).toBe(true);
 expect(await c.dispatch({type:'ADVANCE_PHASE',seat:'germany',expectedRevision:0})).toEqual({ok:false,error:'WRONG_OPERATOR'});
 await expect(openReplay(text.replace(AUDITED_HAND_IDENTITIES[0].sourceBuildFingerprint,'f'.repeat(64)))).rejects.toThrow('指纹');
 await expect(parseRealHandTrainingReplay(text.slice(0,text.lastIndexOf('{"type":"end"')))).rejects.toThrow();
 await expect(parseRealHandTrainingReplay(text.replace('"summary":"起手留牌"','"summary":"changed"'))).rejects.toThrow('封存');
});
// External user archives remain read-only and are never committed as fixtures.
// @ts-expect-error node test only
const external=process.env.QM_HAND_REPLAYS?.split('|')??[];
for(const file of external)it('validates real diagnostic archive '+file.split('/').slice(-3,-1).join('/'),async()=>{
 const c=await openReplay(await readFile(file,'utf8'));expect(c.entries.length).toBeGreaterThan(100);
 await c.seek(c.entries.at(-1)!.id,true);expect(c.getSnapshot().status).toBe('FINISHED');
},120000);
