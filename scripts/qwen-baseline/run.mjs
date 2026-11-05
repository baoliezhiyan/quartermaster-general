import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createInterface } from 'node:readline';
import { build } from 'vite';
import { freezeCases,inputPair,runExpression,sampleIds } from './expression-ab.mjs';
import { inferenceRecovery } from './inference-recovery.mjs';

const root = fileURLToPath(new URL('../../',import.meta.url));
const results = join(root,'outputs/qwen-baseline');
const python = process.env.QM_QWEN_PYTHON ?? 'D:/LLMs/environments/qm-qwen35-baseline/Scripts/python.exe';
const modelDir = 'D:/LLMs/models/Qwen3.5-2B';
const modelRevision = '15852e8c16360a2fea060d615a32b45270f8a8fc';
const gitPathRecord = 'D:/LLMs/environments/qm-qwen35-baseline/runtime/git-path.txt';
const gitExe = process.env.QM_QWEN_GIT ?? (existsSync(gitPathRecord) ? readFileSync(gitPathRecord,'utf8').trim() : 'git');
const git = (...args) => execFileSync(gitExe,args,{cwd:root,encoding:'utf8'}).trim();
const backend = process.env.QM_QWEN_BACKEND ?? 'efficient-bf16';
if (!['efficient-bf16','reference-bf16'].includes(backend)) throw Error('未知推理后端 '+backend);
const accelerated = backend === 'efficient-bf16';
const textOnly=process.env.QM_QWEN_TEXT_ONLY!=='0';
const compareKernels=accelerated&&process.env.QM_QWEN_COMPARE!=='0';
const kernels = accelerated ? (process.env.QM_QWEN_KERNELS ?? 'D:/LLMs/environments/qm-qwen35-kernels') : '';
const compiler = accelerated ? join(kernels,'triton/runtime/tcc/tcc.exe') : '';
const benchSeconds = Number(process.env.QM_QWEN_BENCH_SECONDS ?? 540);
if (!Number.isSafeInteger(benchSeconds) || benchSeconds < 1 || benchSeconds > 540) throw Error('性能短测上限须在 1–540 秒');
const sha = data => createHash('sha256').update(data).digest('hex');
const mode = process.argv[2] ?? 'preview';
const expressionRun=mode==='ab'||mode==='ab-smoke';
const expressionWallSeconds=mode==='ab-smoke'?165:3600;
const expressionRequestSeconds=60;
const START = performance.now();
const elapsed = () => (performance.now()-START)/1000;

if (!['preview','bench','fixtures','games','verify','samples','bench-long','stability','stability-cold','ab','ab-smoke','ab-plan','ab-verify'].includes(mode)) throw Error('未知入口 '+mode);
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
  mode, base, precision:'BF16 CUDA', promptVersion:'qm-qwen-baseline/2.1', protocolVersion:'qm-qwen-decision/2', sourceHead:git('rev-parse','HEAD'), sourceBranch:git('branch','--show-current'),
  worktreeStatus:git('status','--short'), changedFiles:git('diff','--stat','HEAD'),
  node:process.version, python, modelDir, modelRevision, modelRepo:manifest.repo,
  gameSeeds:[20261105,20261106],
  backend, textOnly, compareKernels, memoryPolicy:process.env.QM_QWEN_MEMORY_POLICY??'pressure', kernelPath:kernels, compiler, limits:{benchWallSeconds:benchSeconds, requestSeconds:180, gameDecisions:3500, gameWallSeconds:14400, repeatedDecision:6},
  ...(expressionRun?{expressionWallSeconds,expressionRequestSeconds}:{}),
  fullGameRules:{mode:'FULL',prelude:true,neutrality:true,balance:true},
};

if (mode === 'preview') {
  const deps=execFileSync(python,['-c',
    "import sys,importlib.metadata as m; print(sys.version); print('\\n'.join(p+'=='+m.version(p) for p in ('torch','transformers','accelerate','psutil','nvidia-ml-py')))"],
    {encoding:'utf8'});
  console.log(JSON.stringify({...configuration,...identity,results,dependencies:deps.trim(), kernelCompilerAvailable:!accelerated||existsSync(compiler)},null,2));
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
const {createDiagnosticRoom, fixtures, makeInput, parseAction, parseAnswer, sideOf, checkClientReplay}=engine;
const fixed=fixtures();
assert.equal(configuration.promptVersion,engine.PROMPT_VERSION);
assert.equal(configuration.protocolVersion,engine.PROTOCOL_VERSION);
write('run.json',{...configuration,...engine.engineIdentity,promptVersion:engine.PROMPT_VERSION,
  diagnosticBundleSha256:sha(readFileSync(bundle)), equivalenceSha256:sha(readFileSync(join(root,'scripts/qwen-baseline/equivalence.py'))), expressionSha256:sha(readFileSync(join(root,'scripts/qwen-baseline/expression-ab.mjs'))), recoverySha256:sha(readFileSync(join(root,'scripts/qwen-baseline/inference-recovery.mjs'))), modelWorkerSha256:sha(readFileSync(join(root,'scripts/qwen-baseline/model.py'))), orchestratorSha256:sha(readFileSync(fileURLToPath(import.meta.url))), fixtureSeeds:fixed.map(f=>({id:f.id,seed:f.seed}))});
console.log('结果目录 '+out);
console.log('固定局面 '+fixed.length+' 个 · '+engine.PROMPT_VERSION+' · '+engine.PROTOCOL_VERSION+' · '+modelRevision+' · BF16 CUDA · '+backend);
if(mode==='fixtures' || mode==='verify') {
  write('fixture-contract.json',fixed.map(({id,source,seed,seat,state,fact})=>({id,source,seed,seat,rules:state.rules,fact})));
}

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

const sampleCases=[
  ['standard-play','own-land-false'],['parameter-selection','opening-seven'],
  ['response-chain','mulberry-sea_mediterranean'],['long-prelude','prelude-neutrality'],
];
function savePrompt(label,messages){
  write(label+'-messages.json',messages);
  writeFileSync(join(out,label+'-prompt.md'),messages.map(m=>'## '+m.role+'\n\n'+m.content).join('\n\n')+'\n','utf8');
}
const expressionModes=['ab','ab-smoke','ab-plan','ab-verify'];
let pairedCases;
if(expressionModes.includes(mode)){
  const planned=engine.expressionCases(fixed);
  const manifest=freezeCases(planned,sha);
  write('ab-plan.json',manifest);
  if(mode==='ab-plan')process.exit(0);
  const frozen=JSON.parse(readFileSync(join(root,'scripts/qwen-baseline/ab-freeze.json'),'utf8'));
  assert.deepEqual(manifest,frozen,'冻结测试清单与当前实现不符');
  if(mode==='ab-verify'){
    let checked=0;
    for(const c of planned){
      const room=await createDiagnosticRoom({state:c.state,seed:c.seed,gameId:c.id});
      try{
        const side=sideOf(c.seat),o=await room.observe(side);
        const {versions,display}=inputPair(c,o,room.reference,makeInput);
        assert(versions[0].action.offers.length>0,c.id);
        if(c.cohort==='permuted'){
          const normal=makeInput(o,room.reference).offers;
          const actual=versions[0].action.offers;
          assert.deepEqual(actual.map(v=>v.id),normal.map(v=>v.id).reverse());
          assert(actual.some(v=>Object.values(v.selections??{}).some(rule=>rule.ids.length>1)));
          for(const v of actual)for(const [key,rule] of Object.entries(v.selections??{})){
            assert.deepEqual(rule.ids,[...normal.find(n=>n.id===v.id).selections[key].ids].reverse());
          }
        }
        const b=versions[1].action.messages[1].content;
        for(const u of o.mapFacts.units)assert(b.includes('部队 '+u.id+'：国家='),c.id+' 缺部队 '+u.id);
        const other=await room.observe(1-side);
        const publiclyKnown=new Set(Object.values(o.public.countries).flatMap(v=>[...v.active,...v.visibleDiscard,...v.revealedResponses]).map(card=>card.id));
        for(const d of Object.values(other.privateCountries))for(const card of [...d.hand,...d.faceDown]){
          if(!publiclyKnown.has(card.id))assert(!b.includes(card.id),c.id+' 泄露对方牌实例 '+card.id);
        }
        if(sampleIds.includes(c.id))for(const {version,action,question} of versions){
          savePrompt(c.id+'-'+version,action.messages);
          if(question)savePrompt(c.id+'-'+version+'-qa',question.messages);
        }
        // For ordered/unordered permutations, reconstruct the same formal IDs
        // using each displayed index, without submitting any guessed move.
        if(c.cohort==='permuted'){
          const index=versions[0].action.offers.findIndex(v=>v.selections);
          const offer=versions[0].action.offers[index];
          const select=Object.fromEntries(Object.entries(offer.selections).map(([k,r])=>[k,Array.from({length:r.min},(_,i)=>i)]));
          const parsed=parseAction(JSON.stringify({offer:index,select}),versions[0].action.offers,display,randomUUID());
          for(const [k,nums] of Object.entries(select))assert.deepEqual(parsed.request.selections[k],nums.map(i=>offer.selections[k].ids[i]));
        }
        checked++;
      }finally{await room.close();}
    }
    write('summary.json',{mode,checked,cases:manifest.length,sampleIds});
    console.log('冻结场景、相同候选、问答隔离、权限及逆序编号映射检查通过 · '+checked+' 例');
    process.exit(0);
  }
  pairedCases=mode==='ab-smoke'?planned.filter(c=>c.id==='mulberry-sea_mediterranean'):planned;
  const firstRequests=pairedCases.length*2+pairedCases.filter(c=>c.fact).length*2;
  const experiment={sourceHead:configuration.sourceHead,model:manifestModel(),A:engine.PROMPT_VERSION,B:engine.EXPRESSION_VERSION,
    cases:pairedCases.length,firstRequests,maxRequests:firstRequests*2+1,
    requestSeconds:expressionRequestSeconds,wallSeconds:expressionWallSeconds,freezeSha256:sha(JSON.stringify(frozen))};
  write('ab-config.json',experiment);
  console.log(JSON.stringify(experiment,null,2));
}
function manifestModel(){return manifest.repo+' @ '+modelRevision+' · BF16 CUDA · thinking=false';}

if(mode==='samples'){
  for(const [label,id] of sampleCases){
    const f=fixed.find(v=>v.id===id),room=await createDiagnosticRoom({state:f.state,seed:f.seed,gameId:id});
    try {savePrompt(label,makeInput(await room.observe(sideOf(f.seat)),room.reference).messages);}
    finally {await room.close();}
  }
  process.exit(0);
}

if(mode==='verify'){
  const cases=['opening-seven','discard-forced-two','discard-none','prelude-neutrality','mulberry-sea_mediterranean','battle-air','fleet-fee-true'];
  const checked=[];
  const checks={projectedPrompts:0,ownedDeckDefinitions:0,nonPublicOpponentCardsChecked:0};
  for(const f of fixed){
    const room=await createDiagnosticRoom({state:f.state,seed:f.seed,gameId:f.id});
    try {
      const side=sideOf(f.seat);
      for(const s of [side,1-side]){
        const observation=await room.observe(s);
        assert.equal(Object.keys(observation.privateCountries).length,3,f.id);
        assert(Object.keys(observation.privateCountries).every(seat=>sideOf(seat)===s),f.id);
        const input=makeInput(observation,room.reference,f.fact?.question);
        const prompt=input.messages[1].content;
        checks.projectedPrompts++;
        for(const deck of Object.values(observation.privateCountries)){
          const definitions=new Map([...deck.deckComposition,...(deck.prelude?.deckComposition??[])]
            .map(c=>[c.definitionId+(c.balance?'/平衡':''),c]));
          for(const [key,card] of definitions){
            assert(prompt.includes(key+' | '+card.name+' | '+card.type+' | '),f.id+' 缺少授权牌面 '+key);
            checks.ownedDeckDefinitions++;
          }
        }
        const opposing=await room.observe(1-s);
        const visible=new Set(Object.values(observation.public.countries)
          .flatMap(d=>[...d.active,...d.visibleDiscard,...d.revealedResponses]).map(c=>c.id));
        for(const deck of Object.values(opposing.privateCountries)){
          for(const card of [...deck.hand,...deck.faceDown,...(deck.prelude?.hand??[])].filter(c=>!visible.has(c.id))){
            assert(!prompt.includes(JSON.stringify(card.id)),f.id+' 泄露对方未公开牌 '+card.id);
            checks.nonPublicOpponentCardsChecked++;
          }
        }
        if(s===side) assert(input.offers.some(o=>o.seat===f.seat),f.id+' 缺少当事国候选');
      }
    } finally {await room.close();}
  }
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
      const action=Object.keys(select).length?{offer:index,select}:{offer:index};
      assert.throws(()=>parseAction(JSON.stringify({offer:index,select:{fields:[]}}),view.offers,o,randomUUID()),/没有参数/);
      assert.throws(()=>parseAction(JSON.stringify({offer:index,answer:"是"}),view.offers,o,randomUUID()),/只接受/);
      assert.throws(()=>parseAnswer(JSON.stringify(action)),/问答只接受/);
      if(f.fact)assert.equal(parseAnswer(JSON.stringify({answer:f.fact.expected})),f.fact.expected);
      if(offer.selections&&Object.values(offer.selections).some(v=>v.min>0)){
        assert.throws(()=>parseAction(JSON.stringify({offer:index}),view.offers,o,randomUUID()));
      }
      if(id==='fleet-fee-true'){
        const bad=offer.selections.ids.ids.findIndex(cid=>o.privateCountries.germany.hand.some(c=>c.id===cid&&c.definitionId!=='build_navy'));
        assert(bad>=0);
        assert.throws(()=>parseAction(JSON.stringify({offer:index,select:{ids:[bad]}}),view.offers,o,randomUUID()),/费用类别/);
      }
      if(id==='opening-seven'){
        assert.throws(()=>parseAction(JSON.stringify({offer:index,select:{cardIds:Array(7).fill(0)}}),view.offers,o,randomUUID()));
        assert.throws(()=>parseAction(JSON.stringify(action),view.offers,{...o,bindings:[]},randomUUID()),/授权/);
      }
      if(id==='opening-seven')assert.throws(()=>parseAction(JSON.stringify({...action,select:{cardIds:[0]}}),view.offers,o,randomUUID()));
      if(id.startsWith('mulberry')) {
        const q=o.decisions[0],portWindows=q.options.filter(v=>v.id.includes('special_80')).map(v=>v.windowId);
        assert.equal(new Set(portWindows).size,2);
        assert.equal(new Set(q.triggerReasons.filter(r=>portWindows.includes(r.windowId)).map(r=>r.effect?.regionId)).size,2);
      }
      const parsed=parseAction(JSON.stringify(action),view.offers,o,randomUUID());
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
  const summary={passed:true,configuredFixtures:fixed.length,checks,executedSyntheticActions:checked};
  write('summary.json',summary);console.log(JSON.stringify(summary,null,2));process.exit(0);
}

class ModelWorker {
  constructor(deadline) {
    this.deadline=deadline;
    this.generations=0;
    this.child=spawn(python,[join(root,'scripts/qwen-baseline/model.py'),modelDir,join(out,'memory.jsonl')],
      {cwd:root,env:{...process.env,PYTHONDONTWRITEBYTECODE:'1',PYTHONPATH:kernels,CC:compiler,
        QM_QWEN_TEXT_ONLY:textOnly?'1':'0',QM_QWEN_KERNELS:kernels,QM_QWEN_EFFICIENT_SDPA:accelerated?'1':'0',QM_QWEN_FLA_CONV:accelerated?'1':'0',
        TRITON_CACHE_DIR:'D:/LLMs/environments/qm-qwen35-kernel-cache'},stdio:['pipe','pipe','pipe'],windowsHide:true});
    this.child.on('error',error=>{this.spawnError=error;});
    this.child.stdin.on('error',()=>{});
    this.child.stderr.on('data',chunk=>appendFileSync(join(out,'model.stderr.log'),chunk));
    this.reader=createInterface({input:this.child.stdout})[Symbol.asyncIterator]();
  }
  async read(seconds=configuration.limits.requestSeconds) {
    const limit=Math.min(seconds*1000,this.deadline-performance.now());
    if(limit<=0){this.close();throw Error('wall_budget');}
    let timer;
    try {
      const line=await Promise.race([this.reader.next(),new Promise((_,reject)=>{
        timer=setTimeout(()=>{this.close();reject(Error('model_timeout_or_wall_budget'));},limit);
      })]);
      if(line.done)throw this.spawnError??Error('模型进程已退出，查看 model.stderr.log');
      const response=JSON.parse(line.value);
      if(response.kind==='ready')this.workerPid=response.pid;
      return response;
    } finally {clearTimeout(timer);}
  }
  request(messages,op='generate',seconds,requestId) {
    if(this.stopping||this.child.exitCode!==null||this.child.signalCode!==null) throw Error('model_worker_unavailable');
    this.child.stdin.write(JSON.stringify({op,messages,requestId})+'\n','utf8');
    return this.read(seconds);
  }
  close(){
    if(this.stopping||this.child.exitCode!==null||this.child.signalCode!==null)return;
    this.stopping=true;
    if(process.platform==='win32'&&this.child.pid){
      try{
        // Windows venv python.exe is a launcher. Stop only this worker's tree
        // so a blocked CUDA process cannot survive its launcher's exit.
        execFileSync(join(process.env.SystemRoot??'C:/Windows','System32/taskkill.exe'),
          ['/PID',String(this.child.pid),'/T','/F'],{stdio:'ignore',windowsHide:true,timeout:5000});
        return;
      }catch(error){
        this.stopError=error;
      }
    }
    this.child.kill();
  }
  async stop(){
    if(this.stopError)throw Error('worker_tree_stop_failed');
    if(this.child.exitCode!==null||this.child.signalCode!==null)return;
    const closed=new Promise(resolve=>this.child.once('close',resolve));
    this.close();
    if(this.stopError)throw Error("worker_tree_stop_failed");
    await closed;
  }
}

if(accelerated&&!existsSync(compiler)) throw Error('找不到独立加速环境的 TinyCC '+compiler);
const stability=mode==='stability'||mode==='stability-cold';
const benchmark=mode==='bench'||mode==='bench-long'||stability;
const deadline=benchmark?START+benchSeconds*1000:expressionRun?START+expressionWallSeconds*1000:Infinity;
const stabilityRounds=Number(process.env.QM_QWEN_STABILITY_ROUNDS??2);
if(stability&&![1,2,3].includes(stabilityRounds))throw Error('连续验证轮数须为 1、2 或 3');
let worker=new ModelWorker(deadline);
let canceled=false;
const interrupt=()=>{canceled=true;worker.close();};
process.once('SIGINT',interrupt);
process.once('SIGTERM',interrupt);
let failed=false;
let phase='startup';
const summaries=[];
const factual={};
const requests={generated:0,actionFormatAttempts:0,actionFormatAccepted:0,engineAttempts:0,engineAccepted:0,answerFormatAttempts:0,answerFormatAccepted:0};
const requestModel=async(messages,op='generate',seconds,requestId=randomUUID())=>{
  const started=performance.now();
  const instance=worker;
  const workerPid=instance.workerPid,launcherPid=instance.child.pid;
  const residence=op==='generate'?(instance.generations++===0?'first_generation':'resident'):undefined;
  if(canceled||seconds<=0)return {ok:false,error:canceled?'canceled':'wall_budget',requestId,workerPid,launcherPid,residence};
  try {
    const model=await instance.request(messages,op,seconds,requestId);
    if(op==='generate'&&model.ok)requests.generated++;
    return {...model,requestId,workerPid,launcherPid,residence};
  } catch(error){return {ok:false,error:error.message,type:'WorkerRequestError',requestId,workerPid,launcherPid,residence,seconds:(performance.now()-started)/1000};}
};
const corrected=(input,raw,error)=>[...input.messages,
  {role:'assistant',content:raw},
  {role:'user',content:'上次原样输出 '+JSON.stringify(raw)+' 未通过。具体错误 '+error+'。请重答同一局面。'+input.output}];
try {
  console.log('加载本地 BF16 CUDA 模型');
  const loaded=await worker.read(stability?110:undefined);
  write('model-load.json',loaded);
  if(!loaded.ok)throw Error(loaded.error);
  phase='running';
  console.log('进程就绪 '+loaded.coldWorkerSeconds.toFixed(2)+'秒（模型加载 '+loaded.modelLoadSeconds.toFixed(2)+'秒） · '+loaded.device);

  const recoverInference=inferenceRecovery({
    request:(messages,seconds)=>requestModel(messages,'generate',seconds),
    restart:async until=>{await worker.stop();return ensureWorker(until);},
    log:entry=>{record('recovery.jsonl',entry);console.log('推理恢复 · '+entry.stage+' · '+entry.gameId+' · '+entry.revision);},
  });
  const infer=(room,side,observation,messages,seconds,gameDeadline)=>
    gameDeadline===undefined?requestModel(messages,'generate',seconds):
      recoverInference({observe:seat=>room.observe(seat),side,observation,messages,seconds,deadline:gameDeadline});

  async function askFact(room,side,o,id,fact,seconds,gameDeadline) {
    const input=makeInput(o,room.reference,fact.question);
    let messages=input.messages;
    for(let attempt=0;attempt<2;attempt++){
      const model=await infer(room,side,o,messages,seconds,gameDeadline);
      const row={id,attempt,revision:o.revision,kind:fact.question.kind,messages,model,expected:fact.expected};
      if(!model.ok){record('answers.jsonl',{...row,classification:model.stale?'stale_observation':'model_error'});return model.stale?{stop:'stale_observation'}:{stop:'model_error',error:model.error,fatal:true};}
      let answer;
      requests.answerFormatAttempts++;
      try {answer=parseAnswer(model.text);}
      catch(error){
        record('answers.jsonl',{...row,classification:'output_format',error:error.message});
        messages=corrected(input,model.text,error.message);
        continue;
      }
      requests.answerFormatAccepted++;
      const now=await room.observe(side);
      if(now.epoch!==o.epoch||now.revision!==o.revision)throw Error('诊断问答期间局面已改变');
      const correct=answer===fact.expected, stat=factual[fact.question.kind]??={correct:0,incorrect:0};
      stat[correct?'correct':'incorrect']++;
      record('answers.jsonl',{...row,classification:'parsed',answer,correct});
      return {ok:true,kind:fact.question.kind,correct};
    }
    return {stop:'answer_format_after_retry'};
  }

  async function decide(room,side,o,id,step,previous,{first,seconds,gameDeadline}={}) {
    const before=performance.now(),input=makeInput(o,room.reference,undefined,previous);
    if(!input.offers.length)return {stop:'no_authorized_offer'};
    let messages=input.messages, correction;
    let prepMs=performance.now()-before;
    for(let attempt=0;attempt<2;attempt++){
      const generated=attempt===0&&first?first:await infer(room,side,o,messages,seconds,gameDeadline);
      const afterInference=performance.now();
      const row={id,step,attempt,observation:o,messages,legalOffers:input.offers,model:generated};
      if(!generated.ok){
        record('decisions.jsonl',{...row,classification:generated.stale?'stale_observation':generated.type==='OutOfMemoryError'?'oom':'model_error'});
        return generated.stale?{stop:'stale_observation'}:{stop:'model_error',error:generated.error,fatal:true};
      }
      let parsed;
      requests.actionFormatAttempts++;
      try {
        if(generated.hitOutputLimit)throw Error('输出达到token上限');
        parsed=parseAction(generated.text,input.offers,o,randomUUID());
        requests.actionFormatAccepted++;
      } catch(error) {
        correction=error.message;
        record('decisions.jsonl',{...row,classification:'output_contract',error:correction,environmentMs:prepMs+performance.now()-afterInference});
        messages=corrected(input,generated.text,correction);
        continue;
      }
      const latest=await room.observe(side);
      if(latest.epoch!==o.epoch || latest.revision!==o.revision) {
        record('decisions.jsonl',{...row,parsed:parsed.request,classification:'stale_observation'});
        return {stop:'stale_observation'};
      }
      let definitive=false,accepted=false;
      try {
        requests.engineAttempts++;
        const result=await room.submit(side,parsed.request);
        definitive=true;
        accepted=result.result.ok;
        if(!accepted)throw Error(result.result.error);
        requests.engineAccepted++;
        const after=await room.observe(side);
        const effect=shortResult(after);
        record('decisions.jsonl',{...row,parsed:parsed.request,result:result.result,classification:'engine_accepted',
          observedResult:effect,environmentMs:prepMs+performance.now()-afterInference});
        return {ok:true,classification:'engine_accepted',offer:parsed.offer.label,observedResult:effect,
          previous:{action:parsed.offer.label,result:result.result,phase:after.phase,publicTail:after.public.log?.slice(-3)}};
      } catch(error) {
        if(accepted){
          record('decisions.jsonl',{...row,parsed:parsed.request,classification:'accepted_observation_error',error:error.message});
          return {stop:'accepted_observation_error',error:error.message,fatal:true};
        }
        if(/STALE|WRONG_GAME|局面已更新/i.test(error.message)) {
          record('decisions.jsonl',{...row,parsed:parsed.request,classification:'stale_observation',error:error.message});
          return {stop:'stale_observation'};
        }
        if(!definitive){
          record('decisions.jsonl',{...row,parsed:parsed.request,classification:'submission_unknown',error:error.message});
          return {stop:'submission_unknown',error:error.message,fatal:true};
        }
        const after=await room.observe(side);
        correction=error.message;
        record('decisions.jsonl',{...row,parsed:parsed.request,classification:'engine_rejected',error:correction,
          environmentMs:prepMs+performance.now()-afterInference});
        if(after.epoch!==o.epoch||after.revision!==o.revision)return {stop:'rejected_after_state_change',error:correction};
        messages=corrected(input,generated.text,correction);
      }
      prepMs=performance.now()-afterInference;
    }
    return {stop:'invalid_after_retry',error:correction};
  }

  async function ensureWorker(until=deadline){
    if(canceled)throw Error('canceled');
    if(!worker.stopping&&worker.child.exitCode===null&&worker.child.signalCode===null)return;
    await worker.stop();
    const remaining=(until-performance.now())/1000;
    if(remaining<=0)throw Error('wall_budget');
    worker=new ModelWorker(deadline);
    const restarted=await worker.read(Math.min(75,remaining));
    record('model-restarts.jsonl',{...restarted,launcherPid:worker.child.pid});
    if(!restarted.ok)throw Error(restarted.error);
    return {pid:restarted.pid,launcherPid:worker.child.pid,coldWorkerSeconds:restarted.coldWorkerSeconds};
  }

  if(expressionRun){
    const results=await runExpression({cases:pairedCases,engine,corrected,saveReplay,record,write,
      infer:(room,side,o,messages)=>infer(room,side,o,messages,expressionRequestSeconds,deadline),
      progress:(index,c,version)=>console.log('输入表达 A/B · '+index+'/'+pairedCases.length+' · '+c.id+' · '+version),
      shouldStop:()=>canceled||performance.now()>=deadline||worker.stopping||worker.child.exitCode!==null||worker.child.signalCode!==null,
    });
    for(const r of results){
      requests.actionFormatAttempts+=r.actionAttempts.filter(a=>a.model.ok).length;
      requests.actionFormatAccepted+=r.actionAttempts.filter(a=>a.legal).length;
      requests.answerFormatAttempts+=r.questionAttempts.filter(a=>a.model.ok).length;
      requests.answerFormatAccepted+=r.questionAttempts.filter(a=>a.classification==='parsed').length;
      requests.engineAttempts+=r.actionAttempts.filter(a=>a.engineAttempted).length;
      requests.engineAccepted+=Number(r.engine?.ok===true);
    }
    summaries.push(...results.map(({questionAttempts,actionAttempts,...r})=>r));
    failed=results.length!==pairedCases.length*2||results.some(r=>r.error||r.closeError||!r.engine?.ok||!r.replay?.entries||
      [...r.questionAttempts,...r.actionAttempts].some(a=>a.classification==='runtime_failure'));
  } else if(stability) {
    const labels=mode==='stability-cold'?['long-prelude']:['standard-play','response-chain','long-prelude','standard-play'];
    const prompts=new Map();
    for(const label of new Set(labels)){
      const id=sampleCases.find(([key])=>key===label)[1], f=fixed.find(v=>v.id===id);
      const room=await createDiagnosticRoom({state:f.state,seed:f.seed,gameId:id});
      try{
        const side=sideOf(f.seat), o=await room.observe(side), input=makeInput(o,room.reference);
        const length=await requestModel(input.messages,'length',8);
        if(!length.ok)throw Error(length.error);
        const promptSha256=sha(JSON.stringify(input.messages));
        prompts.set(label,{f,input,promptSha256,inputTokens:length.inputTokens});
        savePrompt(label,input.messages);
      }finally{await room.close();}
    }
    const rounds=mode==='stability-cold'?1:stabilityRounds;
    for(let round=1;round<=rounds;round++) {
      for(const [index,label] of labels.entries()){
        const {f,input,promptSha256,inputTokens}=prompts.get(label);
        const requestId='stability-'+round+'-'+(index+1);
        console.log('连续验证 '+round+'/'+rounds+' · '+label+' · '+inputTokens+' tokens');
        const model=await requestModel(input.messages,'generate',45,requestId);
        console.log('连续验证 '+requestId+' · '+(model.ok?model.seconds.toFixed(2)+'秒':model.error));
        const row={requestId,round,index,label,promptSha256,inputTokens,model,workerPid:model.pid??worker.workerPid,launcherPid:worker.child.pid,
          firstRequest:round===1&&index===0,restarted:false};
        if(model.ok){
          const room=await createDiagnosticRoom({state:f.state,seed:f.seed,gameId:f.id});
          try{
            const side=sideOf(f.seat),o=await room.observe(side), current=makeInput(o,room.reference);
            assert.equal(sha(JSON.stringify(current.messages)),promptSha256);
            let parsed;
            requests.actionFormatAttempts++;
            try{
              if(model.hitOutputLimit)throw Error('输出达到 token 上限');
              parsed=parseAction(model.text,current.offers,o,randomUUID());
              requests.actionFormatAccepted++;
              row.protocol={ok:true};
            }catch(error){row.protocol={ok:false,error:error.message};}
            if(parsed){
              requests.engineAttempts++;
              row.engine=await room.submit(side,parsed.request).then(x=>x.result);
              if(row.engine.ok)requests.engineAccepted++;
              row.replay=await saveReplay(room,requestId);
            }
          }catch(error){row.engine={ok:false,error:error.message};}
          finally{await room.close();}
        }
        record('stability.jsonl',row);
        summaries.push(row);
        if(!model.ok){failed=true;break;}
      }
      if(failed)break;
    }
    const checks={generation:summaries.every(r=>r.model.ok),protocol:summaries.every(r=>r.protocol?.ok===true),
      engine:summaries.every(r=>r.engine?.ok===true),replay:summaries.every(r=>Number.isInteger(r.replay?.entries)&&r.replay.entries>0&&!r.replay.error)};
    write('stability-checks.json',checks);
    failed||=Object.values(checks).some(ok=>!ok);
  } else if(benchmark) {
    // Attempt each input length before spending budget on corrective retries.
    const profiles=mode==='bench-long'?[['cold-long','long-prelude',110]]:[
      ['first-short','standard-play',55],['warm-short','standard-play',25],
      ['warm-medium','response-chain',65],['parameter','parameter-selection',45],
      ['warm-long','long-prelude',75],
    ];
    const attempts=new Map();
    const measurements=new Map();
    for(const [label,id] of sampleCases){
      const f=fixed.find(v=>v.id===id),room=await createDiagnosticRoom({state:f.state,seed:f.seed,gameId:id});
      try {
        const started=performance.now(),o=await room.observe(sideOf(f.seat)),input=makeInput(o,room.reference);
        const environmentPrepareMs=performance.now()-started;
        savePrompt(label,input.messages);
        const len=await requestModel(input.messages,'length',12);
        measurements.set(label,{id,messages:input.messages,len,environmentPrepareMs});
      } finally {await room.close();}
    }
    write('input-lengths.json',[...measurements].map(([label,m])=>({label,id:m.id,inputTokens:m.len.inputTokens,error:m.len.error})));
    if(compareKernels&&mode!=='bench-long'){
      const messages=[{role:'system',content:'你在玩战场军需官。按正式规则行动，只输出JSON。'},
        {role:'user',content:'德国在出牌阶段。东欧有一支德国陆军，有补给。编号1发起陆战，编号2建设陆军。选一项，格式示例 {"offer":2}。'}];
      savePrompt('numeric-comparison',messages);
      try {
        await ensureWorker();
        const numeric=await requestModel(messages,'compare',65);
        write('equivalence.json',numeric);
        summaries.push({profile:'equivalence',...numeric,ok:!!numeric.ok&&numeric.numericPass&&numeric.greedyEqual});
      } catch(error){summaries.push({profile:'equivalence',ok:false,error:error.message});}
    }
    for(const [profile,label,seconds] of profiles){
      const {id,messages,len,environmentPrepareMs}=measurements.get(label);
      if(profile==='warm-short'&&!attempts.get(label)?.model.ok){
        summaries.push({profile,fixture:id,inputTokens:len.inputTokens,ok:false,error:'first_short_not_completed'});
        continue;
      }
      try {
        await ensureWorker();
        console.log('性能 '+profile+' · '+len.inputTokens+' tokens');
        const model=len.ok?await requestModel(messages,'generate',seconds):len;
        const row={profile,id,inputTokens:len.inputTokens,environmentPrepareMs,model};
        record('performance.jsonl',row);
        summaries.push({profile,fixture:id,...model,inputTokens:len.inputTokens});
        if(label!=='long-prelude'&&profile!=='warm-short')attempts.set(label,{id,model,messages});
      } catch(error){
        summaries.push({profile,fixture:id,inputTokens:len.inputTokens,ok:false,error:error.message});
        console.error(profile+' '+error.message);
      }
    }
    for(const [label,{id,model,messages}] of attempts){
      const f=fixed.find(v=>v.id===id),room=await createDiagnosticRoom({state:f.state,seed:f.seed,gameId:id});
      try {
        await ensureWorker();
        const side=sideOf(f.seat),o=await room.observe(side);
        assert.deepEqual(makeInput(o,room.reference).messages,messages);
        let answer;
        if(label==='standard-play'&&f.fact){
          savePrompt('independent-question',makeInput(o,room.reference,f.fact.question).messages);
          answer=await askFact(room,side,o,id,f.fact,35);
        }
        const action=model.ok?await decide(room,side,o,id,0,undefined,{first:model,seconds:35}):{stop:'initial_generation_failed'};
        const {previous:_previous,...result}=action;
        const replay=await saveReplay(room,label);
        write(label+'-result.json',{fixture:id,answer,action:result,replay});
        summaries.push({profile:label+'-execution',ok:!!action.ok&&!replay.error,answer,action:result,replay});
      } catch(error){summaries.push({profile:label+'-execution',ok:false,error:error.message});}
      finally {await room.close();}
    }
    if(mode==='bench-long'){
      // Inject the previous malformed shape, then let the real model make the
      // single corrective attempt at the same unmodified response window.
      const id='mulberry-sea_mediterranean',f=fixed.find(v=>v.id===id);
      const room=await createDiagnosticRoom({state:f.state,seed:f.seed,gameId:id});
      try{
        await ensureWorker();
        const side=sideOf(f.seat),o=await room.observe(side);
        const initial={ok:true,text:'{"offer":0,"select":{"fields":[]}}',injectedOutput:true};
        const action=await decide(room,side,o,id,0,undefined,{first:initial,seconds:35});
        const replay=await saveReplay(room,'correction-probe');
        const {previous:_previous,...result}=action;
        summaries.push({profile:'correction-probe',ok:!!action.ok&&!replay.error,action:result,replay});
      }catch(error){summaries.push({profile:'correction-probe',ok:false,error:error.message});}
      finally{await room.close();}
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
      const gameDeadline=begun+configuration.limits.gameWallSeconds*1000;
      console.log('开始 '+(index+1)+'/'+total+' '+id);
      try {
        while(true){
          const views=await Promise.all([room.observe(0),room.observe(1)]);
          if(views[0].status==='finished'){result={stop:'natural_finish',winner:views[0].public.winner,reason:views[0].public.victoryReason};break;}
          const unsupported=views.find(o=>o.status==='unsupported');
          if(unsupported){result={stop:'unsupported',reason:unsupported.unsupportedReason};break;}
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
          const answer=f?.fact?await askFact(room,side,o,id,f.fact,undefined,gameDeadline):undefined;
          if(answer&&!answer.ok){
            if(answer.stop==='stale_observation'&&++stale<=2)continue;
            result=answer;break;
          }
          result=await decide(room,side,o,id,steps,previous[side],{gameDeadline});
          if(answer)result.answer=answer;
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
  record('errors.jsonl',{phase,error:error.message,seconds:elapsed()});
  console.error(error.message);
} finally {
  worker.child.stdin.end();
  write('summary.json',{mode,failed,seconds:elapsed(),factual,requests,summaries});
  console.log('结果目录 '+out);
}
if(failed)process.exitCode=1;
