import { createGame, SEATS, transition } from '../../src/core';
import type { Command, CountryId, GameState, SeatId, Unit } from '../../src/core';
import { placementPlans } from '../../src/core/placement';
import { countryScore, suppliedUnits, unsuppliedForPhase } from '../../src/core/supply';
import { startResolution } from '../../src/core/resolution';
import type { Question } from './input';

type Report = { question: Question; expected: string; evidence: unknown };
export type Fixture = { id: string; source: string; seed: number; seat: SeatId; state: GameState; fact?: Report };
type FixtureSpec = Omit<Fixture, 'seed' | 'state' | 'fact'> & {
  prepare: (s:GameState)=>GameState | void;
  check?: (s:GameState)=>Report;
  opening?:boolean;
  prelude?:boolean;
  neutrality?:boolean;
  balance?:boolean;
};
const unit = (id:string,country:CountryId,regionId:string,type:Unit['type']='army'):Unit => ({id,country,regionId,type});
const yes = (v:boolean) => v ? '是' : '否';
function claim(text:string, expected:string, evidence:unknown, kind:Question['kind']='rule_application'):Report {
  return {question:{text:text+' 只填字符串 answer。',kind},expected,evidence};
}
function supply(s:GameState,id:string) {
  const value = suppliedUnits(s).has(id);
  return claim('当前观察中，单位 '+id+' 是否有补给？回答是或否。',yes(value),{id,supplied:value},'fact_read');
}

function apply(s:GameState, command:Command):GameState {
  const result=transition(s,command);
  if(!result.ok) throw Error('诊断局面准备失败 '+command.type+' '+result.error);
  return result.state;
}

function play(s:GameState, seat:SeatId, definition:string) {
  const c=moveCard(s,seat,definition,'hand');
  return apply(s,{type:'PLAY_CARD',seat,expectedRevision:s.revision,cardId:c.id,
    effectIndices: [0],targetIds:[],guided:true});
}
function answer(s:GameState,ids:string[]) {
  const q=s.resolution?.choice;
  if(!q) throw Error('诊断局面缺少结算选择');
  if(s.viewSeat!==q.seat) s=apply(s,{type:'SET_VIEW',seat:q.seat,expectedRevision:s.revision});
  return apply(s,{type:'RESOLVE_ENGINE_CHOICE',seat:q.seat,expectedRevision:s.revision,choiceId:q.id,ids,guided:true});
}

function moveCard(s:GameState,seat:SeatId,definition:string,zone:'hand'|'active'|'faceDown') {
  const d=s.decks[seat];
  for(const from of ['hand','drawPile','discardPile'] as const) {
    const index=d[from].findIndex(c=>c.definitionId===definition);
    if(index<0) continue;
    const [c]=d[from].splice(index,1);
    d[zone].push(c);
    return c;
  }
  throw Error('诊断所需卡不在 '+seat+' 牌组：'+definition);
}

function guidedTarget(s:GameState,region:string,until:string) {
  for(let i=0;i<12;i++) {
    const q=s.resolution?.choice;
    if(!q) break;
    if(q.kind===until) return s;
    const option=q.options.find(o=>o.id===region)
      ?? (q.options.length===1 ? q.options[0] : undefined);
    if(!option) throw Error('无法准备目标 '+region+'，当前为 '+q.prompt);
    s=answer(s,[option.id]);
  }
  throw Error('未到达 '+until);
}

function ports(s:GameState, second:string) {
  moveCard(s,'united_states','special_80','active');
  moveCard(s,'united_states','special_84','active');
  s.units=[
    unit('us-home','united_states','united_states'),
    unit('us-uk','united_states','british_isles'),
    unit('us-north','united_states','sea_north_atlantic','navy'),
    unit('uk-fr','united_kingdom','western_europe'),
    unit('us-af','united_states','north_africa'),
  ];
  s=guidedTarget(play(s,'united_states','build_navy'),'sea_north_sea','TRIGGER');
  const shipyard=s.resolution!.choice!.options.find(o=>o.id.includes('special_84'));
  if(!shipyard) throw Error('诊断缺少先进造船厂窗口');
  return guidedTarget(answer(s,[shipyard.id]),second,'TRIGGER');
}

export function fixtures():Fixture[] {
  const specs:FixtureSpec[]=[];
  const add=(s:FixtureSpec)=>specs.push(s);
  for (const linked of [false,true]) {
    add({id:'own-land-'+linked,seat:'germany',source:'补给根与本国链对照',prepare:s=>{
      s.units=[unit('probe','germany','balkans'), ...(linked?[unit('root','germany','germany'),unit('link','germany','eastern_europe')]:[])];
    },check:s=>supply(s,'probe')});
    add({id:'ally-land-'+linked,seat:'germany',source:'盟军链与本国链对照',prepare:s=>{
      const country=linked?'germany':'italy';
      s.units=[unit('probe','germany','balkans'),unit('root',country,linked?'germany':'italy'),
        unit('link',country,'eastern_europe')];
    },check:s=>supply(s,'probe')});
    add({id:'naval-anchor-'+linked,seat:'germany',source:'舰队链有无友方陆军锚点',prepare:s=>{
      s.units=[unit('root','germany','western_europe'),unit('link','germany','sea_north_sea','navy'),
        unit('probe','germany','sea_north_atlantic','navy'),...(linked?[unit('anchor','italy','iceland')]:[])];
    },check:s=>supply(s,'probe')});
    add({id:'naval-source-'+linked,seat:'germany',source:'友陆军可锚定但不提供德国补给根',prepare:s=>{
      s.units=[unit('anchor','italy','iceland'),unit('probe','germany','sea_north_atlantic','navy'),
        unit('link','germany','sea_north_sea','navy'),...(linked?[unit('root','germany','western_europe')]:[])];
    },check:s=>supply(s,'probe')});
    add({id:'phase-check-'+linked,seat:linked?'germany':'italy',source:'当前回合负责国与他国的补给移除对照',prepare:s=>{
      s.units=[unit('probe','germany','balkans'),unit('italy-home','italy','italy')];
      s.phase='AIR';
      moveCard(s,s.activeSeat,'air_power','hand');
    },check:s=>{
      const removed=unsuppliedForPhase(s,s.activeSeat);
      return claim('若在当前版图直接开始当前行动国的补给检查，忽略后续改变及移除响应，probe 是否列入待清除名单？回答是或否。',
        yes(removed.includes('probe')),{checkSeat:s.activeSeat,removed});
    }});
    add({id:'connect-before-check-'+linked,seat:'germany',source:'征召后在检查前补链的反事实对照',prepare:s=>{
      s.units=[unit('probe','germany','balkans'),unit('root','germany','germany')];
      if(!linked) s.units.push(unit('block','soviet_union','eastern_europe'));
      moveCard(s,'germany','build_army','hand');
    },check:s=>{
      const plans=placementPlans(s,{country:'germany',unitType:'army',mode:'build',regionIds:['eastern_europe']});
      const after={...s,units:[...s.units,unit('counterfactual','germany','eastern_europe')]};
      const connected=plans.length>0 && !unsuppliedForPhase(after,'germany').includes('probe');
      return claim('若德国现在仅尝试在东欧新建设陆军，且接下来无人改变局势，能否合法建设并使 probe 在补给检查时有补给？回答是或否。',
        yes(connected),{plans,checkAfterBuild:connected});
    }});
  }
  for(const mode of ['build','recruit'] as const) for(const blocked of [false,true]) {
    add({id:mode+'-remote-'+blocked,seat:'germany',source:'远端建设与牌面定点征召，含敌占对照',prepare:s=>{
      s.units=[unit('root','germany','germany'),...(blocked?[unit('enemy','soviet_union','mongolia')]:[])];
      moveCard(s,'germany','build_army','hand');
    },check:s=>{
      const plans=placementPlans(s,{country:'germany',unitType:'army',mode,regionIds:['mongolia']});
      return claim('假设给德国一次'+(mode==='build'?'普通建设':'明确允许蒙古地区的征召')+
        '陆军效果。当前版图能否在蒙古放置陆军？回答是或否。',yes(plans.length>0),{mode,plans});
    }});
  }
  for(const occupied of [false,true]) {
    add({id:'score-home-'+occupied,seat:'germany',source:'计分点共占及失去大本营的资格对照',prepare:s=>{
      s.units=[unit('shared-de','germany','ukraine'),unit('shared-it','italy','ukraine'),
        ...(occupied?[unit('enemy','united_kingdom','germany')]:[])];
    },check:s=>claim('若版图保持不变，现在只结算德国的版图基础分，不算卡效及盟友，德国共得几分？填写数字字符串。',
      String(countryScore(s,'germany')),{points:countryScore(s,'germany')})});
  }
  add({id:'battle-air',seat:'united_kingdom',source:'基本陆战进入正式防御窗口',prepare:s=>{
    s.units=[unit('attacker','germany','germany'),unit('defender','united_kingdom','western_europe'),
      unit('def-air','united_kingdom','western_europe','air')];
    return guidedTarget(play(s,'germany','land_battle'),'western_europe','AIR_DEFENSE');
  },check:s=>claim('当前窗口是否允许英国选择空军防御？回答是或否。',yes(s.resolution?.choice?.kind==='AIR_DEFENSE'),
    {kind:s.resolution?.choice?.kind},'fact_read')});
  add({id:'direct-destroy',seat:'italy',source:'贝塔松直接消灭与空军防御对照',prepare:s=>{
    s.units=[unit('it-home','italy','italy'),unit('victim','united_kingdom','sea_north_sea','navy'),
      unit('victim-air','united_kingdom','sea_north_sea','air')];
    moveCard(s,'italy','special_253','hand');
  },check:s=>{
    // Resolve this specific effect on a separate verification branch, never fed to the model.
    const probe=play(structuredClone(s),'italy','special_253');
    let next=probe, seenDefense=false;
    for(let i=0;i<8 && next.resolution?.choice;i++){
      const q=next.resolution.choice;
      if(q.kind==='AIR_DEFENSE'){seenDefense=true;break;}
      if(q.kind==='RELOCATE'||q.kind==='TRIGGER')break;
      next=answer(next,[q.options[0].id]);
    }
    if(!seenDefense&&next.units.some(u=>u.id==='victim')) throw Error('直接消灭验证未到效果执行');
    return claim('在此版图打出贝塔松，选北海英国海军，单凭同地区英国空军能否进入空军防御选择？回答是或否。',
      yes(seenDefense),{seenDefense,victimPresent:next.units.some(u=>u.id==='victim')});
  }});
  for(const second of ['sea_mediterranean','sea_north_atlantic']) {
    add({id:'mulberry-'+second,seat:'united_states',source:'实战第二局机制：用实际造船厂接出第二个同名人工港窗口',
      prepare:s=>ports(s,second),check:s=>{
        const r=s.resolution!;
        const origins=r.choice!.options.filter(o=>o.id.includes('special_80')).map(o=>{
          const event=r.events.find(e=>e.id===r.windows.find(w=>w.id===o.windowId)?.originEventId);
          return event?.effect?.kind==='action' ? event.effect.option?.regionId : undefined;
        });
        if(new Set(origins).size!==2 || origins.includes(undefined)) throw Error('人工港两来源未复现');
        return claim('两个同名人工港候选是否来自不同的海域建设？回答是或否。',yes(true),{origins},'fact_read');
      }});
  }
  for(const repeat of [false,true]) {
    add({id:'repeat-navy-'+repeat,seat:'united_states',source:'重复建设的实际触发对照',prepare:s=>{
      s.units=[unit('us-home','united_states','united_states'),unit('navy','united_states','sea_north_atlantic','navy')];
      if(repeat) moveCard(s,'united_states','special_80','active');
      moveCard(s,'united_states','build_navy','hand');
    },check:s=>{
      let next=play(structuredClone(s),'united_states','build_navy');
      if(next.resolution?.choice?.kind==='ACTION')next=answer(next,['sea_north_atlantic']);
      const triggered=!!next.resolution?.choice?.options.some(o=>o.id.includes('special_80'));
      return claim('假设选择在北大西洋原地重复建设海军，是否会出现人工港候选？回答是或否。',
        yes(triggered),{triggered,placements:next.events.filter(e=>e.type==='UNIT_PLACED')});
    }});
  }
  for(const hasCost of [false,true]) {
    add({id:'fleet-fee-'+hasCost,seat:'germany',source:'正式增强波罗的海舰队出动：费用与北海建设条件',prepare:s=>{
      s.phase='DISCARD';
      s.units=[unit('root','germany','germany'),unit('west','germany','western_europe'),
        unit('baltic','germany','sea_baltic','navy')];
      const deck=s.decks.germany;
      deck.drawPile.push(...deck.hand.filter(c=>c.definitionId==='build_navy'));
      deck.hand=deck.hand.filter(c=>c.definitionId!=='build_navy');
      moveCard(s,'germany','special_145','hand');
      if(hasCost) moveCard(s,'germany','build_navy','hand');
      startResolution(s,'弃牌阶段开始','germany',[{kind:'signal',tag:'PHASE:DISCARD',label:'弃牌阶段开始'}],[],
        undefined,'discardPile',true);
      const q=s.resolution?.choice;
      const offer=q?.options.find(o=>o.id.includes('special_145'));
      if(hasCost){
        if(!offer) throw Error('未产生波罗的海舰队出动');
        const next=answer(s,[offer.id]);
        if(next.resolution?.choice?.kind!=='PAY_COST') throw Error('未产生正式付费窗口');
        return next;
      }
      if(offer) throw Error('缺少建设海军仍产生费用候选');
    },check:s=>{
      const payment=s.resolution?.choice?.requirements?.includes('build_navy')??false;
      return claim(hasCost?'当前是否必须用一张建设海军支付发动费用？回答是或否。':
        '当前手牌没有建设海军，能否在此时发动波罗的海舰队出动？回答是或否。',
        yes(payment),{payment,choice:s.resolution?.choice?.kind},hasCost?'fact_read':'rule_application');
    }});
  }
  add({id:'opening-seven',seat:'germany',source:'真实十二选七起手',opening:true,prepare:()=>{},check:s=>
    claim('德国起手选择需保留几张？填写数字字符串。',String(Math.min(7,s.decks.germany.hand.length)),{min:7,max:7},'fact_read')});
  add({id:'discard-none',seat:'italy',source:'正式弃牌允许不弃',prepare:s=>{s.phase='DISCARD';},check:()=>
    claim('当前弃牌候选是否允许空数组？回答是或否。','是',{min:0},'fact_read')});
  add({id:'discard-forced-two',seat:'united_kingdom',source:'强制弃牌二选多的固定请求',prepare:s=>{
    s.pendingDiscard={seat:'united_kingdom',returnSeat:'united_kingdom',count:2};
  },check:s=>claim('当前必须弃几张？填写数字字符串。',String(s.pendingDiscard!.count),{min:2,max:2},'fact_read')});
  add({id:'prelude-neutrality',seat:'germany',source:'完整序章、中立与平衡开关并存',opening:true,prelude:true,neutrality:true,prepare:()=>{}});
  if(specs.length!==30)throw Error('应有30个固定局面，实际 '+specs.length);
  return specs.map((spec,index)=>{
    const seed=20261105+index;
    let s=createGame('qwen-'+spec.id,seed,'FULL',spec.prelude??false,spec.neutrality??false,spec.balance??true);
    if(!spec.opening){
      s.status='PLAYING';s.phase='PLAY';s.round=1;s.setupCompleted=[...SEATS];
      // Card instances retain formal ownership and complete decks.
      for(const d of Object.values(s.decks))d.drawPile.push(...d.hand.splice(7));
      s.activeSeat=s.viewSeat=s.operatorSeat=spec.id==='battle-air'?'germany':spec.seat;
    }
    s=spec.prepare(s)??s;
    return {id:spec.id,source:spec.source,seed,seat:spec.seat,state:s,fact:spec.check?.(s)};
  });
}


export type ExpressionCase = Fixture & {
  cohort:'historical'|'corrected'|'new'|'permuted';
  pair?:string;
  original?:string;
};

export function expressionCases(history=fixtures()):ExpressionCase[] {
  const cases:ExpressionCase[]=history.map(f=>({...f,cohort:'historical',
    ...(f.id.startsWith('score-home-')&&f.fact?{fact:{...f.fact,question:{...f.fact.question,kind:'fact_read'}}}:{})}));
  const fresh=(pair:string, variant:string, seed:number, seat:SeatId='germany'):ExpressionCase=>{
    const state=createGame('qwen-expression-'+pair,seed,'FULL',false,false,true);
    state.status='PLAYING';state.phase='PLAY';state.round=1;state.setupCompleted=[...SEATS];
    state.activeSeat=state.viewSeat=state.operatorSeat=seat;
    for(const deck of Object.values(state.decks))deck.drawPile.push(...deck.hand.splice(7));
    return {id:pair+'-'+variant,source:pair,pair,cohort:'new',seed,seat,state};
  };
  function requireFact(ok:boolean,id:string){
    if(!ok)throw Error('表达对照局面与正式规则核验不符 '+id);
  }
  function landPlan(s:GameState){
    return placementPlans(s,{country:'germany',unitType:'army',mode:'build',regionIds:['eastern_europe']});
  }

  for(const changed of [false,true]){
    const variant=changed?'yes':'no';
    const repair=fresh('correct-connect',variant,20261201);
    const s=repair.state;
    s.units=[unit('probe','germany','ross_region'),unit('root','germany','germany'),
      ...(!changed?[unit('block','soviet_union','eastern_europe')]:[])];
    moveCard(s,'germany','build_army','hand');
    const before=suppliedUnits(s).has('probe'), plans=landPlan(s);
    requireFact(!before&&(plans.length>0)===changed,repair.id);
    let connected=false;
    if(plans.length){
      const next=answer(play(structuredClone(s),'germany','build_army'),['eastern_europe']);
      connected=suppliedUnits(next).has('probe')&&!unsuppliedForPhase(next,'germany').includes('probe');
    }
    requireFact(connected===changed,repair.id);
    cases.push({...repair,cohort:'corrected',original:'connect-before-check-'+changed,
      fact:claim('若德国现在尝试在东欧建设陆军，之后无人改变局势，能否合法建设并让罗斯地区的 probe 在补给检查时有补给？回答是或否。',
        yes(connected),{before,plans,connected})});

    const chain=fresh('new-home-chain',variant,20261202);
    chain.state.units=[unit('ross-a','germany','ross_region'),unit('root-a','germany','germany'),
      unit('link-a',changed?'germany':'italy','eastern_europe')];
    requireFact(suppliedUnits(chain.state).has('ross-a')===changed,chain.id);
    cases.push({...chain,fact:supply(chain.state,'ross-a')});

    const anchor=fresh('new-naval-anchor',variant,20261203);
    anchor.state.units=[unit('shore-b','germany','western_europe'),unit('fleet-b','germany','sea_north_sea','navy'),
      unit('ocean-b','germany','sea_north_atlantic','navy'),...(changed?[unit('anchor-b','italy','iceland')]:[])];
    requireFact(suppliedUnits(anchor.state).has('ocean-b')===changed,anchor.id);
    cases.push({...anchor,fact:supply(anchor.state,'ocean-b')});

    const enemy=fresh('new-enemy-placement',variant,20261204);
    enemy.state.units=[unit('root-c','germany','germany'),...(changed?[unit('block-c','soviet_union','eastern_europe')]:[])];
    moveCard(enemy.state,'germany','build_army','hand');
    const plansC=landPlan(enemy.state);
    requireFact((plansC.length>0)===!changed,enemy.id);
    cases.push({...enemy,fact:claim('德国现在能否用普通建设陆军放置部队到东欧？回答是或否。',
      yes(plansC.length>0),{plans:plansC})});

    const repeat=fresh('new-repeat-trigger',variant,20261205,'united_states');
    repeat.state.units=[unit('home-d','united_states','united_states'),unit('navy-d','united_states','sea_north_atlantic','navy'),
      unit('extra-d','united_states','canada')];
    if(changed)moveCard(repeat.state,'united_states','special_80','active');
    const repeated=answer(play(structuredClone(repeat.state),'united_states','build_navy'),['sea_north_atlantic']);
    const triggered=!!repeated.resolution?.choice?.options.some(o=>o.id.includes('special_80'));
    requireFact(triggered===changed,repeat.id);
    cases.push({...repeat,fact:claim('在北大西洋原地重复建设海军，是否会出现人工港候选？回答是或否。',
      yes(triggered),{triggered,choice:repeated.resolution?.choice?.kind})});

    const fee=fresh('new-fee-category',variant,20261206);
    const navy=moveCard(fee.state,'germany','build_navy','hand');
    moveCard(fee.state,'germany','build_army','hand');
    const category=changed?'build_navy':'build_army';
    startResolution(fee.state,'诊断指定费用','germany',[
      {kind:'cards',seat:'germany',from:'hand',to:'discardPile',min:1,max:1,fee:true,requirements:[category],label:'支付一张指定类别手牌'},
      {kind:'draw',seat:'germany',count:1,label:'结算验证'}],[],undefined,'discardPile',true);
    const q=fee.state.resolution?.choice;
    requireFact(q?.kind==='CARDS'&&q.options.some(o=>o.id===navy.id),fee.id);
    const accepted=transition(structuredClone(fee.state),{type:'RESOLVE_ENGINE_CHOICE',seat:'germany',
      expectedRevision:fee.state.revision,choiceId:q!.id,ids:[navy.id],guided:true}).ok;
    requireFact(accepted===changed,fee.id);
    cases.push({...fee,fact:claim('如果只选一张建设海军作支付，能否满足这个窗口的费用？回答是或否。',
      yes(accepted),{category,accepted})});

    const discard=fresh('new-forced-count',variant,20261207,'united_kingdom');
    discard.state.activeSeat='germany';
    const count=changed?2:1;
    discard.state.pendingDiscard={seat:'united_kingdom',returnSeat:'germany',count};
    const choose=(n:number)=>transition(structuredClone(discard.state),{type:'RESOLVE_FORCED_DISCARD',seat:'united_kingdom',
      expectedRevision:discard.state.revision,cardIds:discard.state.decks.united_kingdom.hand.slice(0,n).map(c=>c.id)}).ok;
    requireFact(choose(count)&&!choose(count===1?2:1),discard.id);
    cases.push({...discard,fact:claim('当前这个强制弃牌窗口必须选几张不同手牌？填写数字字符串。',
      String(count),{count},'fact_read')});
  }
  for(const original of ['mulberry-sea_mediterranean','discard-forced-two']){
    const f=history.find(v=>v.id===original)!;
    cases.push({...f,id:'permuted-'+original,cohort:'permuted',original,source:'候选及键内选项逆序'});
  }
  return cases;
}
