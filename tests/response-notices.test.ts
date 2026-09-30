import {expect,it} from 'vitest';
import {createGame,transition,SEATS} from '../src/core';
import type {GameState,Command} from '../src/core';
import {responsePreset} from '../src/controller/responsePresets';
import {startResolution} from '../src/core/resolution';
import {validateState} from '../src/controller/saveFormat';
function send(s:GameState,p:Record<string,unknown>){const r=transition(s,{seat:s.operatorSeat,expectedRevision:s.revision,...p} as Command);if(!r.ok)throw Error(r.error);return r.state;}
function choose(s:GameState,ids:string[]){return send(s,{type:'RESOLVE_ENGINE_CHOICE',choiceId:s.resolution!.choice!.id,ids});}
function bletchley(){let s=responsePreset('bletchley','notices').state;s=choose(s,[s.resolution!.choice!.options.find(o=>o.label==='云量')!.id]);s=choose(s,[s.resolution!.choice!.options.find(o=>o.label==='布莱切利园')!.id]);return choose(s,[s.resolution!.choice!.options[0].id]);}
it('retains a public cancellation notice for Germany with both card references',()=>{
 const s=bletchley(),n=s.responseNotices!.find(n=>n.recipients.includes('germany'))!;
 expect(n.text).toContain('英国使用增强【布莱切利园】，响应德国的增强【云量】');expect(n.text).toContain('此增强卡无效');
 expect(n.cards.map(c=>c.definitionId)).toEqual(expect.arrayContaining(['special_39','special_142']));
 expect(n.readBy).toEqual([]);expect(()=>validateState(JSON.parse(JSON.stringify(s)))).not.toThrow();
});
it('acknowledgement only marks that recipient, does not advance or change resolution',()=>{
 let s=bletchley();s=send(s,{type:'SET_VIEW',seat:'germany'});const before=structuredClone(s),n=s.responseNotices![0];
 s=send(s,{type:'ACK_RESPONSE_NOTICE',seat:'germany',noticeId:n.id});
 expect(s.revision).toBe(before.revision);expect(s.phase).toBe(before.phase);expect(s.resolution).toEqual(before.resolution);expect(s.decks).toEqual(before.decks);
 expect(s.responseNotices![0].readBy).toEqual(['germany']);
 expect(transition(s,{type:'ACK_RESPONSE_NOTICE',seat:'japan',noticeId:n.id,expectedRevision:s.revision}).ok).toBe(false);
 expect(()=>validateState(JSON.parse(JSON.stringify(s)))).not.toThrow();
});
it('notifies both the intervening country and original actor when a third country counters',()=>{
 let s=createGame('nested-notices',1940);s.status='PLAYING';s.phase='PLAY';s.round=1;s.setupCompleted=[...SEATS];s.settings.ignoreOtherPlayerInterrupts=false;
 const root=s.decks.germany.hand[0],british=s.decks.united_kingdom.hand.shift()!,american=s.decks.united_states.hand.shift()!;
 s.decks.united_kingdom.active.push(british);s.decks.united_states.active.push(american);
 startResolution(s,'德国行动','germany',[{kind:'trace',label:'德国行动'}],[
 {id:'british',label:'英国干预',owner:'united_kingdom',sourceInstanceId:british.id,source:'active',timing:'Before',on:'德国行动',mandatory:false,effects:[{kind:'score',seat:'germany',amount:-2,label:'德国扣两分'}]},
 {id:'american',label:'美国反制',owner:'united_states',sourceInstanceId:american.id,source:'active',timing:'Before',on:'德国扣两分',mandatory:false,effects:[{kind:'cancel',label:'取消英国扣分效果'}]},
 ],root.id);
 s=choose(s,[s.resolution!.choice!.options.find(o=>o.label==='英国干预')!.id]);s=choose(s,[s.resolution!.choice!.options.find(o=>o.label==='美国反制')!.id]);
 while(s.resolution?.choice)s=choose(s,[]);
 const counter=s.responseNotices!.find(n=>n.text.includes('取消英国扣分效果'))!;
 expect(counter.recipients).toEqual(expect.arrayContaining(['germany','united_kingdom']));expect(s.scores.germany).toBe(0);
 s=send(s,{type:'SET_VIEW',seat:'germany'});s=send(s,{type:'ACK_RESPONSE_NOTICE',seat:'germany',noticeId:counter.id});
 expect(s.responseNotices!.find(n=>n.id===counter.id)!.readBy).not.toContain('united_kingdom');
 expect(s.responseNotices!.some(n=>n.recipients.includes('germany')&&n.text.includes('德国扣两分未生效'))).toBe(true);
});
it('reports actual deck loss and empty-deck score replacement without exposing hidden hand cards',()=>{
 let s=createGame('shortage-notice',1940);s.status='PLAYING';s.phase='PLAY';s.round=1;s.settings.ignoreOtherPlayerInterrupts=false;
 const root=s.decks.germany.hand[0],response=s.decks.united_kingdom.hand.shift()!;s.decks.united_kingdom.active.push(response);
 s.decks.germany.removed.push(...s.decks.germany.drawPile.splice(1));
 startResolution(s,'德国行动','germany',[{kind:'trace',label:'德国行动'}],[{id:'reply',label:'英国干预',sourceInstanceId:response.id,owner:'united_kingdom',source:'active',timing:'Before',on:'德国行动',mandatory:false,effects:[{kind:'deckTop',seat:'germany',count:3,label:'弃置三张'}]}],root.id);
 s=choose(s,[s.resolution!.choice!.options[0].id]);
 const notices=s.responseNotices!.filter(n=>n.recipients.includes('germany'));
 expect(notices).toHaveLength(1);expect(notices[0].title).toBe('弃牌结果');
 expect(notices[0].text).toContain('牌库不足，德国扣 2 分');expect(notices[0].cards).toHaveLength(1);
});
it('air defense and interception decisions notify the other participant',()=>{
 let s=responsePreset('guided-battle','air-notices').state;
 const c=s.decks.germany.hand.find(c=>c.definitionId==='land_battle')!;
 s=send(s,{type:'PLAY_CARD',guided:true,cardId:c.id,effectIndices:[0],targetIds:[]});
 let guard=0;
 while(s.resolution?.choice?.kind!=='AIR_DEFENSE'&&guard++<10){const c=s.resolution!.choice!;s=choose(s,[c.options.find(o=>o.id==='western_europe'||o.label.includes('英国'))?.id??c.options[0].id]);}
 expect(s.responseNotices!.filter(n=>n.title==='受到攻击')).toHaveLength(1);
 expect(s.responseNotices!.find(n=>n.title==='受到攻击')).toMatchObject({recipients:['united_kingdom'],text:expect.stringContaining('德国向西欧')});
 expect(s.resolution!.choice!.prompt).toContain('西欧');
 expect(s.resolution!.choice!.kind).toBe('AIR_DEFENSE');s=choose(s,['yes']);
 expect(s.responseNotices!.some(n=>n.recipients.includes('germany')&&n.text.includes('英国选择进行空军防御'))).toBe(true);
 expect(s.resolution!.choice!.kind).toBe('AIR_INTERCEPT');s=choose(s,['yes']);
 expect(s.responseNotices!.some(n=>n.recipients.includes('united_kingdom')&&n.text.includes('德国选择进行空军拦截'))).toBe(true);
});
