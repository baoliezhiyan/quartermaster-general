import { SEATS } from './types';
import type { GameState } from './types';
import type { Effect, TriggerRule } from './resolutionTypes';
import { startResolution } from './resolution';

export const RESOLUTION_SCENARIOS = [
  { id:'nested',name:'1 · 子结算优先',hint:'自动得到 A → B1 → C1 → C2 → B2。' },
  { id:'windows',name:'2 · 祖先时点保留与截断',hint:'A 可触发 B、C；B1 可触发 D。选择 B 后，可先 D 再 C，也可直接选 C，令 D 错过时点。B2 仍会继续。' },
  { id:'cancel',name:'3 · 生效前取消',hint:'A 原本令行动国扣 3 分。暗置响应可取消它；取消后不执行扣分，也不触发成功后的奖励。' },
  { id:'order',name:'4 · 必发效果由玩家排序',hint:'A 同时触发 B、C。点击决定完整顺序，每项的子结算也必须先完成。' },
  { id:'forced',name:'5 · 对手必须作出选择',hint:'让下一席位摸 2 张，再强制弃 2 张；忽略他国可选响应仍不能跳过这次弃牌。' },
  { id:'sources',name:'6 · 来源、费用与候选快照',hint:'仅列出已暗置响应和可支付的手牌增强。他国可选牌、手牌响应及此时不满足条件的牌不出现。可先“清空费用手牌”令增强失效，或先增强付款；每项子结算后重新检查剩余候选。' },
] as const;

export function startScenario(s:GameState,id:string):boolean {
  if(!RESOLUTION_SCENARIOS.some(v=>v.id===id) || s.resolution?.running) return false;
  // Only prior lab fixtures are removed; ordinary game cards are never replaced.
  for(const seat of SEATS) for(const zone of ['hand','drawPile','discardPile','resolving','active','faceDown','removed'] as const) s.decks[seat][zone]=s.decks[seat][zone].filter(c=>!c.id.startsWith('lab5:'));
  const owner=s.activeSeat, other=SEATS[(SEATS.indexOf(owner)+1)%6];
  const trace=(label:string):Effect=>({kind:'trace',label});
  const rules:TriggerRule[]=[];
  const fixture=(name:string,seat=owner,zone:'active'|'faceDown'|'hand'='active')=>{
    const cardId=`lab5:${s.revision}:${name}`;
    s.decks[seat][zone].push({id:cardId,definitionId:`示例 ${name}`,deckOwner:seat,country:seat});
    return cardId;
  };
  const add=(name:string,on:string,effects:Effect[],mandatory=true,extra:Partial<TriggerRule>={})=>{
    const seat=extra.owner??owner, source=extra.source??'active';
    const zone=source==='response' || extra.faceDownEnhancement ? 'faceDown' : source==='enhancement' ? 'hand':'active';
    rules.push({id:name,label:name,sourceInstanceId:fixture(name,seat,zone),owner:seat,on,timing:'After',mandatory,source,effects,...extra});
  };
  let effects:Effect[]=[trace('A')];
  if(id==='nested' || id==='windows' || id==='order') {
    add('B','A',[trace('B1'),trace('B2')],id!=='windows');
    if(id==='nested') add('C','B1',[trace('C1'),trace('C2')]);
    else {
      add('C','A',[trace('C')],id==='order');
      add('D','B1',[trace('D')],id==='order');
    }
  } else if(id==='cancel') {
    effects=[{kind:'score',label:'A：扣 3 分',seat:owner,amount:-3}];
    add('取消 A','A：扣 3 分',[{kind:'cancel',label:'阻止扣分'}],false,{source:'response',timing:'Before'});
    add('成功后奖励','A：扣 3 分',[{kind:'score',label:'成功后加 1 分',seat:owner,amount:1}]);
  } else if(id==='forced') {
    effects=[{kind:'draw',label:'对手摸 2 张',seat:other,count:2},{kind:'forceHand',label:'对手强制弃 2 张',seat:other,count:2},trace('返回父结算')];
    add('不应出现的他国可选连携','对手摸 2 张',[trace('错误')],false,{owner:other});
  } else if(id==='sources') {
    add('已暗置响应','A',[trace('响应完成')],false,{source:'response'});
    add('增强：付 2 张后摸 1 张','A',[{kind:'draw',label:'增强摸牌',seat:owner,count:1}],false,{source:'enhancement',cost:2});
    add('清空费用手牌','A',[{kind:'forceHand',label:'强制弃置全部现有手牌',seat:owner,count:100}],false);
    add('他国可选响应（不应出现）','A',[trace('错误')],false,{owner:other,source:'response'});
    add('未暗置响应（不应出现）','A',[trace('错误')],false,{source:'response'});
    const unprepared=rules[rules.length-1].sourceInstanceId;
    const card=s.decks[owner].faceDown.find(c=>c.id===unprepared)!;
    s.decks[owner].faceDown=s.decks[owner].faceDown.filter(c=>c.id!==unprepared); s.decks[owner].hand.push(card);
    add('后来才有足够手牌（旧窗口不补入）','A',[trace('错误')],false,{minHand:s.decks[owner].hand.length+2});
  }
  const root=fixture('根效果',owner,'hand');
  return startResolution(s,RESOLUTION_SCENARIOS.find(v=>v.id===id)!.name,owner,effects,rules,root);
}
