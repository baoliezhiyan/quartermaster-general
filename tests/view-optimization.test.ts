import {it,expect} from 'vitest';
import {createGame,transition,SEATS} from '../src/core';
import {projectState} from '../src/network/project';
import {projectState as oldProject} from '../outputs/view-performance/baseline/src/network/project';
import {createViewProjector} from '../src/network/viewProjector';
import {shareView} from '../src/network/shareView';
import type {GameState,SeatId} from '../src/core';
import type {RoomAccess} from '../src/controller/GameController';
const freeze=<T,>(v:T):T=>{if(v&&typeof v==='object'){Object.freeze(v);Object.values(v).forEach(freeze);}return v;};
const accesses:RoomAccess[]=[{kind:'gm'},{kind:'public'},...SEATS.flatMap(seat=>[{kind:'player' as const,seat},{kind:'observer' as const,seat}])];
function check(s:GameState){
 const original=JSON.stringify(s);const project=createViewProjector();
 for(const a of accesses)for(const view of SEATS){const expected=oldProject(s,a,view);if(a.kind==='gm')for(const frame of expected?.resolution?.frames??[]){delete frame.rollback;delete frame.extraRollback;}expect(projectState(s,a,view)).toEqual(expected);expect(project(freeze(structuredClone(s)),a,view)).toEqual(expected);}
 expect(JSON.stringify(s)).toBe(original);
}
it('all player, observer, public and GM views match the old projector before and during resolution',()=>{
 const s=createGame('views',42,'FULL',true,true,true);check(s);
 s.prelude!.active=false;s.phase='PLAY';s.status='PLAYING';s.setupCompleted=[...SEATS];
 for(const seat of SEATS){const d=s.decks[seat];d.faceDown.push(...d.hand.splice(0,1));d.resolving.push(...d.hand.splice(0,1));d.removed.push(...d.hand.splice(0,1));d.discardPile.push(...d.hand.splice(0,1));}
 s.publicCardIds=SEATS.flatMap(seat=>[s.decks[seat].resolving[0].id,s.decks[seat].discardPile[0].id]);
 s.faceUpResponseIds=[s.decks.japan.faceDown[0].id];s.disabledResponseIds=SEATS.map(seat=>s.decks[seat].faceDown[0].id);
 s.responseNotices=SEATS.map(seat=>({id:seat,recipients:[seat],readBy:[],text:'private '+seat,cards:[s.decks[seat].hand[0]]}));check(s);
 s.activeSeat=s.viewSeat=s.operatorSeat='germany';const d=s.decks.germany;
 const card=d.drawPile.find(c=>c.definitionId==='build_army')!;d.drawPile=d.drawPile.filter(c=>c!==card);d.hand.push(card);
 const result=transition(s,{type:'PLAY_CARD',seat:'germany',expectedRevision:s.revision,cardId:card.id,targetIds:[],effectIndices:[0],guided:true});expect(result.ok).toBe(true);if(result.ok){expect(result.state.resolution?.running).toBe(true);check(result.state);}
},20000);
it('cached views preserve privacy and refresh on role/seat changes, rollback and in-place mutable input',()=>{
 const project=createViewProjector(),s=createGame('sharing',42,'FULL',true,false,true),a={kind:'player' as const,seat:'germany' as SeatId};
 const frozen=freeze(structuredClone(s)),first=project(frozen,a,'germany')!;
 expect(project(frozen,a,'germany')).toBe(first);expect(Object.isFrozen(first.decks.germany.hand)).toBe(true);
 const changed=structuredClone(s);changed.revision++;changed.publicLog!.push({round:0,seat:'japan',text:'公开消息'});
 const next=project(freeze(changed),a,'germany')!;expect(next.decks.germany.hand).toBe(first.decks.germany.hand);expect(next.units).toBe(first.units);expect(next.publicLog).not.toBe(first.publicLog);
 expect(project(frozen,a,'germany')).toEqual(first);
 for(const access of accesses){const view='seat' in access?access.seat:'japan';expect(project(frozen,access,view)).toEqual(oldProject(s,access,view));}
 const publicView=project(frozen,{kind:'public'},'germany')!;expect(publicView.decks.germany.hand.every(c=>c.definitionId==='hidden')).toBe(true);expect(publicView.responseNotices??[]).toEqual([]);
 const revealed=structuredClone(s);revealed.faceUpResponseIds=[revealed.decks.japan.hand[0].id];revealed.decks.japan.faceDown.push(revealed.decks.japan.hand.shift()!);const shown=freeze(revealed);expect(project(shown,a,'germany')).toEqual(oldProject(shown,a,'germany'));const hidden=structuredClone(revealed);hidden.faceUpResponseIds=[];expect(project(freeze(hidden),a,'germany')).toEqual(oldProject(hidden,a,'germany'));
 const mutable=structuredClone(s);project(mutable,a,'germany');mutable.decks.germany.hand.pop();expect(project(mutable,a,'germany')).toEqual(oldProject(mutable,a,'germany'));
});
it('structural sharing handles removals, full snapshots and empty patches without changing data',()=>{
 const a={hand:[{id:'a'}],log:['one'],optional:undefined};const b=structuredClone(a);expect(shareView(a,b)).toBe(a);
 const c={hand:[{id:'a'}],log:['one','two']};const next=shareView(a,c);expect(next).toEqual(c);expect(next.hand).toBe(a.hand);expect(Object.hasOwn(next,'optional')).toBe(false);
 expect(shareView(next,{hand:[],log:[]})).toEqual({hand:[],log:[]});expect(a.hand).toEqual([{id:'a'}]);
});
