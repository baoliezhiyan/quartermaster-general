import {createHash} from 'node:crypto';
const json=value=>JSON.parse(JSON.stringify(value));
const canonical=v=>Array.isArray(v)?'['+v.map(canonical).join(',')+']':v&&typeof v==='object'?'{'+Object.keys(v).sort().map(k=>JSON.stringify(k)+':'+canonical(v[k])).join(',')+'}':JSON.stringify(v);
export const observationDigest=v=>createHash('sha256').update(canonical(v)).digest('hex');
/** All dynamic, legally projected facts; static region definitions remain in reference. */
export function decisionObservation(observation){const {regions,...view}=json(observation);return view;}
const record=v=>!!v&&typeof v==='object'&&!Array.isArray(v);
function valid(v){
 if(!record(v)||typeof v.interfaceVersion!=='string'||typeof v.gameVersion!=='string'||typeof v.userId!=='string'||typeof v.serverId!=='string'||typeof v.epoch!=='string'||!Number.isSafeInteger(v.sequence)||!Array.isArray(v.bindings)||!Array.isArray(v.offers)||!record(v.reference))return false;
 if(!v.gameId)return v.gameId===null;
 return Number.isSafeInteger(v.revision)&&record(v.public)&&Array.isArray(v.public.units)&&record(v.public.scores)&&record(v.public.countries)&&(v.public.log===undefined||Array.isArray(v.public.log))&&record(v.mapFacts)&&record(v.privateCountries)&&Array.isArray(v.decisions)&&v.bindings.every(seat=>record(v.privateCountries[seat])&&['hand','deckComposition','discard','active','faceDown','resolving','removed'].every(zone=>Array.isArray(v.privateCountries[seat][zone])));
}
const equal=(a,b)=>canonical(a)===canonical(b);
const prefix=(a,b)=>Array.isArray(a)&&Array.isArray(b)&&a.length<=b.length&&a.every((v,i)=>equal(v,b[i]));
function units(a=[],b=[]){return {added:b.filter(u=>!a.some(v=>v.id===u.id)),removed:a.filter(u=>!b.some(v=>v.id===u.id)),moved:b.flatMap(u=>{const old=a.find(v=>v.id===u.id);return old&&old.regionId!==u.regionId?[{unitId:u.id,from:old.regionId,to:u.regionId}]:[];}),updated:b.filter(u=>a.some(v=>v.id===u.id&&!equal(v,u)))};}
export function compactObservationChange(baseline,observation){
 const current=decisionObservation(observation),previous=valid(baseline)?decisionObservation(baseline):null;
 let reason=!previous?'missing_baseline':null;
 if(previous){
  if(['interfaceVersion','gameVersion','serverId','userId','gameId','epoch'].some(k=>!equal(previous[k],current[k]))||!equal(previous.bindings,current.bindings)||!equal(previous.reference,current.reference))reason='identity_or_rules_changed';
  else if(current.sequence<previous.sequence||current.revision<previous.revision)reason='rewind';
  else if(!prefix(previous.public?.log??[],current.public?.log??[]))reason='log_replaced_or_shortened';
 }
 const result={format:'local-ai-observation-change',version:1,mode:reason?'snapshot':'delta',reason,fromHash:previous?observationDigest(previous):null,toHash:observationDigest(current),fromSequence:previous?.sequence??null,toSequence:current.sequence};
 if(reason)return {...result,snapshot:current};
 const updates=[];
 function fields(a,b,path=[]){for(const key of new Set([...Object.keys(a??{}),...Object.keys(b??{})])){if(equal(a?.[key],b?.[key]))continue;const at=[...path,key];
   if(!path.length&&['public','privateCountries'].includes(key)||path[0]==='privateCountries'&&path.length===1)fields(a?.[key],b?.[key],at);
   else if(at.length===2&&at[0]==='public'&&key==='log')updates.push(Array.isArray(a?.log)?{op:'append',path:at,value:b.log.slice(a.log.length)}:{op:'set',path:at,value:b.log});
   else updates.push(b?.[key]===undefined?{op:'remove',path:at}:{op:'set',path:at,value:b[key]});
 }}fields(previous,current);
 const privateAreas={};for(const seat of current.bindings){const a=previous.privateCountries?.[seat]??{},b=current.privateCountries?.[seat]??{};const changed=Object.fromEntries(Object.keys(b).filter(k=>!equal(a[k],b[k])).map(k=>[k,b[k]]));if(Object.keys(changed).length)privateAreas[seat]=changed;}
 return {...result,updates,newPublicLog:(current.public?.log??[]).slice(previous.public?.log?.length??0),units:units(previous.public?.units,current.public?.units),scores:{current:current.public?.scores??{},changes:Object.fromEntries(Object.entries(current.public?.scores??{}).filter(([k,v])=>v!==previous.public?.scores?.[k]).map(([k,v])=>[k,{before:previous.public?.scores?.[k],after:v,delta:v-(previous.public?.scores?.[k]??0)}]))},privateAreas};
}
/** Public receiver helper: refuse a missing/wrong base, never silently apply to it. */
export function applyObservationChange(baseline,change){
 if(change?.format!=='local-ai-observation-change'||change.version!==1)throw Error('FULL_SYNC_REQUIRED: unknown change format');
 let state;
 if(change.mode==='snapshot')state=json(change.snapshot);
 else if(change.mode==='delta'){
  if(!valid(baseline)||observationDigest(decisionObservation(baseline))!==change.fromHash)throw Error('FULL_SYNC_REQUIRED: baseline mismatch');
  state=decisionObservation(baseline);
  for(const p of change.updates){if(!Array.isArray(p.path)||!p.path.length||p.path.some(k=>typeof k!=='string'||['__proto__','constructor','prototype'].includes(k)))throw Error('Invalid observation path');
   let parent=state;for(const k of p.path.slice(0,-1)){if(!parent[k]||typeof parent[k]!=='object')throw Error('FULL_SYNC_REQUIRED: missing path');parent=parent[k];}const key=p.path.at(-1);
   if(p.op==='remove')delete parent[key];else if(p.op==='set')parent[key]=json(p.value);else if(p.op==='append'&&Array.isArray(parent[key])&&Array.isArray(p.value))parent[key].push(...json(p.value));else throw Error('Invalid observation update');
  }
 }else throw Error('FULL_SYNC_REQUIRED: unknown mode');
 if(!valid(state)||observationDigest(state)!==change.toHash)throw Error('FULL_SYNC_REQUIRED: target mismatch');return state;
}
export function decisionSummary(o){const keys=['interfaceVersion','gameVersion','gameId','epoch','revision','sequence','status','unsupportedReason','phase','round','activeSeat','bindings','decisionSeats','offers','decisions','resolutionRunning','resolutionSerial','blockingNoticeSeats','resolutionFacts'];return {...Object.fromEntries(keys.filter(k=>o[k]!==undefined).map(k=>[k,o[k]])),representation:'decision_summary',changesRequired:true};}
