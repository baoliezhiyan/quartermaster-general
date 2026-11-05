import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createInterface } from 'node:readline';
import { build } from 'vite';

const root = fileURLToPath(new URL('../../',import.meta.url));
const results = join(root,'outputs/qwen-baseline');
const python = process.env.QM_QWEN_PYTHON ?? 'D:/LLMs/environments/qm-qwen35-baseline/Scripts/python.exe';
const modelDir = 'D:/LLMs/models/Qwen3.5-2B';
const modelRevision = '15852e8c16360a2fea060d615a32b45270f8a8fc';
const git = (...args) => execFileSync('git',args,{cwd:root,encoding:'utf8'}).trim();
const sha = data => createHash('sha256').update(data).digest('hex');
const mode = process.argv[2] ?? 'preview';
const START = performance.now();
const elapsed = () => (performance.now()-START)/1000;

if (!['preview','bench','fixtures','games','verify'].includes(mode)) throw Error('未知入口 '+mode);
const base = 'c13904a0829f310e39f798215882653c21c26d64';
if (git('diff','--name-only',base,'--','src/core','src/data')) throw Error('正式核心或数据偏离固定基线');
const identity = JSON.parse(readFileSync(join(root,'src/matchLog/build-identity.json'),'utf8'));
if (identity.rulesFingerprint !== '994ca2cfa372a35ac8b1fb382aafb158ff3410c357f3ccb33441c5279cd5a8a7') {
  throw Error('正式规则指纹不匹配');
}

const out = join(results,'runs',new Date().toISOString().replace(/[:.]/g,'-')+'-'+mode+'-'+randomUUID().slice(0,8));
const manifest = JSON.parse(readFileSync(join(modelDir,'download-manifest.json'),'utf8'));
assert.equal(manifest.revision,modelRevision);
const configuration = {
  mode, base, sourceHead:git('rev-parse','HEAD'), sourceBranch:git('branch','--show-current'),
  worktreeStatus:git('status','--short'), changedFiles:git('diff','--stat','HEAD'),
  node:process.version, python, modelDir, modelRevision, modelRepo:manifest.repo,
  gameSeeds:[20261105,20261106],
  limits:{benchWallSeconds:540, requestSeconds:180, gameDecisions:3500, gameWallSeconds:14400, repeatedDecision:6},
  fullGameRules:{mode:'FULL',prelude:true,neutrality:true,balance:true},
};

if (mode === 'preview') {
  const deps=execFileSync(python,['-c',
    "import sys,importlib.metadata as m; print(sys.version); print('\\n'.join(p+'=='+m.version(p) for p in ('torch','transformers','accelerate','psutil','nvidia-ml-py')))"],
    {encoding:'utf8'});
  console.log(JSON.stringify({...configuration,...identity,results,dependencies:deps.trim()},null,2));
  try {
    console.log(execFileSync('nvidia-smi',['--query-gpu=name,memory.total,memory.used,driver_version','--format=csv'],{encoding:'utf8'}).trim());
  } catch(error) { console.log('无法读取 nvidia-smi：'+error.message); }
  process.exit(0);
}

mkdirSync(out,{recursive:true});
const write = (name,value) => writeFileSync(join(out,name),JSON.stringify(value,null,2)+'\n','utf8');
const record = (name,value) => appendFileSync(join(out,name),JSON.stringify(value)+'\n','utf8');
const bundleDir = join(out,'engine');
await build({root,logLevel:'warn',build:{
  ssr:join(root,'scripts/qwen-baseline/engine.ts'),outDir:bundleDir,emptyOutDir:false,
  rollupOptions:{output:{entryFileNames:'engine.mjs'}},
}});
const bundle = join(bundleDir,'engine.mjs');
const engine = await import(pathToFileURL(bundle).href);
const {createDiagnosticRoom, fixtures, makeInput, parseAction, sideOf, checkClientReplay}=engine;
const fixed=fixtures();
write('run.json',{...configuration,...engine.engineIdentity,promptVersion:engine.PROMPT_VERSION,
  diagnosticBundleSha256:sha(readFileSync(bundle)), modelWorkerSha256:sha(readFileSync(join(root,'scripts/qwen-baseline/model.py'))), orchestratorSha256:sha(readFileSync(fileURLToPath(import.meta.url))), fixtureSeeds:fixed.map(f=>({id:f.id,seed:f.seed}))});
console.log('结果目录 '+out);
console.log('固定局面 '+fixed.length+' 个，正式规则 '+engine.engineIdentity.rulesFingerprint);

function actionable(observation) {
  return observation.offers.some(o=>o.command.type!=='ACK_RESPONSE_NOTICE'||(observation.resolutionRunning&&!observation.decisions.length&&observation.blockingNoticeSeats.includes(o.seat)));
}
function shortResult(observation) {
  return {revision:observation.revision, round:observation.round, phase:observation.phase,
    scores:observation.public.scores, units:observation.mapFacts.units,
    recentPublicActions:observation.public.log?.slice(-4),
    placements:observation.placements, effects:observation.resolutionFacts};
}
async function saveReplay(room, id) {
  const text=await room.exportReplay();
  writeFileSync(join(out,id+'.jsonl'),text,'utf8');
  try { return await checkClientReplay(text); }
  catch(error) { return {error:error.message}; }
}
function logProgress(id, step, observation) {
  console.log('['+id+'] '+observation.decisionSeats.join('/')+' · '+observation.phase+
    ' · 第'+observation.round+'轮 · 已完成 '+step+' 个决定 · '+elapsed().toFixed(1)+'秒');
}

if(mode==='verify'){
  const cases=['opening-seven','discard-forced-two','prelude-neutrality','mulberry-sea_mediterranean','battle-air','fleet-fee-true'];
  const checked=[];
  for(const id of cases){
    const f=fixed.find(v=>v.id===id);
    const room=await createDiagnosticRoom({state:f.state,seed:f.seed,gameId:id});
    try {
      const side=sideOf(f.seat),o=await room.observe(side);
      const view=makeInput(o,room.reference,f.fact?.question);
      assert(view.offers.length>0,id);
      assert.equal(Object.keys(o.privateCountries).length,3);
      assert(Object.keys(o.privateCountries).every(s=>sideOf(s)===side));
      const index=view.offers.findIndex(v=>v.seat===f.seat && (id!=='prelude-neutrality'||v.command.type==='PLAY_PRELUDE'));
      assert(index>=0);
      const offer=view.offers[index];
      const select=Object.fromEntries(Object.entries(offer.selections??{}).map(([k,v])=>[k,
        v.ids.map((cid,i)=>({cid,i})).filter(({cid})=>id!=='fleet-fee-true'||o.privateCountries.germany.hand.some(c=>c.id===cid&&c.definitionId==='build_navy')).slice(0,Math.max(v.min,id.startsWith('mulberry')?1:0)).map(({i})=>i)]));
      const action={offer:index,select,...(f.fact?{answer:f.fact.expected}:{})};
      if(id==='opening-seven')assert.throws(()=>parseAction(JSON.stringify({...action,select:{cardIds:[0]}}),view.offers,o,randomUUID(),f.fact.question));
      if(id.startsWith('mulberry')) {
        const q=o.decisions[0],portWindows=q.options.filter(v=>v.id.includes('special_80')).map(v=>v.windowId);
        assert.equal(new Set(portWindows).size,2);
        assert.equal(new Set(q.triggerReasons.filter(r=>portWindows.includes(r.windowId)).map(r=>r.effect?.regionId)).size,2);
      }
      const parsed=parseAction(JSON.stringify(action),view.offers,o,randomUUID(),f.fact?.question);
      const response=await room.submit(side,parsed.request);
      assert.equal(response.result.ok,true,JSON.stringify(response.result));
      const replay=await saveReplay(room,id);
      assert(!replay.error,JSON.stringify(replay));
      checked.push({id,offer:parsed.offer.command.type,replay});
    } finally { await room.close(); }
  }
  const buildFixture=fixed.find(v=>v.id==='connect-before-check-true');
  const room=await createDiagnosticRoom({state:buildFixture.state,seed:buildFixture.seed,gameId:buildFixture.id});
  try {
    const o=await room.observe(0);
    const buildId=o.privateCountries.germany.hand.find(c=>c.definitionId==='build_army').id;
    const offer=o.offers.find(v=>v.command.cardId===buildId);
    const reply=await room.submitAction(0,{requestId:randomUUID(),gameId:o.gameId,epoch:o.epoch,
      revision:o.revision,offerId:offer.id,intent:{regionId:'eastern_europe'}});
    const next=await room.observe(0);
    assert(next.mapFacts.units.some(u=>u.country==='germany'&&u.regionId==='eastern_europe'));
    const replay=await saveReplay(room,'merged-build');
    assert(!replay.error,JSON.stringify(replay));
    checked.push({id:'merged-build',status:reply.receipt.status,replay});
  } finally { await room.close(); }
  const summary={passed:true,configuredFixtures:fixed.length,executedSyntheticActions:checked};
  write('summary.json',summary);console.log(JSON.stringify(summary,null,2));process.exit(0);
}

class ModelWorker {
  constructor(deadline) {
    this.deadline=deadline;
    this.child=spawn(python,[join(root,'scripts/qwen-baseline/model.py'),modelDir],
      {cwd:root,stdio:['pipe','pipe','pipe'],windowsHide:true});
    this.child.on('error',error=>{this.spawnError=error;});
    this.child.stdin.on('error',()=>{});
    this.child.stderr.on('data',chunk=>appendFileSync(join(out,'model.stderr.log'),chunk));
    this.reader=createInterface({input:this.child.stdout})[Symbol.asyncIterator]();
  }
  async read() {
    const limit=Math.min(configuration.limits.requestSeconds*1000,this.deadline-performance.now());
    if(limit<=0){this.close();throw Error('wall_budget');}
    let timer;
    try {
      const line=await Promise.race([this.reader.next(),new Promise((_,reject)=>{
        timer=setTimeout(()=>{this.close();reject(Error('model_timeout_or_wall_budget'));},limit);
      })]);
      if(line.done)throw this.spawnError??Error('模型进程已退出，查看 model.stderr.log');
      return JSON.parse(line.value);
    } finally {clearTimeout(timer);}
  }
  request(messages,op='generate') {
    if(this.child.exitCode!==null || this.child.killed) throw Error('model_worker_unavailable');
    this.child.stdin.write(JSON.stringify({op,messages})+'\n','utf8');
    return this.read();
  }
  close(){if(this.child.exitCode===null&&!this.child.killed)this.child.kill();}
}

const worker=new ModelWorker(mode==='bench'?START+configuration.limits.benchWallSeconds*1000:Infinity);
process.once('SIGINT',()=>worker.close());
process.once('SIGTERM',()=>worker.close());
let failed=false;
const summaries=[];
try {
  console.log('加载本地 BF16 CUDA 模型');
  const loaded=await worker.read();
  write('model-load.json',loaded);
  if(!loaded.ok)throw Error(loaded.error);
  console.log('加载完成 '+loaded.modelLoadSeconds.toFixed(2)+'秒 · '+loaded.device);

  async function decide(room, side, o, id, step, fact, previous, maxRetries=1) {
    const before=performance.now();
    const input=makeInput(o,room.reference,fact?.question,previous);
    if(!input.offers.length)return {stop:'no_authorized_offer'};
    let correction;
    let prepMs=performance.now()-before;
    for(let attempt=0;attempt<=maxRetries;attempt++){
      const messages=correction ? [...input.messages,{role:'user',content:'上次输出未通过校验：'+correction+'。按原候选重试，返回一个JSON对象。'}] : input.messages;
      const envBefore=prepMs;
      const generated=await worker.request(messages);
      const afterInference=performance.now();
      const row={id,step,attempt,observation:o,messages,legalOffers:input.offers,expectedFact:fact,model:generated};
      if(!generated.ok){
        record('decisions.jsonl',{...row,classification:generated.type==='OutOfMemoryError'?'oom':'model_error'});
        return {stop:'model_error',error:generated.error,fatal:true};
      }
      let parsed;
      try {
        if(generated.hitOutputLimit)throw Error('输出达到token上限');
        parsed=parseAction(generated.text,input.offers,o,randomUUID(),fact?.question);
      } catch(error) {
        correction=error.message;
        record('decisions.jsonl',{...row,classification:error instanceof SyntaxError?'output_format':'selection_contract',error:correction,environmentMs:envBefore+performance.now()-afterInference});
        continue;
      }
      const latest=await room.observe(side);
      if(latest.epoch!==o.epoch || latest.revision!==o.revision) {
        record('decisions.jsonl',{...row,parsed:parsed.request,classification:'stale_observation'});
        return {stop:'stale_observation'};
      }
      try {
        const result=await room.submit(side,parsed.request);
        if(!result.result.ok)throw Error(result.result.error);
        const after=await room.observe(side);
        const factCorrect=fact?parsed.answer?.trim()===fact.expected:null;
        const classification=factCorrect===false?fact.question.kind+'_mismatch':'legal_action';
        const effect=shortResult(after);
        record('decisions.jsonl',{...row,parsed:parsed.request,result:result.result,classification,factCorrect,
          observedResult:effect,environmentMs:envBefore+performance.now()-afterInference});
        return {ok:true,classification,factCorrect,questionKind:fact?.question.kind,
          previous:{action:parsed.offer.label,result:result.result,
            phase:after.phase,publicTail:after.public.log?.slice(-3)}};
      } catch(error) {
        if(/STALE|WRONG_GAME|局面已更新/i.test(error.message)) {
          record('decisions.jsonl',{...row,parsed:parsed.request,classification:'stale_observation',error:error.message});
          return {stop:'stale_observation'};
        }
        const after=await room.observe(side);
        correction=error.message;
        record('decisions.jsonl',{...row,parsed:parsed.request,classification:'engine_rejected',error:correction,
          environmentMs:envBefore+performance.now()-afterInference});
        if(after.epoch!==o.epoch||after.revision!==o.revision)return {stop:'rejected_after_state_change',error:correction};
      }
      prepMs=performance.now()-afterInference;
    }
    return {stop:'invalid_after_retry',error:correction};
  }

  if(mode==='bench') {
    const available=[];
    for(const id of ['own-land-false','opening-seven','prelude-neutrality','mulberry-sea_mediterranean','discard-forced-two']){
      const f=fixed.find(v=>v.id===id);
      const room=await createDiagnosticRoom({state:f.state,seed:f.seed,gameId:id});
      try {
        const o=await room.observe(sideOf(f.seat));
        const input=makeInput(o,room.reference);
        const measured=await worker.request(input.messages,'length');
        if(!measured.ok)throw Error(measured.error);
        available.push({id,inputTokens:measured.inputTokens,observation:o,messages:input.messages,offers:input.offers});
      } finally {await room.close();}
    }
    available.sort((a,b)=>a.inputTokens-b.inputTokens);
    const inputs=[available[0],available[0],available[Math.floor(available.length/2)],available.at(-1)];
    const names=['first-short','warm-short','warm-medium','warm-long'];
    for(const [index,input] of inputs.entries()){
      console.log('性能 '+(index+1)+'/'+inputs.length+' · '+names[index]+' · '+input.inputTokens+' tokens');
      const result=await worker.request(input.messages);
      record('performance.jsonl',{profile:names[index],...input,model:result});
      const {text:_text,...metrics}=result;
      summaries.push({profile:names[index],fixture:input.id,...metrics});
      if(!result.ok)break;
      if(index===0) {
        // Submit one representative real model decision in a fresh equivalent room.
        const f=fixed.find(v=>v.id===input.id);
        const room=await createDiagnosticRoom({state:f.state,seed:f.seed,gameId:f.id});
        try {
          const side=sideOf(f.seat),o=await room.observe(side),start=performance.now();
          const parsed=parseAction(result.text,makeInput(o,room.reference).offers,o,randomUUID());
          const applied=await room.submit(side,parsed.request);
          write('representative-action.json',{request:parsed.request,result:applied.result,
            observation:o,environmentMs:performance.now()-start,replay:await saveReplay(room,'representative-action')});
        } catch(error) {write('representative-action.json',{error:error.message});}
        finally {await room.close();}
      }
    }
    failed=summaries.some(row=>!row.ok);
  } else {
    const total=mode==='fixtures'?fixed.length:2;
    for(let index=0;index<total;index++){
      const f=mode==='fixtures'?fixed[index]:undefined;
      const id=f?.id??'game-'+(index+1);
      const room=await createDiagnosticRoom({state:f?.state,seed:f?.seed??configuration.gameSeeds[index],gameId:id});
      const previous=[undefined,undefined];
      let steps=0, stale=0, result;
      const begun=performance.now(), repetitions=new Map();
      console.log('开始 '+(index+1)+'/'+total+' '+id);
      try {
        while(true){
          const views=await Promise.all([room.observe(0),room.observe(1)]);
          if(views[0].status==='finished'){result={stop:'natural_finish',winner:views[0].public.winner,reason:views[0].public.victoryReason};break;}
          if(views.some(o=>o.status==='unsupported')){result={stop:'unsupported',reason:views[0].unsupportedReason};break;}
          if(steps>=configuration.limits.gameDecisions||(performance.now()-begun)/1000>configuration.limits.gameWallSeconds){result={stop:'game_budget'};break;}
          let side=f?sideOf(f.seat):views.findIndex(actionable);
          if(side<0)side=views.findIndex(v=>v.offers.length>0);
          if(side<0||!views[side].offers.length){
            const waits=await Promise.all([room.wait(0),room.wait(1)]);
            side=waits.findIndex(v=>v.status==='decision');
            if(side<0){result={stop:'unsupported_no_authorized_decision',waits:waits.map(w=>w.status??'lease')};break;}
            continue;
          }
          const o=views[side];
          const signature=sha(JSON.stringify([side,o.round,o.phase,o.activeSeat,o.public.prelude,
            o.public.airAction,o.public.scores,o.public.units,o.privateCountries,
            o.offers.map(v=>[v.label,v.command.type,v.seat,v.selections]),o.decisions.map(v=>[v.kind,v.prompt])]));
          const seen=(repetitions.get(signature)??0)+1;
          repetitions.set(signature,seen);
          if(seen>configuration.limits.repeatedDecision){result={stop:'action_loop',signature};break;}
          logProgress((index+1)+'/'+total+' '+id,steps,o);
          result=await decide(room,side,o,id,steps,f?.fact,previous[side]);
          if(result.stop==='stale_observation'&&++stale<=2)continue;
          if(!result.ok)break;
          stale=0;
          steps++;
          previous[side]=result.previous;
          if(f){result={...result,stop:'fixed_case_complete'};break;}
        }
      } catch(error){result={stop:'execution_error',error:error.message};}
      finally {
        const replay=await saveReplay(room,id).catch(error=>({error:error.message}));
        await room.close();
        const {previous:_previous,...outcome}=result??{stop:'interrupted'};
        const summary={id,source:f?.source??'正式完整游戏',seed:f?.seed??configuration.gameSeeds[index],
          steps,seconds:(performance.now()-begun)/1000,...outcome,replay};
        summaries.push(summary);record('cases.jsonl',summary);
        console.log(id+' '+summary.stop+' · 已完成 '+steps+' 个决定');
      }
      if(result?.fatal)break;
    }
    failed=summaries.some(s=>!['natural_finish','fixed_case_complete'].includes(s.stop)||s.replay.error);
  }
} catch(error) {
  failed=true;
  record('errors.jsonl',{error:error.message,seconds:elapsed()});
  console.error(error.message);
} finally {
  worker.close();
  const factual={};
  for(const row of summaries.filter(s=>s.questionKind)){
    const stats=factual[row.questionKind]??={correct:0,incorrect:0};
    stats[row.factCorrect?'correct':'incorrect']++;
  }
  write('summary.json',{mode,failed,seconds:elapsed(),factual,summaries});
  console.log('结果目录 '+out);
}
if(failed)process.exitCode=1;
