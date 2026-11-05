import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

export const sampleIds=['naval-anchor-true','mulberry-sea_mediterranean','discard-forced-two','fleet-fee-true'];

export function displayObservation(observation, permuted){
  if(!permuted)return observation;
  return {...observation,offers:[...observation.offers].reverse().map(offer=>({
    ...offer,selections:offer.selections&&Object.fromEntries(Object.entries(offer.selections).map(([key,rule])=>
      [key,{...rule,ids:[...rule.ids].reverse()}])),
  }))};
}

export function freezeCases(cases, sha){
  return cases.map(({state,fact,...entry})=>({...entry,
    question:fact?.question??null,expected:fact?.expected??null,
    stateSha256:sha(JSON.stringify(state)),
    evidenceSha256:fact?sha(JSON.stringify(fact.evidence)):null,
  }));
}

export function inputPair(c,o,reference,makeInput){
  const display=displayObservation(o,c.cohort==='permuted');
  const versions=['A','B'].map(version=>{
    const action=makeInput(display,reference,undefined,undefined,version);
    const question=c.fact?makeInput(display,reference,c.fact.question,undefined,version):null;
    assert.deepEqual(question?.offers??action.offers,action.offers);
    if(question){
      assert.equal(question.messages[0].content,action.messages[0].content);
      const questionBoundary=question.messages[1].content.lastIndexOf('\n独立诊断问题：');
      const actionBoundary=action.messages[1].content.lastIndexOf('\n选择一项合法游戏操作。');
      assert(questionBoundary>=0&&actionBoundary>=0);
      assert.equal(question.messages[1].content.slice(0,questionBoundary),action.messages[1].content.slice(0,actionBoundary));
    }
    return {version,action,question};
  });
  assert.deepEqual(versions[0].action.offers,versions[1].action.offers);
  assert.equal(versions[0].action.messages[0].content,versions[1].action.messages[0].content);
  return {display,versions};
}

function jsonObject(raw){
  return JSON.parse(raw.trim().replace(/^\x60\x60\x60(?:json)?\s*([\s\S]*?)\s*\x60\x60\x60$/i,'$1'));
}
export function copiedExample(raw,example){
  if(!example)return null;
  try{assert.deepEqual(jsonObject(raw),example);return true;}catch{return false;}
}

function selectedIdentity(parsed){
  const selections=Object.fromEntries(Object.entries(parsed.request.selections??{}).sort(([a],[b])=>a.localeCompare(b))
    .map(([key,ids])=>[key,parsed.offer.selections?.[key]?.ordered?ids:[...ids].sort()]));
  return {offerId:parsed.request.offerId,selections};
}
const sameState=(a,b)=>a.gameId===b.gameId&&a.epoch===b.epoch&&a.revision===b.revision;

export function reportExpression(rows){
  function summarize(items){
    const counts={cases:items.length,generated:0,generationFailures:0,firstActionLegal:0,afterCorrectionLegal:0,
      engineAccepted:0,replayPassed:0,exampleCompared:0,exampleCopied:0,outputFailures:0,executionFailures:0,
      fact_read:{assigned:0,answered:0,correct:0,wrong:0},rule_application:{assigned:0,answered:0,correct:0,wrong:0}};
    const latency={inputTokens:[],firstTokenSeconds:[],seconds:[]};
    for(const row of items){
      for(const attempt of [...row.questionAttempts,...row.actionAttempts]){
        if(!attempt.model.ok){counts.generationFailures++;continue;}
        counts.generated++;
        for(const key of Object.keys(latency))if(Number.isFinite(attempt.model[key]))latency[key].push(attempt.model[key]);
        if(attempt.exampleCopied!==null&&attempt.exampleCopied!==undefined){
          counts.exampleCompared++;counts.exampleCopied+=Number(attempt.exampleCopied);
        }
        if(['output_format','invalid_selection'].includes(attempt.classification))counts.outputFailures++;
      }
      counts.firstActionLegal+=Number(row.actionAttempts[0]?.legal===true);
      counts.afterCorrectionLegal+=Number(row.actionAttempts.some(a=>a.legal));
      counts.engineAccepted+=Number(row.engine?.ok===true);
      counts.replayPassed+=Number(Number.isInteger(row.replay?.entries)&&row.replay.entries>0&&!row.replay.error);
      counts.executionFailures+=Number(!!row.error||row.engine?.ok===false||!!row.replay?.error);
      if(row.questionKind){
        const fact=counts[row.questionKind];
        fact.assigned++;
        if(typeof row.correct==='boolean'){
          fact.answered++;fact[row.correct?'correct':'wrong']++;
        }
      }
    }
    return {...counts,latency:Object.fromEntries(Object.entries(latency).map(([key,values])=>{
      const sorted=values.sort((a,b)=>a-b);
      return [key,{n:sorted.length,p50:sorted.length?sorted[Math.floor((sorted.length-1)*.5)]:null,
        p95:sorted.length?sorted[Math.floor((sorted.length-1)*.95)]:null}];
    }))};
  }
  const versions={};
  for(const version of ['A','B']){
    const items=rows.filter(r=>r.version===version);
    const breakdown=key=>Object.fromEntries([...new Set(items.map(r=>r[key]))]
      .map(value=>[value,summarize(items.filter(r=>r[key]===value))]));
    versions[version]={overall:summarize(items),cohort:breakdown('cohort'),country:breakdown('seat'),task:breakdown('task')};
  }
  const errors=rows.flatMap(r=>{
    const kinds=[...(r.correct===false?['semantic_error']:[]),...(r.error?[r.error]:[]),
      ...[...r.questionAttempts,...r.actionAttempts].filter(a=>a.classification!=='parsed').map(a=>a.classification),
      ...(r.engine?.ok===false?['engine_rejected']:[]),...(r.replay?.error?['replay_failed']:[])];
    return kinds.length?[{id:r.id,version:r.version,cohort:r.cohort,seat:r.seat,task:r.task,kinds}]:[];
  });
  const permutations=rows.filter(r=>r.cohort==='permuted').map(r=>{
    const original=rows.find(o=>o.id===r.original&&o.version===r.version);
    const comparable=!!original?.selection&&!!r.selection;
    let sameSelection=null;
    if(comparable){try{assert.deepEqual(original.selection,r.selection);sameSelection=true;}catch{sameSelection=false;}}
    return {version:r.version,id:r.id,original:r.original,sameSelection,
      sameAnswer:typeof original?.answer==='string'&&typeof r.answer==='string'?original.answer===r.answer:null};
  });
  return {versions,errors,permutations};
}

export async function runExpression({cases,engine,infer,corrected,saveReplay,record,write,progress,shouldStop}){
  const rows=[];
  async function runOne(c,version){
    const row={id:c.id,version,cohort:c.cohort,original:c.original,seat:c.seat,task:'unknown',questionKind:c.fact?.question.kind,
      questionAttempts:[],actionAttempts:[]};
    let room;
    try{
      room=await engine.createDiagnosticRoom({state:c.state,seed:c.seed,gameId:c.id});
      const side=engine.sideOf(c.seat),o=await room.observe(side);
      const {display,versions}=inputPair(c,o,room.reference,engine.makeInput);
      const {action,question}=versions.find(item=>item.version===version);
      row.task=o.decisions[0]?.kind??action.offers.find(v=>v.selections)?.command.type??action.offers[0]?.command.type??'none';
      const evaluate=async(input,task,parse,attempts)=>{
        let messages=input.messages;
        for(let attempt=0;attempt<2;attempt++){
          const model=await infer(room,side,o,messages);
          const entry={attempt,task,model,messages,exampleCopied:model.ok?copiedExample(model.text,input.example):null};
          attempts.push(entry);
          let parsed;
          if(!model.ok){
            entry.classification=model.stale?'stale_observation':'runtime_failure';
            entry.error=model.error;
          }else{
            try{
              if(model.hitOutputLimit)throw new SyntaxError('输出达到 token 上限');
              parsed=parse(model.text);
              if(task==='action')entry.legal=true;
              entry.classification='parsed';
            }catch(error){
              entry.classification=error instanceof SyntaxError?'output_format':task==='answer'?'output_format':'invalid_selection';
              entry.error=error.message;
              messages=corrected(input,model.text,error.message);
            }
          }
          record('ab-attempts.jsonl',{id:c.id,version,cohort:c.cohort,seat:c.seat,...entry});
          if(!model.ok||parsed!==undefined)return parsed;
        }
      };
      if(question){
        row.answer=await evaluate(question,'answer',engine.parseAnswer,row.questionAttempts);
        if(row.answer!==undefined)row.correct=row.answer===c.fact.expected;
        row.expected=c.fact.expected;
      }
      if(!sameState(o,await room.observe(side)))throw Error('stale_after_question');
      const parsed=await evaluate(action,'action',text=>engine.parseAction(text,action.offers,display,randomUUID()),row.actionAttempts);
      if(parsed){
        if(!sameState(o,await room.observe(side)))throw Error('stale_before_submission');
        row.selection=selectedIdentity(parsed);
        row.engine=(await room.submit(side,parsed.request)).result;
        if(row.engine.ok)row.replay=await saveReplay(room,c.id+'-'+version);
      }
    }catch(error){row.error=error.message;}
    finally{if(room)await room.close().catch(error=>{row.closeError=error.message;});}
    return row;
  }
  for(const [index,c] of cases.entries()){
    for(const version of index%2?['B','A']:['A','B']){
      progress(index+1,c,version);
      const row=await runOne(c,version);
      rows.push(row);
      record('ab-results.jsonl',row);
      write('ab-report.json',reportExpression(rows));
    }
    if(shouldStop())break;
  }
  return rows;
}
