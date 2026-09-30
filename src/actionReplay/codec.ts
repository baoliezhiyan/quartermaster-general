import type {Action,ActionGroup,Anchor,End,Header,RecordLine,Snapshot,Start} from './contract';
import {ADAPTER,ENGINE,VERSION,hash,hashText,canonical,restore} from './state';
import {SEATS} from '../core/types';
export type Archive={header:Header;start:Start;records:RecordLine[];groups:ActionGroup[];end:End};
const require=(v:unknown,message:string):void=>{if(!v)throw Error(message);};
const object=(v:any)=>v&&typeof v==='object'&&!Array.isArray(v);
const integer=(v:any)=>Number.isSafeInteger(v)&&v>=0;
const text=(v:any)=>typeof v==='string'&&v.length<20000;
const fields:Record<string,string[]>={KEEP_OPENING:['cardIds'],DISCARD_HAND:['cardIds'],DISCARD_PRELUDE_TOP:[],PLAY_PRELUDE:['cardId'],PLAY_BASIC:['cardId','optionId'],MOVE_AIR:['cardId','optionId'],PLAY_CARD:['cardId','effectIndices','targetIds','guided'],STATUS_ACTION:['cardId','guided'],RESOLVE_ENGINE_CHOICE:['ids','guided'],REDISTRIBUTE:['cardIds','takeCardId'],SELECT_AIR_ACTION:['action'],ADVANCE_PHASE:[],ARMAMENT_WINDOW:[],RELOCATE_AIR:['regionId'],RESOLVE_FORCED_DISCARD:['cardIds'],SET_INTERRUPTS:['enabled'],SET_CARD_RESPONSE:['cardId','enabled'],CONTINUE_BOUNDARY:['boundary']};
export function validateInput(v:any){
 require(object(v)&&typeof v.type==='string'&&!!fields[v.type],'不支持的动作命令');
 require(Object.keys(v).every(k=>k==='type'||fields[v.type].includes(k)),'动作含多余字段或快照');
 const required:Record<string,string[]>={KEEP_OPENING:['cardIds'],DISCARD_HAND:['cardIds'],PLAY_PRELUDE:['cardId'],PLAY_BASIC:['cardId','optionId'],MOVE_AIR:['cardId','optionId'],PLAY_CARD:['cardId','effectIndices','targetIds'],STATUS_ACTION:['cardId'],RESOLVE_ENGINE_CHOICE:['ids'],REDISTRIBUTE:['cardIds','takeCardId'],SELECT_AIR_ACTION:['action'],RELOCATE_AIR:['regionId'],RESOLVE_FORCED_DISCARD:['cardIds'],SET_INTERRUPTS:['enabled'],SET_CARD_RESPONSE:['cardId','enabled']};
 require((required[v.type]??[]).every(k=>k in v),'动作缺少必需参数');
 for(const [k,x]of Object.entries(v)){if(k==='type')continue;if(['cardIds','ids','targetIds'].includes(k))require(Array.isArray(x)&&x.length<=1000&&x.every(text),'无效的卡牌/目标选择');else if(k==='effectIndices')require(Array.isArray(x)&&x.every(integer),'效果序号无效');else if(['guided','enabled'].includes(k))require(typeof x==='boolean','布尔字段无效');else require(x===null||text(x),'动作参数类型错误');}
 if(v.type==='CONTINUE_BOUNDARY')require(['formal_start','round_end'].includes(v.boundary),'检查点继续位置无效');
}
function anchor(v:Anchor){require(object(v)&&text(v.actionId)&&Array.isArray(v.effectPath)&&v.effectPath.length<=100&&v.effectPath.every(text)&&text(v.timing)&&integer(v.occurrence),'动作锚点损坏');}
function safe(v:any,depth=0){require(depth<90,'JSON 嵌套过深');if(v===null||typeof v==='boolean'||typeof v==='string')return;if(typeof v==='number'){require(Number.isFinite(v),'数字无效');return;}if(Array.isArray(v)){require(v.length<=200000,'数组过大');v.forEach(x=>safe(x,depth+1));return;}require(object(v),'不是 JSON 数据');for(const [k,x]of Object.entries(v)){require(!['__proto__','constructor','prototype'].includes(k),'禁止的对象字段');safe(x,depth+1);}}
function action(a:Action,ids:Set<string>,orders:Set<number>,parent?:string,depth=0){
 require(depth<32&&object(a)&&text(a.actionId)&&!ids.has(a.actionId),'动作 ID 重复或嵌套过深');ids.add(a.actionId);
 require(['play_card','activate','response','opening_keep','discard','resource_reorganize','phase_advance','editor_change'].includes(a.kind)&&SEATS.includes(a.decisionSeat),'动作类型/国家无效');validateInput(a.input);
 require(Array.isArray(a.choices)&&Array.isArray(a.interventions),'缺少动作选择');
 const order=(n:number)=>{require(integer(n)&&n>0&&!orders.has(n),'动作顺序重复');orders.add(n);};
 for(const c of a.choices){anchor(c.at);require(c.at.actionId===a.actionId&&SEATS.includes(c.decisionSeat)&&text(c.kind),'选择归属无效');order(c.order);validateInput(c.answer);}
 for(const i of a.interventions){anchor(i.at);require(i.at.actionId===a.actionId&&i.action.actionId!==parent,'响应父动作无效');order(i.order);action(i.action,ids,orders,a.actionId,depth+1);}
}
function snap(s:Snapshot){require(object(s)&&object(s.ruleState),'缺少规则检查点');const v=s.ruleState as any;require(!v.publicLog?.length&&!v.responseNotices?.length&&!v.session&&!v.recovery&&!v.matchRecording&&!v.actionRecording,'检查点包含累计日志或旧档案');require(!v.events?.some((e:any)=>e.type!=='UNIT_PLACED'),'检查点包含展示日志');require(!v.resolution?.frames?.some((f:any)=>f.rollback||f.extraRollback),'检查点嵌套历史快照');const state=restore(s);require(!state.trainingCourse,'暂不支持训练回放适配器');require(SEATS.every(seat=>v.resourcePool[seat].length===0),'正式对局资源池必须为空');}
export async function validateRecords(records:RecordLine[],requireEnd=true):Promise<Archive>{
 safe(records);const h=records[0] as Header;
 require(h?.type==='header'&&h.format==='quartermaster-match-log'&&h.formatVersion===3&&h.recordingModel==='action_replay','仅支持动作回放 formatVersion=3；旧全量格式不能直接导入');
 require(h.mode==='standard','暂不支持训练记录：尚未实现对应训练回放适配器');
 require(h.gameVersion===VERSION,'游戏版本不匹配，需要 '+h.gameVersion);
 require(h.engineFingerprint===ENGINE&&h.catalogFingerprint===ENGINE&&h.mapFingerprint===ENGINE,'规则引擎或数据指纹不匹配');
 require(canonical(h.replayAdapter)===canonical(ADAPTER)&&h.commandSchemaVersion==='1'&&h.checkpointSchemaVersion==='1','不支持的回放适配器/schema');
 require(h.digest?.algorithm==='SHA-256'&&h.digest.canonicalization==='qm-sorted-json-v1'&&integer(h.recordingRevision)&&/^[\w-]+$/.test(h.recordingId),'文件头不完整');
 require(await hash(h.rulesConfig)===h.rulesFingerprint,'规则配置指纹错误');
 const start=records[1] as Start;require(start?.type==='start','缺少 start');
 const groups:ActionGroup[]=[],seen=new Set<string>(),cp=new Map<string,Snapshot>(),orders=new Map<string,Set<number>>(),owners=new Map<string,Set<string>>();let completed=0,formal=false;
 for(let i=0;i<records.length;i++){
  const r=records[i];require(r.seq===i,'seq 不连续');if(i===0)continue;
  if(r.type==='start'||r.type==='checkpoint'){
   require(!seen.has(r.checkpointId),'检查点 ID 重复');seen.add(r.checkpointId);
   if(r.type==='start')require(i===1,'重复 start');
   else {require(!groups.length||groups.at(-1)?.status==='complete','检查点切断未完成动作');require(r.afterGroupId===(groups.at(-1)?.groupId??null),'检查点前缀不匹配');if(r.boundary==='formal_start'){require(!formal&&r.completedRound===0,'重复正式开局');formal=true;}else{require(r.boundary==='round_end'&&integer(r.completedRound)&&r.completedRound>completed,'轮末边界无效');completed=r.completedRound;}}
   const state='state'in r&&r.state?r.state:cp.get((r as any).reuseCheckpointId);require(!!state,'检查点引用不存在');snap(state!);
   if(r.type==='checkpoint'){const v=state!.ruleState;require(records[i-1].type==='action_group','检查点不在动作边界');if(r.boundary==='formal_start')require(v.activeSeat==='germany'&&v.round===1&&v.phase==='SETUP'&&(v.setupCompleted as unknown[]).length===6,'正式开局检查点位置错误');else require(v.activeSeat==='united_states'&&v.round===r.completedRound,'轮末检查点位置错误');}
   require(await hash(state)===r.stateHash,'检查点哈希不匹配');cp.set(r.checkpointId,state!);
  }else if(r.type==='action_group'){
   require(!seen.has(r.groupId)&&['prelude','opening','formal'].includes(r.stage)&&integer(r.round),'动作组无效');seen.add(r.groupId);require(groups.at(-1)?.status!=='pending','pending 只能在执行顺序末尾');
   const os=new Set<number>(),ids=new Set<string>();action(r.root,ids,os);for(const id of ids){require(!seen.has(id),'重复动作 ID');seen.add(id);}owners.set(r.groupId,ids);orders.set(r.groupId,os);groups.push(r);
   if(r.root.input.type==='CONTINUE_BOUNDARY'){const prior=records[i-1];require(prior.type==='checkpoint'&&prior.boundary===r.root.input.boundary,'缺少继续动作对应的检查点');}
   if(r.status==='pending'){anchor(r.frontier.at);require(ids.has(r.frontier.at.actionId),'frontier 动作不存在');require(!('afterHash'in r),'pending 不得携带 afterHash');}else require(r.status==='complete'&&!('frontier'in r),'动作完成状态无效');
  }else if(r.type==='shuffle'){
   require(text(r.shuffleId)&&!seen.has(r.shuffleId)&&Array.isArray(r.cardInstanceIds)&&r.cardInstanceIds.every(text)&&new Set(r.cardInstanceIds).size===r.cardInstanceIds.length&&SEATS.includes(r.owner)&&text(r.zone),'洗牌记录无效');seen.add(r.shuffleId);anchor(r.at);require(integer(r.randomStreamAfter?.randomState),'缺少洗牌后随机流');
  }else if(r.type==='end'){require(i===records.length-1,'end 不是尾行');}
  else throw Error('不支持的记录类型：'+r.type);
 }
 require(cp.size<=22,'检查点数量超过正式对局上限');
 for(const r of records)if(r.type==='shuffle'){const os=orders.get(r.groupId);require(os&&owners.get(r.groupId)?.has(r.at.actionId)&&integer(r.order)&&r.order>0&&!os.has(r.order),'游离随机记录或顺序重复');os!.add(r.order);}
 const end=records.at(-1) as End;
 if(requireEnd){require(end.type==='end','缺少 end，文件未封口或被截断');require(end.recordingRevision===h.recordingRevision,'结束修订不一致');require(end.lastCompleteGroupId===(groups.filter(g=>g.status==='complete').at(-1)?.groupId??null)&&end.pendingGroupId===(groups.find(g=>g.status==='pending')?.groupId),'end 与动作前缀不一致');require(['finished','ongoing'].includes(end.status)&&!(end.status==='finished'&&end.pendingGroupId),'终局状态无效');}
 return {header:h,start,groups,records,end};
}
export async function parseReplay(text:string):Promise<Archive>{
 require(text.length<=96*1024*1024,'回放文件超过 96 MB');require(!text.includes('\r')&&text.endsWith('\n')&&text.charCodeAt(0)!==0xfeff,'要求 UTF-8/LF 完整尾行');
 const lines=text.slice(0,-1).split('\n');require(lines.length<=200000&&lines.every(l=>l.length<32*1024*1024),'行数或单行大小超限');const records=lines.map(l=>JSON.parse(l));const a=await validateRecords(records);require(await hashText(lines.slice(0,-1).join('\n')+'\n')===a.end.contentHash,'文件 SHA-256 校验失败');return a;
}
export async function seal(records:Exclude<RecordLine,End>[],finished=false,winner?:End['winner']):Promise<string>{
 const prefix=records.map(r=>JSON.stringify(r)).join('\n')+'\n',groups=records.filter((r):r is ActionGroup=>r.type==='action_group'),h=records[0] as Header;
 const end:End={type:'end',seq:records.length,recordingRevision:h.recordingRevision,status:finished?'finished':'ongoing',lastCompleteGroupId:groups.filter(g=>g.status==='complete').at(-1)?.groupId??null,...(groups.at(-1)?.status==='pending'?{pendingGroupId:groups.at(-1)!.groupId}:{}),...(winner?{winner}:{}),contentHash:await hashText(prefix)};
 return prefix+JSON.stringify(end)+'\n';
}
