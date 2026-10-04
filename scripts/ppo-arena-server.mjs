import {build} from 'vite';
import {createHash} from 'node:crypto';
import {createInterface} from 'node:readline';
import {createWriteStream,mkdirSync,readFileSync,writeFileSync,existsSync} from 'node:fs';
import {dirname,resolve} from 'node:path';

const args=process.argv.slice(2);
const get=(name,fallback)=>{const i=args.indexOf(name);return i<0?fallback:args[i+1];};
const logPath=get('--log',null);
const logSnapshots=args.includes('--log-snapshots');
const bundlePath=get('--bundle',null);
const entryPath=get('--entry','src/training/ppoArena.ts');
let code;
if(bundlePath&&existsSync(bundlePath))code=readFileSync(bundlePath,'utf8');
else {
  const compiled=await build({configFile:false,logLevel:'silent',build:{ssr:entryPath,
    write:false,rollupOptions:{input:entryPath}}});
  code=compiled.output[0].code;
  if(bundlePath){mkdirSync(dirname(resolve(bundlePath)),{recursive:true});writeFileSync(bundlePath,code,'utf8');}
}
const fingerprint=createHash('sha256').update(code).digest('hex');
const {PpoTrainingArena,PPO_STATIC_SCHEMA,PPO_A2S1_STATIC_SCHEMA}=await import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}`);
const schemaCardSet=get('--card-set','events');
if(!['basics','events','signals'].includes(schemaCardSet))throw new Error('Unknown arena schema course');
const staticSchema=schemaCardSet==='signals'?PPO_A2S1_STATIC_SCHEMA:PPO_STATIC_SCHEMA;
let arena=null;
let log=null;
if(logPath){const path=resolve(logPath);mkdirSync(dirname(path),{recursive:true});log=createWriteStream(path,{encoding:'utf8'});}
const send=value=>process.stdout.write(`${JSON.stringify(value)}\n`);
const record=value=>{if(log)log.write(`${JSON.stringify(value)}\n`);};
const cardZone=(state,id)=>{
  if(!id)return null;
  for(const [seat,deck] of Object.entries(state.decks))for(const zone of
    ['hand','drawPile','discardPile','active','faceDown','resolving','removed'])
    if((deck[zone]??[]).some(card=>card.id===id))return {seat,zone};
  return null;
};
// Training-only, read-only settlement telemetry. Wrapping commit keeps the
// arena bundle (and its rules fingerprint) unchanged; every command is still
// passed to the original implementation exactly once.
const attachComboTelemetry=(instance,mode='full')=>{
  const original=instance.commit.bind(instance);
  let serial=0,epoch=0,buffer=[];
  const pending=new Map();
  for(const [index,event] of (instance.state.resolution?.events??[]).entries())
    if(!['succeeded','cancelled','invalid'].includes(event.outcome))pending.set(event.id,index);
  // Arena-created instance IDs are seat:stable-definition-id[:copy-number].
  const definition=(_state,id)=>id?.split(':')[1]??null;
  const installed=(before,after)=>{
    const changes=[];
    for(const [seat,deck] of Object.entries(after.decks))for(const zone of ['active','faceDown']){
      const previous=new Set((before.decks[seat]?.[zone]??[]).map(card=>card.id));
      for(const card of deck[zone]??[])if(!previous.has(card.id))
        changes.push({seat,zone,cardId:card.id,definitionId:card.definitionId});
    }
    return changes;
  };
  instance.commit=command=>{
    const before=instance.state;
    const result=original(command);
    const after=instance.state;
    if(mode==='landing'){
      const old=new Set(before.units.filter(unit=>unit.country==='united_states'&&
        unit.type==='army'&&unit.regionId==='western_europe').map(unit=>unit.id));
      const added=after.units.filter(unit=>unit.country==='united_states'&&
        unit.type==='army'&&unit.regionId==='western_europe'&&!old.has(unit.id));
      if(added.length){
        const frame=before.resolution?.frames.find(item=>
          item.id===before.resolution?.choice?.frameId)??before.resolution?.frames.at(-1);
        const effect=frame?.effects[frame.nextEffectIndex];
        buffer.push({serial:++serial,epoch,round:before.round,activeSeat:before.activeSeat,
          phase:before.phase,commandType:command.type,
          context:frame?{frameId:frame.id,parentEventId:frame.parentEventId,
            ancestorIds:frame.ancestorIds,sourceDefinitionId:definition(before,frame.cardId),
            owner:frame.owner,effect:effect?{kind:effect.kind,action:effect.action??null}:null}:null,
          events:[],added,removed:[],installs:[]});
      }
      return result;
    }
    const prior=before.resolution?.events??[],current=after.resolution?.events??[];
    const newResolution=(!before.resolution?.running&&after.resolution?.running)||
      (before.resolution?.running&&after.resolution?.running&&current.length<prior.length);
    if(newResolution){epoch++;pending.clear();}
    // Only new events and previously declared events can become terminal.
    // Scanning the full growing resolution history on every core command was
    // quadratic over a long match.
    const changed=[];
    for(let index=newResolution?0:prior.length;index<current.length;index++){
      const event=current[index];
      if(['succeeded','cancelled','invalid'].includes(event.outcome))changed.push(event);
      else pending.set(event.id,index);
    }
    for(const [id,index] of pending){
      const event=current[index];
      if(!event||event.id!==id){pending.delete(id);continue;}
      if(['succeeded','cancelled','invalid'].includes(event.outcome)){
        changed.push(event);pending.delete(id);
      }
    }
    const frames=changed.length?new Map((after.resolution?.frames??[]).map(frame=>[frame.id,frame])):new Map();
    const events=changed.map(event=>{
      const frame=frames.get(event.frameId),effect=event.effect??{},option=effect.option??{};
      return {id:event.id,frameId:event.frameId,ancestorIds:event.ancestorIds,
        parentEventId:frame?.parentEventId??null,frameCardId:frame?.cardId??null,
        sourceDefinitionId:definition(after,frame?.cardId)??definition(before,frame?.cardId),
        sourceAncestors:frame?.sourceAncestors??[],owner:frame?.owner??null,
        outcome:event.outcome,applied:event.applied,kind:effect.kind??null,
        action:effect.action??null,country:effect.country??null,
        regionId:option.regionId??effect.regionId??null,
        attackerId:option.attackerId??null,defenderId:option.defenderId??null,
        resultUnitId:effect.resultUnitId??null,
        removedUnit:effect.kind==='remove'?effect.unit??null:null};
    });
    const oldUnits=new Map(before.units.map(unit=>[unit.id,unit]));
    const newUnits=new Map(after.units.map(unit=>[unit.id,unit]));
    const added=[...newUnits].filter(([id])=>!oldUnits.has(id)).map(([,unit])=>unit);
    const removed=[...oldUnits].filter(([id])=>!newUnits.has(id)).map(([,unit])=>unit);
    const installs=installed(before,after);
    const choiceFrame=before.resolution?.frames.find(frame=>
      frame.id===before.resolution?.choice?.frameId)??before.resolution?.frames.at(-1);
    const context=choiceFrame?{frameId:choiceFrame.id,
      parentEventId:choiceFrame.parentEventId??null,ancestorIds:choiceFrame.ancestorIds,
      frameCardId:choiceFrame.cardId??null,
      sourceDefinitionId:definition(before,choiceFrame.cardId),owner:choiceFrame.owner,
      effect:(()=>{const effect=choiceFrame.effects[choiceFrame.nextEffectIndex];return effect?
        {kind:effect.kind,action:effect.action??null,country:effect.country??null,
          regionId:effect.option?.regionId??null,attackerId:effect.option?.attackerId??null,
          defenderId:effect.option?.defenderId??null}:null;})()}:null;
    if(events.length||added.length||removed.length||installs.length)buffer.push({
      serial:++serial,epoch,round:before.round,activeSeat:before.activeSeat,phase:before.phase,
      commandType:command.type,context,events,added,removed,installs});
    return result;
  };
  instance.takeComboTelemetry=()=>{const result=buffer;buffer=[];return result;};
};
send({ready:true,buildFingerprint:fingerprint,staticSchema});
const rl=createInterface({input:process.stdin,crlfDelay:Infinity});
for await(const line of rl){
  let request;
  try{request=JSON.parse(line);let response;
    const operationStarted=process.hrtime.bigint();
    if(request.op==='reset'){
      if((request.cardSet??'events')!==schemaCardSet)throw new Error('Arena course and encoder schema differ');
      arena=new PpoTrainingArena(request.seed,request.gameId??`ppo-${request.seed}`,{
        mode:request.mode,cardSet:request.cardSet??'events',
        buildFingerprint:fingerprint,trace:request.trace??'none',captureReplay:logSnapshots});
      if(request.comboTelemetry)attachComboTelemetry(arena,request.comboTelemetry);
      record({recordType:'AI训练记录',logFormat:'quartermaster-ppo-training-jsonl-v2',
        trainingMetadata:request.recordMetadata??null,...arena.header});
      response={observation:arena.observe(),header:arena.header};
      if(logSnapshots)record({recordType:'state',decisionCount:arena.decisions,
        snapshot:arena.exportSnapshot()});
    }else if(request.op==='step'){
      if(!arena)throw new Error('Reset the arena first');
      const prior=request.comboTelemetry?arena.observe():null;
      const selected=prior?.candidates.find(candidate=>candidate.id===request.action.actionId);
      const selectedFrom=request.comboTelemetry?cardZone(arena.state,selected?.cardId):null;
      response=arena.step(request.action);
      if(request.comboTelemetry){
        if(!arena.takeComboTelemetry)throw new Error('Combo telemetry was not enabled at reset');
        response.comboTelemetry={version:'combo-settlement-v1',round:prior.round,
          activeSeat:prior.activeSeat,decisionSeat:prior.decisionSeat,phase:prior.phase,
          node:prior.node,choiceKind:prior.choiceKind??null,
          offeredTriggers:prior.candidates.flatMap(candidate=>(candidate.choices??[])
            .filter(choice=>choice.kind==='trigger').map(choice=>choice.definitionId)),
          selected:selected?{id:selected.id,kind:selected.kind,cardId:selected.cardId??null,
            definitionId:selected.definitionId??null,cardType:selected.cardType??null,
            statusAction:!!selected.statusAction,fromZone:selectedFrom,
            afterZone:cardZone(arena.state,selected.cardId),choiceIds:selected.choiceIds??[],
            choices:selected.choices??[]}:null,
          commits:arena.takeComboTelemetry()};
      }
      if(response.record)record(response.record);
      if(logSnapshots)record({recordType:'state',decisionCount:arena.decisions,
        snapshot:arena.exportSnapshot()});
      if(response.result)record({recordType:'result',...response.result});
    }else if(request.op==='truncate'){
      if(!arena)throw new Error('Reset the arena first');
      response={result:arena.truncate(request.reason)};
      record({recordType:'result',...response.result});
    }else if(request.op==='snapshot'){
      if(!arena)throw new Error('Reset the arena first');
      response={snapshot:arena.exportSnapshot()};
    }else if(request.op==='restore'){
      arena=PpoTrainingArena.fromSnapshot(request.snapshot,{mode:request.snapshot.header.mode,
        cardSet:request.snapshot.header.cardSet,buildFingerprint:fingerprint,trace:request.trace??'none'});
      if(request.comboTelemetry)attachComboTelemetry(arena,request.comboTelemetry);
      response={observation:arena.observe(),header:arena.header,result:arena.result};
    }else if(request.op==='close'){
      send({ok:true});break;
    }else throw new Error('Unknown operation');
    const operationSeconds=Number(process.hrtime.bigint()-operationStarted)/1e9;
    send({ok:true,tag:request.tag??null,operationSeconds,...response});
  }catch(error){send({ok:false,error:error instanceof Error?error.message:String(error)});}
}
if(log)await new Promise(done=>log.end(done));
process.exit(0);
