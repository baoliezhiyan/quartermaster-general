import {expect,it} from 'vitest';
import {createGame} from '../src/core/game';
import {SEATS,type GameState} from '../src/core/types';
import {startResolution,resolveChoice} from '../src/core/resolution';
import {balanceEffect} from '../src/core/balanceEffects';
import {fullCardEffects} from '../src/core/fullCardEffects';
import {specialCard,BALANCE_CARDS} from '../src/core/cardCatalog';
import {validateState} from '../src/controller/saveFormat';
import {projectState} from '../src/network/project';
import type {Effect} from '../src/core/resolutionTypes';
function game(){const s=createGame('notices-audit',12,'FULL',true,true,true);s.prelude!.active=false;s.status='PLAYING';s.phase='PLAY';s.round=1;s.setupCompleted=[...SEATS];for(const seat of SEATS){const d=s.decks[seat];d.drawPile.push(...d.hand.splice(0));}return s;}
function move(s:GameState,id:string,zone:'hand'|'active'|'faceDown'){for(const seat of SEATS)for(const z of ['drawPile','hand','active','faceDown'] as const){const d=s.decks[seat],i=d[z].findIndex(c=>c.definitionId===id);if(i>=0){const card=d[z].splice(i,1)[0];d[zone].push(card);return card;}}throw Error(id);}
function reply(s:GameState,ids:string[]){const q=s.resolution!.choice!;expect(resolveChoice(s,q.seat,q.id,ids)).toBe(true);}
function finish(s:GameState){for(let i=0;s.resolution?.running&&i<100;i++){const q=s.resolution!.choice!;expect(q).toBeTruthy();reply(s,q.options.slice(0,q.min).map(o=>o.id));}expect(s.resolution?.running).toBe(false);}
it('Magic and Blue Division notices use real actor and target and keep discarded cards private',()=>{
 for(const [actor,target,id,ids] of [['united_states','japan','special_92',['special_195','special_196']],['italy','soviet_union','special_241',['special_68','special_69']]] as const){
 const s=game(),source=move(s,id,'hand');for(const x of (target==='soviet_union'?s.decks[target].drawPile.filter(c=>specialCard(c.definitionId,c.balance)?.type==='响应').slice(0,2).map(c=>c.definitionId):ids))move(s,x,'faceDown');
 startResolution(s,source.definitionId,actor,fullCardEffects(s,source,[])!,[],source.id);reply(s,['hidden']);finish(s);
 const notices=s.responseNotices!.filter(n=>n.recipients.includes(target));expect(notices.some(n=>n.title==='效果结果')).toBe(false);expect(notices.filter(n=>n.title==='弃牌结果')).toHaveLength(1);
 if(actor==='united_states'){expect(notices.every(n=>!n.text.includes('意大利')&&!n.text.includes('苏联'))).toBe(true);expect(notices.some(n=>n.text.includes('美国弃置了日本'))).toBe(true);}
 const privateNotice=notices.find(n=>n.title==='弃牌结果')!;expect(privateNotice.cards).toHaveLength(2);expect(privateNotice.text).toContain('揭开了');expect(projectState(s,{kind:'player',seat:actor},actor)!.responseNotices!.some(n=>n.id===privateNotice.id)).toBe(false);
 }
});
it('industry extra state is summarized once by its armament without false response or failure',()=>{
 const s=game(),root=move(s,'land_battle','hand'),migration=move(s,'special_42','hand');
 const pre=s.prelude!.decks.soviet_union;const arm=[...pre.hand,...pre.drawPile,...pre.discardPile].find(c=>c.definitionId==='prelude_SU-18')!;for(const z of ['hand','drawPile','discardPile'] as const)pre[z]=pre[z].filter(c=>c.id!==arm.id);s.decks.soviet_union.faceDown.push(arm);
 startResolution(s,'测试攻击','germany',[{kind:'trace',label:'战斗结束'}],[{id:'industry-test',sourceInstanceId:arm.id,label:'战时工业东迁',owner:'soviet_union',source:'response',timing:'After',on:'战斗结束',mandatory:false,effects:[balanceEffect('soviet_union','relocate-industry')]}],root.id);
 reply(s,[s.resolution!.choice!.options[0].id]);finish(s);
 const notices=s.responseNotices!.filter(n=>n.text.includes('战时工业东迁'));expect(notices).toHaveLength(1);expect(notices[0].text).toContain('打出了状态【迁都古比雪夫】');expect(notices[0].text).toContain('征召陆军');expect(notices[0].text).toContain('西伯利亚');expect(s.decks.soviet_union.active.some(c=>c.id===migration.id)).toBe(true);
 expect(s.responseNotices!.some(n=>n.text.includes('使用状态【迁都古比雪夫】'))).toBe(false);expect(s.responseNotices!.some(n=>n.text.includes('未生效'))).toBe(false);
});
it('entry status extra play produces an entry notification to everyone, not a response result',()=>{
 const s=game(),state=move(s,'special_47','hand');s.neutrality!.soviet_union.neutral=false;s.neutralityStatusPending=true;
 startResolution(s,'参战','germany',[{kind:'trace',label:'继续原攻击'}],[]);reply(s,['hand']);reply(s,[state.id]);finish(s);
 const notices=s.responseNotices!.filter(n=>n.title==='结束中立结算');expect(notices).toHaveLength(1);expect(notices[0].recipients).toEqual([...SEATS]);expect(notices[0].text).toContain('苏联结束了中立，弃置了【混乱的政局】');expect(notices[0].text).toContain('打出了状态');expect(notices[0].text).not.toContain('响应');expect(notices[0].text).not.toContain('未生效');
});
it('guided recruitment and construction prompts preserve the actual action',()=>{
 for(const [action,word] of [['recruit_army','征召陆军'],['build_army','建设陆军'],['recruit_navy','征召海军'],['build_navy','建设海军']] as const){const s=game();startResolution(s,'选择地区','germany',[{kind:'action',country:'germany',action,regions:action.endsWith('navy')?['sea_baltic','sea_north_sea']:['germany','eastern_europe'],label:word}],[],undefined,'discardPile',true);expect(s.resolution?.choice?.prompt).toContain(word);expect(s.resolution?.choice?.prompt).not.toContain('组建');}
});
it('corrected names, geography and French government are available without breaking old saves',()=>{
 expect(specialCard('prelude_JP-19',true)?.name).toBe('伪满洲国');expect(specialCard('special_248',true)?.name).toBe('东清铁路运输');expect(specialCard('special_5',true)?.country).toBe('france');expect(specialCard('special_5')?.country).toBe('united_kingdom');
 expect(BALANCE_CARDS.find(c=>c.id==='prelude_UK-10')?.text).toContain('<不列颠群岛>');expect(BALANCE_CARDS.every(c=>!c.text.includes('组建')&&!c.text.includes('弃牌库'))).toBe(true);
 const s=game(),gov=move(s,'special_5','hand'),search=move(s,'special_29','hand');s.decks.united_kingdom.hand=s.decks.united_kingdom.hand.filter(c=>c.id!==gov.id);s.decks.united_kingdom.drawPile.push(gov);gov.country='united_kingdom';validateState(s);
 const effect=fullCardEffects(s,search,[])!.find((e):e is Extract<Effect,{kind:'cards'}>=>e.kind==='cards')!;expect(effect.allowedIds).toContain(gov.id);
});
it('guided Magic and Blue Division never ask their victim to execute the effect',()=>{
 for(const [actor,target,id] of [['united_states','japan','special_92','special_195'],['italy','soviet_union','special_241','special_69']] as const){
 const s=game();s.activeSeat=actor;s.settings.ignoreOtherPlayerInterrupts=false;const source=move(s,id,'hand');const responses=s.decks[target].drawPile.filter(c=>specialCard(c.definitionId,c.balance)?.type==='响应').slice(0,2);for(const c of responses)move(s,c.definitionId,'faceDown');
 startResolution(s,source.definitionId,actor,fullCardEffects(s,source,[])!,[],source.id,'discardPile',true);
 for(let i=0;s.resolution?.running&&i<30;i++){const q=s.resolution!.choice!;expect(q.seat).toBe(actor);reply(s,[q.options.find(o=>o.id==='hidden')?.id??q.options[0].id]);}
 expect(s.resolution?.running).toBe(false);const notices=s.responseNotices!.filter(n=>n.recipients.includes(target));expect(notices).toHaveLength(1);expect(notices[0].text).toContain('揭开了');expect(notices[0].text).toContain('弃置了');expect(notices[0].cards).toHaveLength(2);
 }
});
it('Bordeaux modifies submarine discard before the victim gets one five-card result',()=>{
 const s=game();s.settings.ignoreOtherPlayerInterrupts=false;const source=move(s,'special_169','hand');move(s,'special_230','hand');const before=s.decks.united_states.drawPile.slice(0,5).map(c=>c.id);
 startResolution(s,source.definitionId,'germany',fullCardEffects(s,source,[])!,[],source.id,'discardPile',true);
 let bordeaux=false;
 for(let i=0;s.resolution?.running&&i<50;i++){const q=s.resolution!.choice!;expect(q).toBeTruthy();expect(q.seat).not.toBe('united_states');if(q.kind==='TRIGGER'){const o=q.options.find(o=>o.label.includes('波尔多'));if(o){expect(s.decks.united_states.discardPile).toHaveLength(0);expect(s.responseNotices?.filter(n=>n.recipients.includes('united_states'))??[]).toHaveLength(0);bordeaux=true;reply(s,[o.id]);}else reply(s,[]);}else reply(s,[q.options[0].id]);}
 expect(bordeaux).toBe(true);expect(s.resolution?.running).toBe(false);expect(s.decks.united_states.discardPile.map(c=>c.id)).toEqual(before);
 const notices=s.responseNotices!.filter(n=>n.recipients.includes('united_states'));expect(notices).toHaveLength(1);expect(notices[0].title).toBe('弃牌结果');expect(notices[0].cards.map(c=>c.id)).toEqual(before);
});
