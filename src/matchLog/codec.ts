import schemas from './schema.json';
import type {Header,Start,Frame,End,State,MatchLogRecord,Json,Seat,Scope} from './contract';
export type MatchArchive={header:Header;start:Start;frames:Frame[];end:End};
export const FEATURES=['qm.fact_state.v1','qm.knowledge.v1','qm.standard_areas.v1','qm.resource_pool_areas.v1'];
const SEATS=['germany','united_kingdom','japan','soviet_union','italy','united_states'];
const dict=schemas as Record<string,any>;
function fail(path:string,message:string):never{throw Error(`${path}：${message}`);}
function keyValues(s:any):string[]|null{if(!s)return null;if(s.ref)return keyValues(dict[s.ref]);if(s.union){const parts=s.union.map(keyValues);return parts.every(Boolean)?parts.flat():null;}return typeof s.literal==='string'?[s.literal]:null;}
function check(s:any,v:any,path:string,depth=0):void{
 if(depth>120)fail(path,'嵌套过深');
 if(v===undefined&&s.optional)return;
 if(s.ref){if(s.ref==='Json'){if(v===null||typeof v==='string'||typeof v==='boolean'||typeof v==='number'&&Number.isFinite(v))return;if(Array.isArray(v)){v.forEach((x,i)=>check(s,x,`${path}[${i}]`,depth+1));return;}if(v&&typeof v==='object'){for(const [k,x] of Object.entries(v)){if(['__proto__','constructor','prototype'].includes(k))fail(path,'不安全的字段');check(s,x,path+'.'+k,depth+1);}return;}fail(path,'不是 JSON 数据');}return check(dict[s.ref],v,path,depth+1);}
 if(s.union){const values=keyValues(s);if(values){if(!values.includes(v))fail(path,'枚举值无效');return;}for(const a of s.union)try{check(a,v,path,depth+1);return;}catch{}fail(path,'不符合允许的字段类型或枚举');}
 if(s.intersection){s.intersection.forEach((a:any)=>check(a,v,path,depth+1));return;}
 if('literal'in s){if(v!==s.literal)fail(path,'必须为 '+String(s.literal));return;}
 if(s.primitive){if(typeof v!==s.primitive||s.primitive==='number'&&!Number.isFinite(v))fail(path,'需要 '+s.primitive);return;}
 if(s.array){if(!Array.isArray(v))fail(path,'需要数组');v.forEach((x:any,i:number)=>check(s.array,x,`${path}[${i}]`,depth+1));return;}
 if(s.partial)return check({...s.partial,allowMissing:true},v,path,depth+1);
 if(!v||Array.isArray(v)||typeof v!=='object')fail(path,'需要对象');
 for(const key of Object.keys(v))if(['__proto__','constructor','prototype'].includes(key))fail(path,'不安全的字段');
 if(s.record){if(keyValues(s.keys)&&!s.allowMissing)for(const key of keyValues(s.keys)!)if(!(key in v))fail(path,'缺少 '+key);for(const [k,x]of Object.entries(v)){if(s.keys)check(s.keys,k,path+'.key',depth+1);check(s.record,x,path+'.'+k,depth+1);}return;}
 for(const [k,a]of Object.entries(s.properties??{}))check(a,v[k],path+'.'+k,depth+1);
}
export function validateShape(type:string,value:unknown){check(dict[type],value,type);}
export async function sha256(text:string){const b=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(text));return [...new Uint8Array(b)].map(n=>n.toString(16).padStart(2,'0')).join('');}
const unique=(a:string[],p:string)=>{if(new Set(a).size!==a.length)fail(p,'重复 ID');};
const requireRef=(id:string,set:Set<string>,p:string)=>{if(!set.has(id))fail(p,'引用不存在：'+id);};
export function validateFacts(s:State,h:Header,path='state'){
 validateShape('State',s);
 if(!Number.isSafeInteger(s.round)||s.round<0||!Number.isSafeInteger(s.completedCountryTurns)||s.completedCountryTurns<0)fail(path,'轮次或回合计数错误');
 const catalog=new Map(h.catalog.map(c=>[c.catalogEntryId,c])),regions=new Set(h.map.regions.map(r=>r.regionId)),cards=new Set(Object.keys(s.cards)),units=new Set(s.units.map(u=>u.unitId)),areas=new Set(s.areas.map(a=>a.areaId));
 unique(s.areas.map(a=>a.areaId),path+'.areas');unique(s.units.map(u=>u.unitId),path+'.units');
 unique(s.regions.map(r=>r.regionId),path+'.regions');if(s.regions.length!==regions.size)fail(path,'地区快照不完整');
 for(const v of Object.values(s.reserves))for(const count of Object.values(v))if(!Number.isSafeInteger(count)||count<0)fail(path,'兵模储备数量无效');
 const placed=s.areas.flatMap(a=>a.cardIds);unique(placed,path+'.areas.cardIds');if(placed.length!==cards.size)fail(path,'卡牌必须恰好归属一个卡区');
 for(const [id,c]of Object.entries(s.cards)){const d=catalog.get(c.effectiveDefinitionRef);if(id!==c.instanceId||!d||d.definitionId!==c.definitionId||d.deckOwner!==c.deckOwner||d.printedCountry!==c.printedCountry)fail(path+'.cards','卡牌实例与卡表不一致');}
 for(const a of s.areas){for(const id of a.cardIds){requireRef(id,cards,path);if(s.cards[id].deckOwner!==a.seat)fail(path,'卡区所属国家与牌实例不符');}if(a.displayOrder){unique(a.displayOrder,path);if(a.displayOrder.length!==a.cardIds.length||a.displayOrder.some(id=>!a.cardIds.includes(id)))fail(path,'显示顺序不是卡区排列');}if(h.mode==='resource_pool'&&['regular_hand','regular_deck','prelude_hand','prelude_deck'].includes(a.kind))fail(path,'资源池不能伪装手牌/牌库');}
 for(const u of s.units)requireRef(u.regionId,regions,path);for(const r of s.regions)requireRef(r.regionId,regions,path);for(const i of s.installed)requireRef(i.instanceId,cards,path);
 if(h.mode==='resource_pool'&&!s.availability||h.mode==='standard'&&s.availability)fail(path,'模式与开放集合不匹配');
 if(s.availability)for(const seat of SEATS as Seat[]){const v=s.availability[seat],pool=s.areas.filter(a=>a.seat===seat&&a.kind==='resource_pool').flatMap(a=>a.cardIds);unique(v.openInstanceIds,path);if(v.remainingCount!==pool.length||v.openCount!==v.openInstanceIds.length||v.openInstanceIds.some(id=>!pool.includes(id)))fail(path,'开放集合/数量不符合资源池');}
 const decisions=new Map(s.pendingDecisions.map(d=>[d.decisionId,d]));unique([...s.pendingDecisions.map(d=>d.decisionId)],path);
 for(const d of s.pendingDecisions){unique(d.options.map(o=>o.optionId),path);if(!Number.isSafeInteger(d.constraints.min)||!Number.isSafeInteger(d.constraints.max)||d.constraints.min<0||d.constraints.max<d.constraints.min)fail(path,'决策数量约束错误');for(const o of d.options)for(const ref of o.entities){const set=ref.kind==='card'?cards:ref.kind==='unit'?units:ref.kind==='region'?regions:ref.kind==='area'?areas:null;if(set)requireRef(ref.id,set,path);}}
 const effects=new Map(s.resolution.frames.flatMap(f=>f.effectsOrdered.map(e=>[e.effectId,e] as const))),flags=new Map(s.flags.map(f=>[f.flagId,f]));
 for(const d of s.pendingDecisions)if(d.controllerId!==s.controllers[d.decisionSeat].controllerId)fail(path,'决策操作者与当前绑定不一致');
 for(const [who,k]of Object.entries({public:s.knowledge.public,...s.knowledge.seats})){
  const permits=(v:Scope)=>v.public||v.seats.includes(who as Seat);
  unique(k.areas.map(a=>a.areaId),path+'.knowledge');if(k.areas.length!==s.areas.length)fail(path,'知识卡区快照不完整');
  for(const a of k.areas){const area=s.areas.find(v=>v.areaId===a.areaId);if(!area)fail(path,'知识引用卡区不存在');if(a.visibleCount!==null&&a.visibleCount!==area.cardIds.length)fail(path,'可见数量错误');for(const c of a.knownCards){if(!area.cardIds.includes(c.instanceId)||s.cards[c.instanceId]?.definitionId!==c.definitionId)fail(path,'知识卡牌身份错误');}const known=new Set(a.knownCards.map(c=>c.instanceId));for(const id of [...a.knownTopPrefix,...(a.knownOrder??[])])requireRef(id,known,path);if(a.knownOrder&&JSON.stringify(a.knownOrder)!==JSON.stringify(area.cardIds))fail(path,'已知顺序错误');if(a.knownTopPrefix.some((id,i)=>area.cardIds[i]!==id))fail(path,'已知牌库顶错误');}
  for(const id of k.visibleDecisionIds){const d=decisions.get(id);if(!d||!permits(d.visibility)||!k.decisions.some(x=>x.decisionId===id))fail(path,'未授权或缺少决策投影');}
  for(const d of k.decisions)if(!k.visibleDecisionIds.includes(d.decisionId)||!permits(d.visibility))fail(path,'私密决策泄露');
  for(const id of k.notificationIds){const n=s.notifications.find(n=>n.notificationId===id);if(!n||!(who==='public'?n.recipients.length===6:n.recipients.includes(who as Seat)))fail(path,'未授权通知');}
  for(const id of k.visibleEffectIds){const e=effects.get(id);if(!e||!permits(e.visibility))fail(path,'未授权结算效果');}for(const id of k.visibleFlagIds){const f=flags.get(id);if(!f||!permits(f.visibility))fail(path,'未授权标记');}
  for(const [seat,ids]of Object.entries(k.knownOpenInstanceIds))if(ids?.some(id=>!s.availability?.[seat as Seat].openInstanceIds.includes(id)))fail(path,'开放知识错误');
 }
}
export function validateRecords(records:MatchLogRecord[],gameVersion:string,requireEnd=true):MatchArchive{
 const h=records[0] as Header;validateShape('Header',h);
 if(h.mode==='standard'&&h.gameVersion!==gameVersion)fail('gameVersion',`正式对局版本 ${h.gameVersion} 与客户端 ${gameVersion} 不一致`);
 if(h.compatibility.policy!==(h.mode==='standard'?'exact_game_version':'declared_schema'))fail('compatibility','模式与兼容策略不符');
 for(const f of h.compatibility.requiredFeatures)if(!FEATURES.includes(f))fail('requiredFeatures','不支持必需能力 '+f);
 const modeFeature=h.mode==='standard'?'qm.standard_areas.v1':'qm.resource_pool_areas.v1';for(const f of ['qm.fact_state.v1','qm.knowledge.v1',modeFeature])if(!h.compatibility.requiredFeatures.includes(f))fail('requiredFeatures','缺少 '+f);
 if(!Number.isSafeInteger(h.recordingRevision)||h.recordingRevision<0)fail('recordingRevision','修订号无效');
 if(h.compatibility.requiredFeatures.includes(h.mode==='standard'?'qm.resource_pool_areas.v1':'qm.standard_areas.v1'))fail('requiredFeatures','不能同时声明两个互斥模式');
 if(h.resourceConfig.mode!==h.mode)fail('resourceConfig','模式不符');unique(h.catalog.map(c=>c.catalogEntryId),'catalog');unique(h.participants.map(p=>p.controllerId),'participants');
 unique(h.map.regions.map(r=>r.regionId),'map');unique(h.rngDefinitions.map(r=>r.streamId),'rngDefinitions');
 const composition=h.resourceConfig.mode==='standard'?h.resourceConfig.deckComposition:h.resourceConfig.composition;
 for(const seat of SEATS as Seat[])for(const [ref,count] of Object.entries(composition[seat])){const c=h.catalog.find(c=>c.catalogEntryId===ref);if(!c||c.deckOwner!==seat||!Number.isSafeInteger(count)||count<0||count!==c.instanceCount)fail('composition','牌库数量与卡表不一致');}
 if(h.resourceConfig.mode==='resource_pool'){unique(h.resourceConfig.whitelist,'whitelist');for(const ref of h.resourceConfig.whitelist)if(!h.catalog.some(c=>c.catalogEntryId===ref||c.definitionId===ref))fail('whitelist','卡牌白名单引用不存在');}
 const start=records[1] as Start;validateShape('Start',start);const frames:Frame[]=[],events=new Set<string>(),decisions=new Set<string>();let previous=start;
 for(let i=1;i<records.length;i++){
  const r=records[i];if(r.seq!==i)fail('seq','记录序号不连续');if(r.recordType==='end'){if(i!==records.length-1)fail('end','结束行不是最后一行');break;}
  if(r.recordType==='header')fail('header','重复文件头');validateFacts(r.state,h,`seq=${i}`);for(const binding of Object.values(r.state.controllers))if(binding.controllerId!==null&&!h.participants.some(p=>p.controllerId===binding.controllerId))fail('controllers','操作者不在参与者表中');
  if(r.recordType==='frame'){validateShape('Frame',r);if(r.beforeStateSeq!==i-1||r.timelineId!==start.timelineId)fail('frame','前状态或时间线引用错误');
   for(const e of r.events){if(events.has(e.eventId))fail('event','重复事件 ID');if(e.cause.parentEventId&&!events.has(e.cause.parentEventId))fail('event','父事件不存在');events.add(e.eventId);}
   if('action'in r&&r.action){const d=previous.state.pendingDecisions.find(d=>d.decisionId===r.action!.decisionId);if(!d||r.decisionBeforeStateSeq!==i-1||decisions.has(d.decisionId))fail('action','决策前状态缺失或重复提交');unique(r.action.optionIdsOrdered,'action');if(r.action.disposition==='skip'&&!d.constraints.allowSkip||r.action.disposition==='decline'&&!d.constraints.allowDecline||r.action.disposition==='cancel'&&!d.constraints.allowCancel)fail('action','不允许的跳过/拒绝/取消');
    if(r.action.actorSeat!==d.decisionSeat||r.action.optionIdsOrdered.some(id=>!d.options.some(o=>o.optionId===id)))fail('action','选择不在合法选项中');decisions.add(d.decisionId);}
   if(r.kind==='random'){if(!h.rngDefinitions.some(d=>d.streamId===r.randomResult.streamId)||r.randomResult.domain.stateSeq>=i||r.randomResult.domain.stateSeq<1)fail('random','随机流或候选状态引用错误');}
   frames.push(r);
  }previous=r as Start;
 }
 const end=records.at(-1) as End;if(requireEnd||end.recordType==='end'){validateShape('End',end);if(end.lastStateSeq!==records.length-2||end.frameCount!==frames.length||end.decisionCount!==decisions.size||JSON.stringify(end.finalScores)!==JSON.stringify(previous.state.scores)||end.gameStatus!==previous.state.gameStatus)fail('end','结束统计与最后状态不一致');if(end.winner!==(previous.state.result?.winner??null)||end.victoryReason!==(previous.state.result?.victoryReason??null))fail('end','结束结果与最后状态不一致');if(end.recordingStatus==='complete'&&end.gameStatus!=='finished')fail('end','未终局不能声明完整终局');if(end.stopReason==='natural_game_end'&&previous.state.gameStatus!=='finished')fail('end','未结束的游戏不能声明自然结束');}
 return {header:h,start,frames,end};
}
export async function parseMatchLog(text:string,gameVersion:string):Promise<MatchArchive>{
 if(text.charCodeAt(0)===0xfeff||text.includes('\r'))fail('file','要求 UTF-8 无 BOM、LF 换行');if(!text.endsWith('\n'))fail('file','尾行不完整，文件可能被截断');
 const lines=text.slice(0,-1).split('\n');let records:MatchLogRecord[];try{records=lines.map(l=>JSON.parse(l));}catch{fail('file','JSONL 行损坏');}
 if(records.at(-1)?.recordType!=='end')fail('file','缺少 end；这是未封口或中断文件，不能当完整回放导入');
 const prefix=lines.slice(0,-1).join('\n')+'\n';if(await sha256(prefix)!==(records.at(-1) as End).prefixSha256)fail('file','SHA256 校验失败，文件损坏');return validateRecords(records,gameVersion);
}
export async function sealMatchLog(records:(Header|Start|Frame)[],reason?:End['stopReason']):Promise<string>{
 const prefix=records.map(r=>JSON.stringify(r)).join('\n')+'\n',state=(records.at(-1) as Start|Frame).state;
 const end:End={recordType:'end',seq:records.length,lastStateSeq:records.length-1,recordingStatus:state.gameStatus==='finished'?'complete':'partial',stopReason:reason??(state.gameStatus==='finished'?'natural_game_end':'export_while_playing'),gameStatus:state.gameStatus,winner:state.result?.winner??null,victoryReason:state.result?.victoryReason??null,finalScores:state.scores,frameCount:records.length-2,decisionCount:records.filter(r=>'action'in r&&r.action).length,prefixSha256:await sha256(prefix)};
 return prefix+JSON.stringify(end)+'\n';
}
export type {Json};
