import {ENGINE,hashText} from './state';
import {SEATS} from '../core/types';
import {COUNTRY_NAMES} from '../core/basic';
import {REGION_BY_ID} from '../core/map';
import {TRAINING_CAPABILITIES} from './trainingContract';
import type {TrainingArchive,TrainingLine,TrainingHeader,TrainingStep} from './trainingContract';
const demand=(v:unknown,m:string)=>{if(!v)throw Error('训练回放：'+m);};
const obj=(v:any)=>!!v&&typeof v==='object'&&!Array.isArray(v);
const str=(v:any)=>typeof v==='string'&&v.length>0&&v.length<=20000;
const int=(v:any)=>Number.isSafeInteger(v)&&v>=0;
const seat=(v:any)=>SEATS.includes(v);
const country=(v:any)=>Object.hasOwn(COUNTRY_NAMES,v);
const ids=(v:any)=>Array.isArray(v)&&v.length<=10000&&v.every(str)&&new Set(v).size===v.length;
const phases=['TURN_START_WINDOW','PLAY','AIR','SUPPLY','SCORE','DISCARD','DRAW'];
function fields(v:any,allowed:string[],required:string[]=[]){demand(obj(v)&&Object.keys(v).every(k=>allowed.includes(k))&&required.every(k=>Object.hasOwn(v,k)),'字段缺失或存在未知字段');}
function safe(v:any,n=0){demand(n<40,'嵌套过深');if(v===null||['boolean','string'].includes(typeof v))return;if(typeof v==='number'){demand(Number.isFinite(v),'数字非法');return;}if(Array.isArray(v)){demand(v.length<200000,'数组过大');v.forEach(x=>safe(x,n+1));return;}demand(obj(v),'非法JSON值');for(const [k,x] of Object.entries(v)){demand(!['__proto__','prototype','constructor'].includes(k),'禁止的字段');safe(x,n+1);}}
function ref(v:any){demand(obj(v)&&seat(v.seat)&&['hand','drawPile','discardPile','resourcePool'].includes(v.zone),'牌区引用非法');}
function contents(v:any){ref(v);demand(ids(v.ids)&&['public','owner','omniscient'].includes(v.visibility),'牌区内容或可见性非法');}
function resource(v:any,known:Set<string>){
 demand(obj(v),'资源操作非法');
 if(v.op==='set'){fields(v,['op','seat','zone','ids','visibility'],['op','seat','zone','ids','visibility']);contents(v);demand(v.ids.every((id:string)=>known.has(id)),'未知卡牌实例');}
 else if(v.op==='move'){fields(v,['op','id','from','to','index'],['op','id','from','to']);fields(v.from,['seat','zone'],['seat','zone']);fields(v.to,['seat','zone'],['seat','zone']);ref(v.from);ref(v.to);}
 else {demand(['add','remove'].includes(v.op),'未知资源操作');fields(v,['op','seat','zone','id',...(v.op==='add'?['index']:[])],['op','seat','zone','id']);ref(v);}
 if(v.op!=='set')demand(known.has(v.id),'未知卡牌实例');if(v.index!==undefined)demand(int(v.index),'插入位置非法');
}
function effect(v:any,known:Set<string>){
 demand(obj(v),'场面操作非法');
 if(v.kind==='resource'){fields(v,['kind','change'],['kind','change']);resource(v.change,known);return;}
 if(v.kind==='board'){
  fields(v,['kind','country','action','regionId','attackerId','defenderId','airId','recycleId','mode','newUnitId','airDefense'],['kind','country','action','regionId']);
  demand(country(v.country)&&['build_army','build_navy','recruit_army','recruit_navy','land_battle','sea_battle','air_deploy','air_move','air_power','destroy'].includes(v.action)&&Object.hasOwn(REGION_BY_ID,v.regionId),'场面动作/国家/地区非法');
  for(const k of ['attackerId','defenderId','airId','recycleId','newUnitId'])if(v[k]!==undefined)demand(str(v[k]),'兵模引用非法');
  demand(v.mode===undefined||['build','battle','deploy','move','supremacy'].includes(v.mode),'场面模式非法');demand(v.airDefense===undefined||typeof v.airDefense==='boolean','空军防御标记非法');return;
 }
 if(v.kind==='remove'){fields(v,['kind','unitId','reason'],['kind','unitId','reason']);demand(str(v.unitId)&&['cost','supply','retreat'].includes(v.reason),'移除原因非法');return;}
 if(v.kind==='score'){fields(v,['kind','seat','amount'],['kind','seat','amount']);demand(seat(v.seat)&&Number.isSafeInteger(v.amount)&&Math.abs(v.amount)<=10000,'得分操作非法');return;}
 if(v.kind==='supply'){fields(v,['kind','unitIds'],['kind','unitIds']);demand(ids(v.unitIds),'补给目标非法');return;}
 if(v.kind==='status'){fields(v,['kind','seat','cardId','operation'],['kind','seat','cardId','operation']);demand(seat(v.seat)&&known.has(v.cardId)&&['install','remove'].includes(v.operation),'持续状态非法');return;}
 throw Error('训练回放：未支持场面能力 '+v.kind);
}
export async function parseTrainingReplay(text:string):Promise<TrainingArchive>{
 demand(text.length<=96*1024*1024&&text.endsWith('\n')&&!text.includes('\r')&&text.charCodeAt(0)!==0xfeff,'文件大小或UTF-8/LF尾行不符');
 const lines=text.slice(0,-1).split('\n');demand(lines.length>=3&&lines.length<=200000&&lines.every(l=>l.length<16*1024*1024),'行数/行大小不符');
 const records=lines.map(l=>JSON.parse(l));safe(records);records.forEach((r,i)=>demand(r.seq===i,'seq必须连续'));
 const h=records[0] as TrainingHeader;
 fields(h,['type','seq','format','formatVersion','recordingModel','mode','replayAdapter','recordingId','gameId','gameVersion','producer','sceneEngineFingerprint','requiredCapabilities','training','cards']);
 demand(h.type==='header'&&h.format==='quartermaster-match-log'&&h.formatVersion===3&&h.mode==='resource_pool'&&h.recordingModel==='scene_actions','错误的训练文件协议');
 demand(h.replayAdapter?.id==='quartermaster-training-scene'&&h.replayAdapter.version==='1.0.0','未知训练适配器');
 demand(h.sceneEngineFingerprint===ENGINE,'场面规则指纹不匹配（不检查训练器/游戏版本号）');
 demand(str(h.recordingId)&&str(h.gameId)&&str(h.gameVersion)&&str(h.producer?.name)&&str(h.producer?.version),'文件头不完整');
 demand(ids(h.requiredCapabilities),'必需能力列表非法');for(const cap of h.requiredCapabilities)demand((TRAINING_CAPABILITIES as readonly string[]).includes(cap),'缺少必需能力：'+cap);
 demand(h.requiredCapabilities.includes('resources.independent.v1'),'未声明独立牌区能力');
 demand(obj(h.training)&&str(h.training.courseId)&&str(h.training.courseVersion)&&obj(h.training.configuration)&&Array.isArray(h.training.ruleOverrides)&&h.training.ruleOverrides.length===0,'课程信息缺失或包含尚未支持的规则覆盖');
 demand(Array.isArray(h.cards)&&h.cards.length<=10000,'卡表非法');const known=new Set<string>();
 for(const c of h.cards){fields(c,['id','definitionId','deckOwner','country','balance','name','text','type'],['id','definitionId','deckOwner','country','name','text','type']);demand(str(c.id)&&!known.has(c.id)&&str(c.definitionId)&&seat(c.deckOwner)&&country(c.country)&&str(c.name)&&typeof c.text==='string'&&str(c.type)&&(c.balance===undefined||typeof c.balance==='boolean'),'卡实例/卡面非法');known.add(c.id);}
 const start=records[1];fields(start,['type','seq','scene','resources'],['type','seq','scene']);demand(start.type==='start','缺少start');
 const s=start.scene;fields(s,['units','scores','round','phase','activeSeat','balance','activeCards'],['units','scores','round','phase','activeSeat','balance']);
 demand(Array.isArray(s.units)&&s.units.length<=100&&obj(s.scores)&&SEATS.every(k=>Number.isFinite(s.scores[k]))&&int(s.round)&&s.round>0&&s.round<=20&&phases.includes(s.phase)&&seat(s.activeSeat)&&typeof s.balance==='boolean','初始场面非法');
 for(const u of s.units){fields(u,['id','country','type','regionId'],['id','country','type','regionId']);demand(str(u.id)&&country(u.country)&&['army','navy','air'].includes(u.type)&&Object.hasOwn(REGION_BY_ID,u.regionId),'初始兵模非法');}
 if(s.activeCards!==undefined){fields(s.activeCards,[...SEATS]);for(const values of Object.values(s.activeCards))demand(ids(values)&&(values as string[]).every(id=>known.has(id)),'状态列表非法');}
 const zones=new Set<string>();demand(start.resources===undefined||Array.isArray(start.resources),'初始牌区非法');for(const z of start.resources??[]){fields(z,['seat','zone','ids','visibility'],['seat','zone','ids','visibility']);contents(z);const k=z.seat+z.zone;demand(!zones.has(k)&&z.ids.every((id:string)=>known.has(id)),'初始牌区重复或引用未知牌');zones.add(k);}
 const steps:TrainingStep[]=records.slice(2,-1),seen=new Set<string>();
 for(const r of steps){fields(r,['type','seq','id','seat','cardId','summary','round','phase','activeSeat','operations','sceneHash'],['type','seq','id','seat','round','phase','activeSeat','operations','sceneHash']);demand(r.type==='training_action'&&str(r.id)&&!r.id.includes('@')&&!seen.has(r.id)&&seat(r.seat)&&int(r.round)&&r.round>0&&r.round<=20&&phases.includes(r.phase)&&seat(r.activeSeat)&&Array.isArray(r.operations)&&r.operations.length<=1000&&/^[a-f0-9]{64}$/.test(r.sceneHash),'动作字段非法');seen.add(r.id);demand(r.cardId===undefined||known.has(r.cardId),'来源卡未知');demand(r.summary===undefined||str(r.summary),'摘要非法');for(const op of r.operations){effect(op,known);const cap=op.kind==='resource'?'resources.independent.v1':'scene.'+op.kind+'.v1';demand(h.requiredCapabilities.includes(cap),'动作未声明必需能力：'+cap);}}
 const end=records.at(-1);fields(end,['type','seq','contentHash'],['type','seq','contentHash']);demand(end.type==='end','缺少end，文件截断');demand(await hashText(lines.slice(0,-1).join('\n')+'\n')===end.contentHash,'SHA-256不匹配');
 return {header:h,start,steps,end};
}
export async function sealTraining(records:Exclude<TrainingLine,{type:'end'}>[]){const body=records.map(r=>JSON.stringify(r)).join('\n')+'\n';return body+JSON.stringify({type:'end',seq:records.length,contentHash:await hashText(body)})+'\n';}
