/// <reference types="vite/client" />
import { compileOffer } from '../../src/localAi/contract';
import type { Offer, Submission } from '../../src/localAi/contract';
import type { observePlayer } from '../../src/localAi/observation';
import type { referenceData } from '../../src/localAi/reference';
import { BASIC_NAMES } from '../../src/core/basic';
import { coversCost, matchesCard } from '../../src/core/cardCosts';
import { PHASE_NAMES } from '../../src/core/game';
import rulesDocument from './rules.md?raw';

export type Observation = Extract<ReturnType<typeof observePlayer>, { public: unknown }>;
type VisibleCard = Observation['privateCountries'][string]['hand'][number];
type Reference = Awaited<ReturnType<typeof referenceData>>['data'];
export type Question = { text: string; kind: 'fact_read' | 'rule_application' };
export const PROMPT_VERSION = 'qm-qwen-baseline/2.1';
export const EXPRESSION_VERSION = 'qm-qwen-expression/1';
export type Expression = 'A' | 'B';
export const PROTOCOL_VERSION = 'qm-qwen-decision/2';

const modules = new Map(rulesDocument.trim().split(/^## /m).filter(Boolean).map(section => {
  const newline = section.indexOf('\n');
  return [section.slice(0,newline).trim(),section.slice(newline+1).trim()];
}));
const basicText: Record<keyof typeof BASIC_NAMES,string> = {
  build_army:'建设一支本国陆军。',land_battle:'发起一次本国陆战。',build_navy:'建设一支本国海军。',
  sea_battle:'发起一次本国海战。',air_power:'部署本国空军，或以本国空军争取制空权。',
};
const kindName: Record<string,string> = {army:'陆军',navy:'海军',air:'空军'};
const zoneName: Record<string,string> = {hand:'手牌',drawPile:'牌库',discardPile:'弃牌堆',active:'生效牌',faceDown:'暗置牌'};
const ruleText = (o:Observation) => {
  const balance = !!o.rules?.balanceEnabled;
  return ['基础规则与身份权限', ...(o.preludeEnabled?['序章模块',...(balance?['平衡序章模块']:[])]:[]),
    ...(o.public.neutrality?['中立模块',balance?'平衡中立模块':'原版中立模块']:[]),...(balance?['平衡模块']:[])]
    .map((title,i)=> (i===0?'A. ':'B. ')+title+'\n'+modules.get(title)).join('\n\n') +
    (balance||o.preludeEnabled||o.public.neutrality?'':'\n\nB. 本局规则模块\n原版；序章和中立未开启。');
};

function relevantOffers(o: Observation) {
  const actions = o.offers.filter(v => v.command.type !== 'ACK_RESPONSE_NOTICE'
    || (o.resolutionRunning && !o.decisions.length && o.blockingNoticeSeats.includes(v.seat)));
  return actions.length ? actions : o.offers;
}
function cardIndex(o:Observation) {
  const cards = new Map<string,VisibleCard>();
  const remember = (entries:Iterable<VisibleCard>) => {
    for(const card of entries) if(card.definitionId!=='hidden') cards.set(card.id,card);
  };
  for(const d of Object.values(o.privateCountries)){
    remember([...d.hand,...d.active,...d.faceDown,...d.resolving,...d.deckComposition,...d.discard,...d.removed]);
    if(d.prelude) remember([...d.prelude.hand,...d.prelude.deckComposition,...d.prelude.discard]);
  }
  for(const d of Object.values(o.public.countries)) remember([...d.active,...d.revealedResponses,...d.visibleDiscard]);
  for(const q of o.decisions) for(const trigger of q.triggerReasons) if(trigger.sourceCard) remember([trigger.sourceCard]);
  return cards;
}
const definitionKey = (card:VisibleCard) => card.definitionId + (card.balance?'/平衡':'');
function exampleFor(offer:Offer, index:number, cards:Map<string,VisibleCard>){
  const select:Record<string,number[]> = {};
  for(const [field,spec] of Object.entries(offer.selections??{})){
    const remaining=spec.ids.map((id,n)=>({id,n}));
    const selected=[];
    const requirements=spec.requirements??[];
    for(const requirement of [...requirements.filter(r=>r!=='*'),...requirements.filter(r=>r==='*')]){
      const pos=remaining.findIndex(({id})=>{
        const card=cards.get(id);
        return requirement==='*'||!!card&&matchesCard({...card,definitionId:card.definitionId},requirement);
      });
      if(pos<0)return null;
      selected.push(remaining.splice(pos,1)[0].n);
    }
    if(selected.length>spec.max)return null;
    selected.push(...remaining.slice(0,Math.max(0,spec.min-selected.length)).map(x=>x.n));
    if(selected.length<spec.min)return null;
    select[field]=selected;
  }
  return Object.keys(select).length?{offer:index,select}:{offer:index};
}

export function makeInput(o: Observation, ref: Reference, question?: Question, previous?: unknown, expression:Expression='A') {
  if (ref.id !== o.reference.id || ref.rulesFingerprint !== o.reference.rulesFingerprint) throw Error('REFERENCE_MISMATCH');
  const offers=relevantOffers(o), cards=cardIndex(o), revised=expression==='B';
  const name=(id:unknown)=>typeof id==='string'?ref.countries[id as keyof typeof ref.countries]??id:id;
  const regionNames=new Map(ref.map.regions.map(r=>[r.id,r.name]));
  const region=(id:unknown)=>typeof id==='string'?regionNames.get(id)??id:id;
  const cardName=(id:unknown)=>typeof id==='string'?cards.get(id)?.name??BASIC_NAMES[id as keyof typeof BASIC_NAMES]??id:id;
  const phase=PHASE_NAMES[o.phase]??o.phase;
  const actionName=(id:string)=>BASIC_NAMES[id as keyof typeof BASIC_NAMES]??
    ({recruit_army:'征召陆军',recruit_navy:'征召海军',remove:'移除部队',move_air:'调度空军'} as Record<string,string>)[id]??id;
  const ownCards=(list:VisibleCard[])=>list.map(c=>[c.id,definitionKey(c)]);
  const composition=(list:VisibleCard[])=>{
    const tally=new Map<string,number>();
    for(const c of list) tally.set(definitionKey(c),(tally.get(definitionKey(c))??0)+1);
    return Object.fromEntries(tally);
  };
  const own=Object.fromEntries(Object.entries(o.privateCountries).map(([seat,d])=>[name(seat),{
    手牌:ownCards(d.hand),生效:ownCards(d.active),暗置:ownCards(d.faceDown),结算中:ownCards(d.resolving),
    牌库组成:composition(d.deckComposition),弃牌组成:composition(d.discard),移出:composition(d.removed),
    序章:d.prelude?{手牌:ownCards(d.prelude.hand),已知顶牌:d.prelude.knownTop?ownCards([d.prelude.knownTop])[0]:null,
      牌库组成:composition(d.prelude.deckComposition),弃牌组成:composition(d.prelude.discard)}:undefined,
    本回合使用:d.uses,本轮使用:d.roundUses,失效响应:d.disabledResponseIds,
    待读通知:d.notices?.filter(n=>!n.readBy.includes(seat as never)).map(n=>n.text),
  }]));
  const definitions=new Map([...cards.values()].map(c=>[definitionKey(c),c]));
  const dictionary=[...definitions.entries()].sort(([a],[b])=>a.localeCompare(b)).map(([id,c])=>
    [id,c.name,c.type,name(c.country),c.tension,basicText[c.definitionId as keyof typeof basicText]??c.text].map(x=>x??'—').join(' | '));
  const countries=Object.fromEntries(Object.entries(o.public.countries).map(([id,d])=>[name(id),{
    手牌:d.handCount,牌库:d.deckCount,弃牌总数:d.discardCount,暗置响应:d.responseCount,暗置军备:d.armamentCount,
    生效:ownCards(d.active),公开响应:ownCards(d.revealedResponses),公开弃牌历史:composition(d.visibleDiscard),
    序章:d.prelude?[d.prelude.handCount,d.prelude.deckCount,d.prelude.discardCount]:undefined,
  }]));
  const adjacency=new Map<string,{国家:unknown[];连线:unknown[]}>();
  const mapCountries=Object.fromEntries(Object.entries(o.mapFacts.countries).map(([id,{adjacency:graph,...facts}])=>{
    const signature=JSON.stringify(graph);
    let group=adjacency.get(signature);
    if(!group){
      const edges=Object.entries(graph).flatMap(([a,ns])=>ns.filter(b=>a<b).map(b=>[region(a),region(b)]));
      group={国家:[],连线:edges};adjacency.set(signature,group);
    }
    group.国家.push(name(id));
    return [name(id),{大本营:region(facts.homeRegion),补给源:facts.supplySources.map(region),
      计分点:facts.scoringRegions.map(region),当前地盘分:facts.boardScore,本土受敌占:facts.homeOccupied,
      共享补给:facts.sharesSupplyWith.filter(c=>c!==id).map(name),无条件补给:Object.entries(facts.alwaysSupplied).filter(([,on])=>on).map(([k])=>kindName[k]),
      储备陆海空:[facts.reserve.army,facts.reserve.navy,facts.reserve.air]}];
  }));
  const localizedDetails=(d:Offer['details'])=>d?{
    地区:region(d.regionId),发起部队:d.attackerId,受击部队:d.defenderId,回收:d.recycleId,
    原地重复:d.existingId,空军:d.airId,
  }:undefined;
  const decisions=new Map(o.decisions.map(q=>[q.id,q]));
  const describe=(q:Observation['decisions'][number])=>({
    国家:name(q.seat),问题:q.prompt,当前步骤:q.effectIndex,
    来源卡:cardName(q.context?.cardId)??q.context?.source,
    已定行动:q.context?.effects.filter(e=>'selection' in e&&e.selection).map(e=>'selection' in e?e.selection:undefined),
    来源窗口:q.triggerReasons.map(r=>{
      const effect=r.effect;
      return {窗口:r.windowId,时点:r.timing==='Before'?'结算前':'结算后',来源牌:r.sourceCard?.name,
        事件:effect?.kind==='action'?BASIC_NAMES[effect.action as keyof typeof BASIC_NAMES]??effect.action:effect?.kind,
        国家:effect&&'country' in effect?name(effect.country):undefined,
        地区:effect&&'regionId' in effect?region(effect.regionId):undefined};
    }),
  });
  function describeOrigin(q:Observation['decisions'][number], windows:readonly string[]){
    return windows.map(window=>{
      const origin=q.triggerReasons.find(r=>r.windowId===window), e=origin?.effect;
      const when=origin?.timing==='Before'?'结算前':origin?.timing==='After'?'结算后':'时点未显示';
      const action=e?.kind==='action'?actionName(e.action):e?.kind==='signal'&&e.phase?PHASE_NAMES[e.phase as keyof typeof PHASE_NAMES]:undefined;
      const where=e?.kind==='action'&&e.regionId?'在'+region(e.regionId):'';
      const country=e?.kind==='action'?name(e.country):'';
      const source=action?[country,where,action,when].filter(Boolean).join(''):
        origin?.sourceCard?origin.sourceCard.name+'｜'+when:'来源细节未显示';
      return '来源='+source+'｜窗口='+window;
    }).join('；');
  }
  const mapped=offers.map((offer,index)=>{
    const q=decisions.get(String(offer.command.choiceId));
    const lines=['候选 '+index+' · '+name(offer.seat)+' · '+offer.label
      +(offer.command.cardId?' · '+offer.command.cardId:'')];
    if(offer.details)lines.push('  确定目标 '+JSON.stringify(localizedDetails(offer.details)));
    if(revised&&!Object.keys(offer.selections??{}).length)lines.push('  本次只选此操作，不填写参数。'+(offer.command.type==='PLAY_CARD'?'如需后续目标，将由后续窗口询问。':''));
    for(const [key,spec] of Object.entries(offer.selections??{})){
      const requirement=spec.requirements?.map(r=>r.split('|').map(v=>v==='*'?'任意手牌':cardName(v)).join(' 或 '));
      if(revised){
        const quantity=spec.min===spec.max?'恰好 '+spec.min+' 项':spec.min+'–'+spec.max+' 项';
        lines.push('  参数键='+key+'｜填写编号数组｜数量='+quantity+'｜允许空选='+(spec.min===0?'是，填 []':'否')
          +'｜对象不得重复｜保留提交顺序='+(spec.ordered?'是':'否')
          +(requirement?.length?'｜指定费用类别='+requirement.join('、'):''));
        lines.push(...spec.ids.map((id,n)=>{
          const option=q?.options.find(v=>v.id===id);
          const windows=option?.mergedWindowIds??(option?.windowId?[option.windowId]:[]);
          const raw=cardName(option?.label??id);
          const label=cards.get(id)?.name??(option?.regionId?region(raw):(name(raw)!==raw?name(raw):region(raw)));
          return ['    选项'+n+'：'+label,'编号对应='+id,
            q&&windows.length?describeOrigin(q,windows):q?.kind==='TRIGGER'?'来源细节未显示':undefined,
            option?.regionId?'地区='+region(option.regionId):undefined,
            option?.details?JSON.stringify(localizedDetails(option.details)):undefined].filter(Boolean).join('｜');
        }));
        continue;
      }
      lines.push('  输出参数 '+key+'：编号数组，选 '+spec.min+'–'+spec.max+' 项'
        +(spec.ordered?'，保留选择顺序':'')+(requirement?.length?'；须匹配 '+requirement.join('、'):'')+'。');
      lines.push('  '+spec.ids.map((id,n)=>{
        const option=q?.options.find(v=>v.id===id), label=cards.get(id)?.name??region(cardName(option?.label??id));
        const windows=option?.mergedWindowIds??option?.windowId;
        return [n+' '+label,cards.has(id)?id:undefined,windows,region(option?.regionId),
          option?.details?JSON.stringify(localizedDetails(option.details)):undefined].filter(x=>x!==undefined).join(' · ');
      }).join('；'));
    }
    return lines.join('\n');
  });
  const middle=Math.floor(offers.length/2);
  const sample=[...offers.keys()].map(i=>(i+middle)%offers.length).map(i=>exampleFor(offers[i],i,cards)).find(Boolean);
  const activeDecision=o.decisions[0];
  const currentEffect=activeDecision?.context?.effects[activeDecision.effectIndex??-1];
  const currentFee=activeDecision?.kind==='PAY_COST'||currentEffect?.fee===true;
  const selectCard=offers.some(v=>v.command.type==='PLAY_CARD'&&!v.selections);
  const summary=[`决策席 ${[...new Set(offers.map(v=>name(v.seat)))].join('、')||'无'}；阶段 ${phase}。`,
    ...(activeDecision?[activeDecision.prompt]:[]),
    ...(selectCard?['无 select 的出牌候选只选择打出哪张牌；如果需要地图目标，稍后单独询问。']:[]),
    ...(currentFee?[`这是支付窗口。来源 ${currentEffect&&'from' in currentEffect?zoneName[String(currentEffect.from)]??currentEffect.from:'手牌'}，按候选指定数量与类别选不同牌；已经确定的发动来源不用重选。`]:[]),
    ...(activeDecision?.kind==='REALLOCATE'?['资源重整此处只选取得的基本牌，保留其余牌原有顺序。']:[]),
    ...(activeDecision?.kind==='TRIGGER'?['同名效果按窗口编号对应的来源地区区分；只从当前仍有效候选中选择。']:[]),
  ].join('\n');
  const currentTasks:Record<string,string>={PAY_COST:'支付发动费用',FORCE_HAND:'处理插入的强制弃牌',
    AIR_DEFENSE:'处理插入的空军防御',AIR_INTERCEPT:'决定是否出动空军拦截',TRIGGER:'处理触发或响应窗口',
    ORDER_MANDATORY_TRIGGERS:'排列必须处理的触发',RELOCATE:'选择空军转移目的地',REALLOCATE:'资源重整取牌'};
  const commandTasks:Record<string,string>={KEEP_OPENING:'起手留牌',RESOLVE_FORCED_DISCARD:'处理插入的强制弃牌',
    DISCARD_HAND:'本国弃牌',SELECT_AIR_ACTION:'选择空军行动',MOVE_AIR:'调动空军',
    RELOCATE_AIR:'选择空军转移目的地',PLAY_PRELUDE:'序章出牌',ACK_RESPONSE_NOTICE:'确认通知'};
  const primary=offers.find(v=>v.selections)??offers[0];
  const task=activeDecision?(currentFee?'支付发动费用':currentTasks[activeDecision.kind]??activeDecision.prompt):
    primary?commandTasks[String(primary.command.type)]??(selectCard?'选择标准出牌或结束当前阶段':primary.label):'等待';
  const requirements=[...new Set(offers.flatMap(v=>Object.entries(v.selections??{}).map(([key,spec])=>
    key+' 选'+(spec.min===spec.max?'恰好 '+spec.min:spec.min+'–'+spec.max)+((key==='cardIds'||currentFee)?' 张不同手牌':' 项不同选项')+
      (spec.requirements?.length?'，满足 '+spec.requirements.map(r=>r.split('|').map(v=>v==='*'?'任意手牌':cardName(v)).join(' 或 ')).join('、'):'')
  )))];
  const revisedSummary=[
    '当前行动国：'+name(o.activeSeat),'当前回合阶段：'+phase+'阶段',
    '当前决策国：'+([...new Set(offers.map(v=>name(v.seat)))].join('、')||'无'),
    '当前实际任务：'+task,
    ...(activeDecision?['窗口说明：'+activeDecision.prompt]:[]),
    ...(requirements.length?['选择要求：'+requirements.join('；')]:[]),
    ...(currentFee?['发动来源：'+(cardName(activeDecision?.context?.cardId)??activeDecision?.prompt??'按窗口说明')+
      '。可支付的手牌是参数下列出的选项；按指定类别和数量选择。']:[]),
  ].join('\n');
  const {axis,allies}=o.public.allianceScores;
  const state={
    身份:o.bindings.map(name),阵营:o.alliance==='axis'?'轴心':'同盟',轮:o.round,当前行动国:name(o.activeSeat),阶段:phase,
    累计分:{轴心:axis,同盟:allies,各国:Object.fromEntries(Object.entries(o.public.scores).map(([k,v])=>[name(k),v]))},
    中立:o.public.neutrality,序章:o.public.prelude,资源已重整:o.public.redistributed,本阶段空军行动:o.public.airAction,
    剩余特别基本出牌:o.public.basicPlaysRemaining,各国牌区:countries,本方牌区:own,
    地图:{陆地:ref.map.regions.filter(r=>r.type==='LAND').map(r=>r.name),
      海域:ref.map.regions.filter(r=>r.type==='SEA').map(r=>r.name),
      海峡:ref.map.straits.map(s=>[region(s.landRegion),region(s.seaA),region(s.seaB),
        (o.mapFacts.landControllers[s.landRegion]??s.defaultController)==='axis'?'轴心':'同盟']),
      当前邻接:[...adjacency.values()],动态国别:mapCountries,
      部队:revised?undefined:o.mapFacts.units.map(u=>[u.id,name(u.country),kindName[u.type],region(u.regionId),u.supplied?'有补给':'断补']),
      临时补给:o.mapFacts.temporarySupply,其他临时规则:o.public.turnFlags},
    近期公开记录:o.public.log?.slice(-6),前次本方结算:previous,
  };
  const output=question
    ? '只输出一个JSON对象，例如 {"answer":"是"}。回答原问题所要求的字符串。不要选动作，不要附加字段。'
    : '只输出一个JSON对象。offer 是候选编号；select 里的每个键必须与该候选列出的输出参数完全一致，数组填该键自己的选项编号，不是卡牌 ID。无参数时只需 offer，勿填 select；列了输出参数的候选按原样填写每个参数键，允许选0项时填空数组。参数值只能是整数数组。不要复述候选、输出说明、对象型参数或额外字段。'
      +(sample?' 当前窗口的格式示例（只演示格式，不推荐该动作）：'+JSON.stringify(sample):' 当前没有可提交候选。');
  const boardDetails=revised?'\n地区名称与 ID：'+ref.map.regions.map(r=>r.name+'='+r.id).join('；')
    +'\n部队（当前授权观察）：\n'+o.mapFacts.units.map(u=>
      '部队 '+u.id+'：国家='+name(u.country)+'｜兵种='+kindName[u.type]+'｜地区='+region(u.regionId)+'｜当前补给='+(u.supplied?'有':'无')).join('\n'):'';
  return {offers,output,example:question?undefined:sample,messages:[
    {role:'system',content:ruleText(o)},
    {role:'user',content:'C. 当前授权局势与己方资源\n'+JSON.stringify(state)+boardDetails
      +'\n\n卡面词典，每行：定义 ID | 牌名 | 类型 | 部队国 | 紧张度 | 当前效果。牌库组成按定义计数，无牌序。\n'+dictionary.join('\n')
      +'\n\nD. 决策与候选\n'+JSON.stringify(o.decisions.map(describe))+'\n'+mapped.join('\n')
      +'\n\nE. 当前任务\n'+(revised?revisedSummary:summary)+(question?'\n独立诊断问题：'+question.text:'\n选择一项合法游戏操作。')+'\n'+output},
  ]};
}

function readObject(text:string):Record<string,unknown> {
  const value=JSON.parse(text.trim().replace(/^```(?:json)?\s*([\s\S]*?)\s*```$/i,'$1'));
  if(!value||typeof value!=='object'||Array.isArray(value)) throw Error('输出须是单个 JSON 对象');
  return value;
}
export function parseAnswer(text:string) {
  const value=readObject(text);
  if(Object.keys(value).length!==1||typeof value.answer!=='string'||!value.answer.trim())throw Error('问答只接受一个非空字符串 answer');
  return value.answer.trim();
}
export function parseAction(text:string, offers:Offer[], observation:Observation, requestId:string){
  const value=readObject(text);
  if(Object.keys(value).some(k=>k!=='offer'&&k!=='select'))throw Error('动作只接受 offer 和 select');
  const offer=Number.isSafeInteger(value.offer)?offers[value.offer as number]:undefined;
  if(!offer||!observation.bindings.includes(offer.seat)||!observation.decisionSeats.includes(offer.seat))throw Error('offer 不属于当前授权决策席');
  const input=value.select===undefined?{}:value.select;
  if(!input||typeof input!=='object'||Array.isArray(input))throw Error('select 必须是对象');
  const selections:Record<string,string[]> = Object.create(null);
  const cards=cardIndex(observation);
  for(const [key,indices] of Object.entries(input)){
    const specs=offer.selections??{};
    if(!Object.hasOwn(specs,key))throw Error('候选 '+value.offer+' 没有参数 '+key);
    const spec=specs[key];
    if(!Array.isArray(indices)||!indices.every(n=>Number.isSafeInteger(n)&&n>=0&&n<spec.ids.length))throw Error(key+' 需要有效编号数组');
    const ids=indices.map(n=>spec.ids[n]);
    if(spec.requirements?.some(r=>r!=='*')){
      const paid=ids.flatMap(id=>cards.get(id)??[]);
      if(paid.length!==ids.length||!coversCost(paid,spec.requirements))throw Error(key+' 的牌不满足指定费用类别');
    }
    selections[key]=ids;
  }
  for(const key of Object.keys(offer.selections??{})){
    if(!Object.hasOwn(selections,key))throw Error('候选 '+value.offer+' 缺少参数 '+key+'；允许0项时显式填 []');
  }
  const request:Submission={requestId,gameId:observation.gameId!,epoch:observation.epoch,revision:observation.revision!,offerId:offer.id,selections};
  compileOffer(offers,request);
  return {request,offer};
}
