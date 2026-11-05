import assert from 'node:assert/strict';
import test from 'node:test';
import { copiedExample, displayObservation, reportExpression, runExpression } from './expression-ab.mjs';

test('permutation preserves formal selection constraints and does not mutate the observation',()=>{
  const original={offers:[{id:'first',selections:{ids:{ids:['x','y'],min:1,max:1,requirements:['build_navy']}}},{id:'second'}]};
  const result=displayObservation(original,true);
  assert.deepEqual(result.offers.map(o=>o.id),['second','first']);
  assert.deepEqual(result.offers[1].selections.ids,{ids:['y','x'],min:1,max:1,requirements:['build_navy']});
  assert.deepEqual(original.offers[0].selections.ids.ids,['x','y']);
  assert.equal(copiedExample('{"select":{"ids":[1]},"offer":2}',{offer:2,select:{ids:[1]}}),true);
  assert.equal(copiedExample('{"offer":1}',{offer:2}),false);
});

test('a failed A receives one correction and still leaves an independent B question and action',async()=>{
  const state={gameId:'fixture',epoch:'test',revision:1,decisions:[],offers:[{id:'offer',command:{type:'PLAY_CARD'}}]};
  const c={id:'test',cohort:'new',seat:'germany',state,fact:{question:{text:'test',kind:'fact_read'},expected:'否'}};
  const calls=[],saved=[],submissions=[];
  const responses=['{"answer":"是"}','invalid','still invalid','{"answer":"否"}','{"offer":0}','{"offer":0}'];
  const rows=await runExpression({
    cases:[c],
    engine:{
      createDiagnosticRoom:async()=>({observe:async()=>state,close:async()=>{},submit:async(_,request)=>{
        submissions.push(request);return {result:submissions.length===1?{ok:false,error:'test engine rejection'}:{ok:true}};
      }}),
      sideOf:()=>0,
      makeInput:(_,__,q,___,version)=>({offers:state.offers,example:q?undefined:{offer:0},messages:[
        {content:'same rules'},{content:version+(q?'\n独立诊断问题：test':'\n选择一项合法游戏操作。')}]}),
      parseAnswer:text=>JSON.parse(text).answer,
      parseAction:text=>{JSON.parse(text);return {request:{offerId:'offer',selections:{}},offer:state.offers[0]};},
    },
    infer:async(_,__,___,messages)=>{calls.push(messages);return {ok:true,text:responses.shift(),inputTokens:10,seconds:1};},
    corrected:(input,raw)=>[...input.messages,{content:raw}],
    saveReplay:async(_,id)=>{saved.push(id);return {entries:1};},
    record:()=>{},write:()=>{},progress:()=>{},shouldStop:()=>false,
  });
  assert.deepEqual(rows.map(r=>[r.version,r.correct,r.actionAttempts.length,r.engine?.ok]),[['A',false,2,undefined],['B',true,2,true]]);
  assert.equal(calls[2].length,3);
  assert.equal(calls[4].length,2);
  assert.equal(calls[5].length,3);
  assert.equal(submissions.length,2);
  assert.equal(rows[1].actionAttempts[0].classification,'engine_rejected');
  assert.deepEqual(saved,['test-B']);
  const report=reportExpression(rows);
  assert.equal(report.versions.A.overall.outputFailures,2);
  assert.equal(report.versions.B.overall.exampleCopied,2);
  assert.equal(report.versions.B.overall.replayPassed,1);
});
