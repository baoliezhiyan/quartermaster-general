import assert from 'node:assert/strict';
import test from 'node:test';
import {inferenceRecovery} from './inference-recovery.mjs';

const position={gameId:'game',epoch:'epoch',revision:7};
const timeout={ok:false,type:'WorkerRequestError',error:'model_timeout_or_wall_budget'};
const ready={ok:true,text:'{"offer":2}'};

function fixture({views=[position,position],results=[timeout,ready],expires=false}={}){
  let clock=1000,loads=0;
  const events=[],sent=[],observed=[];
  const run=inferenceRecovery({
    now:()=>clock,
    request:async(messages,seconds)=>{sent.push({messages,seconds});return results.shift()??timeout;},
    restart:async deadline=>{loads++;if(expires)clock=deadline;return {pid:99};},
    log:entry=>events.push(entry),
  });
  return {run:(deadline=Infinity)=>run({
    side:0,observation:position,messages:[{role:'user',content:'same prompt'}],deadline,
    observe:async seat=>{observed.push(seat);return views.shift()??position;},
  }),events,sent,observed,loads:()=>loads};
}

test('one failed unsent inference can restart once with the same observation and prompt',async()=>{
  const f=fixture();
  const result=await f.run();
  assert.deepEqual(result,{...ready,recoveredWorker:true,initialFailure:timeout});
  assert.deepEqual(f.events.map(x=>x.stage),['inference_failed','worker_restarted','inference_retried']);
  assert.equal(f.loads(),1);
  assert.equal(f.sent.length,2);
  assert.equal(f.sent[0].messages,f.sent[1].messages);
  assert.equal(f.sent[1].seconds,100);
  assert.deepEqual(f.observed,[0,0]);
  assert.equal(await f.run(),timeout);
  assert.equal(f.loads(),1);
});

test('changed epoch or revision prevents resending the previous input',async()=>{
  for(const views of [[{...position,epoch:'new'}],[position,{...position,revision:8}]]){
    const f=fixture({views});
    assert.equal((await f.run()).stale,true);
    assert.equal(f.sent.length,1);
    assert.match(f.events.at(-1).stage,/^stale_/);
  }
});

test('valid generation, non-recoverable errors and expired recovery do not retry',async()=>{
  for(const result of [ready,{ok:false,type:'ValueError',error:'invalid input'},{...timeout,error:'canceled'}]){
    const f=fixture({results:[result]});
    assert.equal(await f.run(),result);
    assert.equal(f.loads(),0);
  }
  const f=fixture({expires:true});
  assert.equal((await f.run(2000)).recoveryError,'recovery_budget');
  assert.equal(f.sent.length,1);
  assert.equal(f.sent[0].seconds,1);
});
