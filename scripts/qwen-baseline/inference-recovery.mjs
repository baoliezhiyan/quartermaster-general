const recoverable = new Set(['WorkerRequestError','OutOfMemoryError']);

function sameDecision(expected,current){
  return expected.gameId===current.gameId&&expected.epoch===current.epoch&&expected.revision===current.revision;
}

/** A run may recover one unsent inference. This module never submits to the engine. */
export function inferenceRecovery({restart, request, log, now=()=>performance.now()}){
  let used=false;
  return async function infer({observe,side,observation,messages,seconds,deadline=Infinity}){
    const remaining=until=>Math.max(0,Math.min(seconds??180,(until-now())/1000));
    const first=await request(messages,remaining(deadline));
    if(first.ok||used||!recoverable.has(first.type)||['wall_budget','canceled'].includes(first.error)||remaining(deadline)===0)return first;
    const context={side,gameId:observation.gameId,epoch:observation.epoch,revision:observation.revision};
    const event=(stage,fields={})=>log({stage,...context,...fields});
    event('inference_failed',{failure:first});
    if(!sameDecision(observation,await observe(side))){
      event('stale_before_restart');
      return {...first,stale:true};
    }
    used=true;
    const recoveryDeadline=Math.min(deadline,now()+100_000);
    try{
      const replacement=await restart(recoveryDeadline);
      event('worker_restarted',{replacement});
      if(!sameDecision(observation,await observe(side))){
        event('stale_before_retry');
        return {...first,stale:true,recoveredWorker:true};
      }
      if(remaining(recoveryDeadline)===0)throw Error('recovery_budget');
      const retry=await request(messages,remaining(recoveryDeadline));
      event('inference_retried',{retry});
      return {...retry,recoveredWorker:true,initialFailure:first};
    }catch(error){
      event('recovery_failed',{error:error.message});
      return {...first,recoveryError:error.message};
    }
  };
}
