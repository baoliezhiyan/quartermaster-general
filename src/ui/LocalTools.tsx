import { useState, useSyncExternalStore } from 'react';
import type { GameController } from '../controller/GameController';
import type { GameState, ReadState, SeatId, CountryId } from '../core';
import { SEATS } from '../core';
import { COUNTRY_NAMES, UNIT_NAMES, cardName, shuffle } from '../core/basic';
import { REGIONS } from '../core/map';
import {sceneCards,scenePile,moveSceneCard} from '../core/sceneCards';
import { ZONES } from '../controller/saveFormat';
import { RESPONSE_PRESETS, responsePreset } from '../controller/responsePresets';

const ZONE_NAMES={hand:'手牌',drawPile:'牌库中',discardPile:'弃牌',active:'持续生效',faceDown:'暗置',resolving:'结算中',removed:'移出游戏'};
export async function saveReplay(name:string,text:string|Promise<string>) {
  download(name,await text);
}

function download(name:string,text:string) {
  const url=URL.createObjectURL(new Blob([text],{type:'application/json'})),link=document.createElement('a');
  link.href=url;link.download=name;link.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
}
export function UndoButton({controller,busy,setBusy}:{controller:GameController;busy:boolean;setBusy:(v:boolean)=>void}) {
  const info=useSyncExternalStore(controller.subscribe,controller.getSessionInfo);
  const [error,setError]=useState('');
  const undo=async()=>{
    if(busy||!info.canUndo)return;
    setBusy(true);setError('');
    try{await controller.undo();}catch(e){setError(String(e));}finally{setBusy(false);}
  };
  return <><button className="secondary" disabled={busy||!info.canUndo} onClick={()=>void undo()}>回退一步</button>{error&&<span role="alert">{error}</span>}</>;
}
export function LocalTools({controller,state,busy,setBusy}:{controller:GameController;state:ReadState|null;busy:boolean;setBusy:(v:boolean)=>void}) {
  const info=useSyncExternalStore(controller.subscribe,controller.getSessionInfo);
  const [message,setMessage]=useState(''),[note,setNote]=useState('');
  const run=async(action:()=>Promise<void>,success:string)=>{
    if(busy)return;setBusy(true);setMessage('');
    try{await action();setMessage(success);}catch(error){setMessage(String(error));}finally{setBusy(false);}
  };
  return <section className="local-tools" aria-label="存档与本地工具">


    <details><summary>存档、读档与备份</summary>{message&&<p role="status">{message}</p>}{info.storageError&&<p role="alert">{info.storageError}</p>}
      <p>大存档：第 1 轮起，每轮德国行动前保存。小存档：每国保留最近一次行动前状态，新一轮轮到该国时替换。读档后从该起点重新行动；回退不跨越本国本次行动起点。</p>
      <h4>大存档 · 每轮开始</h4><div className="save-list">{info.rounds.map(c=><button key={c.id} disabled={busy} onClick={()=>run(()=>controller.loadCheckpoint(c.id),`已读取${c.stage==='prelude'?'序章':'正式'}第 ${c.round} 轮开始。`)}>读取{c.stage==='prelude'?'序章':'正式'}第 {c.round} 轮 · 德国行动前</button>)}{!info.rounds.length&&<span>序章或正式游戏的德国回合开始时生成大存档。</span>}</div>
      <h4>小存档 · 六国最近行动开始</h4><div className="save-list">{SEATS.map(seat=>{const c=info.nations.find(c=>c.seat===seat);return <button key={seat} disabled={busy||!c} onClick={()=>c&&run(()=>controller.loadCheckpoint(c.id),`已读取${COUNTRY_NAMES[seat]}${c.stage==='prelude'?'序章':'正式'}第 ${c.round} 轮行动开始。`)}>{COUNTRY_NAMES[seat]} · {c?`读取${c.stage==='prelude'?'序章':'正式'}第 ${c.round} 轮`:'尚未开始'}</button>;})}</div>
      <div className="turn-actions"><button disabled={!state||busy||info.replayMode} onClick={()=>run(async()=>download(`军需官-第${state?.round}轮存档.json`,await controller.exportSave()),'')}>导出完整 JSON 存档</button><label>导入 JSON 存档 <input aria-label="导入 JSON 存档" type="file" accept=".json,application/json" disabled={busy} onChange={e=>{const file=e.target.files?.[0];e.target.value='';if(file)void run(async()=>{if(file.size>64*1024*1024)throw new Error('文件超过 64 MB。');await controller.importSave(await file.text());},'已导入存档。');}} /></label></div>
    </details>
    <details><summary>结算与响应查看</summary>{message&&<p role="status">{message}</p>}<p>六国视角条同时切换查看者与操作者；结算中必须由指定国家回答。新对局允许其他国家响应，切到被询问的国家后选择发动或不响应；等待没有时间限制。</p>
      {state&&<><div className="turn-actions">{SEATS.map(seat=><button key={seat} disabled={busy||state.viewSeat===seat} onClick={()=>run(async()=>{const r=await controller.dispatch({type:'SET_VIEW',seat,expectedRevision:state.revision});if(!r.ok)throw new Error(r.error);},`已切换至${COUNTRY_NAMES[seat]}。`)}>{COUNTRY_NAMES[seat]}</button>)}</div><p>当前结算：{state.resolution?.scenario??'无'}；需要选择：{state.resolution?.choice?COUNTRY_NAMES[state.resolution.choice.seat]:'无'}。</p><ol>{state.resolution?.frames.map(f=><li key={f.id}>{f.source} · {{RUNNING:'处理中',WAITING_CHOICE:'等待选择',WAITING_RESPONSE:'等待响应',COMPLETE:'完成'}[f.status]} · {f.nextEffectIndex}/{f.effects.length}</li>)}</ol></>}
    </details>
    <details><summary>场景编辑器</summary>{controller.setSceneLocked&&<p><button disabled={busy} aria-pressed={!!info.room?.sceneLocked} onClick={()=>run(()=>controller.setSceneLocked!(!info.room?.sceneLocked),info.room?.sceneLocked?'场景已解锁。':'场景已锁定，其他玩家暂时不能操作。')}>{info.room?.sceneLocked?'解锁场景':'锁定场景'}</button> 锁定后可安心修改；GM离席或断线时自动解锁。</p>}<fieldset disabled={info.replayMode}>{message&&<p role="status">{message}</p>}
      <details><summary>测试场景</summary><p>载入一个独立测试对局，载入后替换当前对局，需保留原局请先手动导出。重新载入恢复固定起点；切换六国视角作答，无计时限制。</p>
      {RESPONSE_PRESETS.map(p=><div className="turn-actions" key={p.id}><button disabled={busy} onClick={()=>run(()=>controller.importSave(JSON.stringify(responsePreset(p.id,`response-test:${p.id}:${crypto.randomUUID()}`))),`已载入：${p.name}。`)}>载入：{p.name}</button><span>{p.hint}</span></div>)}
      </details>{state&&<label><input type="checkbox" checked={!state.settings.ignoreOtherPlayerInterrupts} disabled={busy||!!state.resolution?.running} onChange={e=>{const enabled=e.target.checked;void run(async()=>{const r=await controller.dispatch({type:'SET_INTERRUPTS',seat:state.viewSeat,expectedRevision:state.revision,enabled});if(!r.ok)throw new Error(r.error);},enabled?'已允许其他国家响应。':'已忽略其他国家可选响应。');}}/>允许其他国家响应</label>}
      <p>调整分数、兵模和卡牌位置后立即保存，可回退恢复。</p>{state&&<SceneEditor key={state.gameId} state={state} busy={busy} apply={(draft,options)=>run(()=>controller.editScene(draft,options),'')} />}</fieldset></details>
    <details><summary>回放查看</summary>{message&&<p role="status">{message}</p>}<button disabled={!state||busy} onClick={()=>run(()=>saveReplay(`军需官-${state?.gameId}-对局记录.qmreplay.jsonl`,controller.exportReplay()),'')}>导出对局记录</button><button disabled={busy} onClick={()=>document.getElementById('replay-file-input')?.click()}>导入回放</button><input id="replay-file-input" aria-label="导入回放文件" hidden type="file" accept=".jsonl,.qmreplay.jsonl" disabled={busy} onChange={e=>{const file=e.target.files?.[0];e.target.value='';if(file)void run(async()=>{window.dispatchEvent(new CustomEvent('qm-open-replay',{detail:await file.text()}));},'');}} /></details>
    <details><summary>错误诊断</summary>{message&&<p role="status">{message}</p>}<p>校验从最近载入或回退后的基准局面，按已接受命令确定性重放；不会改变当前对局，也不提供向前恢复操作。联机诊断包还包含近期网络及服务器耗时；卡顿后请保持各页面连接约 30 秒，再导出排查。</p><button disabled={busy||!state} onClick={()=>run(async()=>{const ok=await controller.checkReplay();if(!ok)throw new Error('回放校验失败，请导出诊断包。');},'确定性回放校验通过。')}>校验当前回放</button><label>问题与预期结果<textarea value={note} onChange={e=>setNote(e.target.value)} /></label><button disabled={!state||busy} onClick={()=>run(async()=>download('军需官-诊断包.json',await controller.exportDiagnostics(note)),'')}>导出错误诊断包</button></details>
  </section>;
}

function SceneEditor({state,busy,apply}:{state:ReadState;busy:boolean;apply:(s:GameState,options?:{endPrelude?:boolean;endNeutrality?:'soviet_union'|'united_states'})=>Promise<void>}) {
  const draft=state;
  const setDraft=(update:(s:GameState)=>GameState)=>{const next=update(JSON.parse(JSON.stringify(state)));next.pendingAir=next.pendingAir.filter(id=>next.units.some(u=>u.id===id&&u.type==='air'));void apply(next);};
  const [owner,setOwner]=useState<SeatId>(state.viewSeat),[cardId,setCardId]=useState('');
  const [prelude,setPrelude]=useState(false);
  const [zone,setZone]=useState<(typeof ZONES)[number]|'drawTop'|'drawBottom'>('hand');
  const [country,setCountry]=useState<CountryId>(state.activeSeat),[type,setType]=useState<'army'|'navy'|'air'>('army'),[region,setRegion]=useState('');
  const [removeCountry,setRemoveCountry]=useState<CountryId>(state.activeSeat),[removeType,setRemoveType]=useState<'army'|'navy'|'air'>('army'),[removeId,setRemoveId]=useState('');
  const removable=draft.units.filter(u=>u.country===removeCountry&&u.type===removeType);
  const selectedRemove=removable.some(u=>u.id===removeId)?removeId:removable[0]?.id??'';
  const locked=busy||state.status==='FINISHED';
  const cards=sceneCards(draft,owner,prelude);
  const drawPile=prelude?draft.prelude?.decks[owner].drawPile??[]:draft.decks[owner].drawPile;
  return <fieldset disabled={locked}><legend>编辑当前局面</legend><div className="scene-scores">{SEATS.map(seat=><label key={seat}>{COUNTRY_NAMES[seat]}分数 <input type="number" key={state.revision} defaultValue={draft.scores[seat]} onBlur={e=>{if(e.target.value.trim()&&Number.isFinite(Number(e.target.value))&&Number(e.target.value)!==draft.scores[seat])setDraft(s=>({...s,scores:{...s.scores,[seat]:Number(e.target.value)}}));}} /></label>)}</div>
    {draft.prelude?.active&&<><h4>序章</h4><div className="turn-actions"><label>紧张度 <input aria-label="编辑序章紧张度" type="number" step="1" key={state.revision} defaultValue={draft.prelude.tension} onBlur={e=>{const v=Number(e.target.value);if(e.target.value.trim()&&Number.isSafeInteger(v)&&v!==draft.prelude?.tension)setDraft(s=>{s.prelude!.tension=v;return s;});}} /></label><button disabled={!!state.resolution?.running} onClick={()=>void apply(JSON.parse(JSON.stringify(state)),{endPrelude:true})}>立即结束序章</button><span>{state.resolution?.running?'请先完成当前结算，再结束序章。':'结束后进入起手保留，已暗置军备和持续生效卡保留。'}</span></div></>}
    <h4>中立规则</h4><div className="turn-actions">{(['united_states','soviet_union'] as const).map(seat=><button key={seat} disabled={!!state.prelude?.active||state.status!=='PLAYING'||state.phase==='SETUP'||!!state.resolution?.running||!state.neutrality?.[seat]?.neutral} onClick={()=>void apply(JSON.parse(JSON.stringify(state)),{endNeutrality:seat})}>直接结束{COUNTRY_NAMES[seat]}中立</button>)}<span>仅正式游戏可用；执行正常参战效果与通知。</span></div>
    <h4>兵模</h4>
    <div className="turn-actions"><select aria-label="移除兵模国家" value={removeCountry} onChange={e=>setRemoveCountry(e.target.value as CountryId)}>{Object.entries(COUNTRY_NAMES).map(([id,name])=><option key={id} value={id}>{name}</option>)}</select><select aria-label="移除兵种" value={removeType} onChange={e=>setRemoveType(e.target.value as typeof removeType)}>{Object.entries(UNIT_NAMES).map(([id,name])=><option key={id} value={id}>{name}</option>)}</select><select aria-label="移除兵模地区" value={selectedRemove} onChange={e=>setRemoveId(e.target.value)}>{!removable.length&&<option value="">无</option>}{removable.map(u=><option key={u.id} value={u.id}>{REGIONS.find(r=>r.id===u.regionId)?.name??u.regionId}</option>)}</select><button disabled={!selectedRemove} onClick={()=>setDraft(s=>({...s,units:s.units.filter(u=>u.id!==selectedRemove)}))}>移除兵模</button></div>
    <div className="turn-actions"><select aria-label="新增兵模国家" value={country} onChange={e=>setCountry(e.target.value as CountryId)}>{Object.entries(COUNTRY_NAMES).map(([id,name])=><option key={id} value={id}>{name}</option>)}</select><select aria-label="新增兵种" value={type} onChange={e=>{setType(e.target.value as typeof type);setRegion('');}}>{Object.entries(UNIT_NAMES).map(([id,name])=><option key={id} value={id}>{name}</option>)}</select><select aria-label="新增兵模地区" value={region} onChange={e=>setRegion(e.target.value)}><option value="">选择地区</option>{REGIONS.filter(r=>type==='air'||r.type===(type==='army'?'LAND':'SEA')).map(r=><option key={r.id} value={r.id}>{r.name}</option>)}</select><button disabled={!region} onClick={()=>setDraft(s=>({...s,units:[...s.units,{id:`scene:${crypto.randomUUID()}`,country,type,regionId:region}]}))}>添加兵模</button></div>
    <h4>移动卡牌</h4><div className="turn-actions"><select aria-label="编辑卡牌组" value={prelude?"prelude":"regular"} onChange={e=>{setPrelude(e.target.value==="prelude");setCardId('');}}><option value="regular">正式卡牌</option>{draft.prelude&&<option value="prelude">序章卡牌</option>}</select><select aria-label="编辑牌库国家" value={owner} onChange={e=>{setOwner(e.target.value as SeatId);setCardId('');}}>{SEATS.map(s=><option key={s} value={s}>{COUNTRY_NAMES[s]}</option>)}</select><select aria-label="编辑卡牌" value={cardId} onChange={e=>setCardId(e.target.value)}><option value="">选择卡牌</option>{cards.map((c,i)=><option key={c.id} value={c.id}>{i+1}. {cardName(c)} · {c.zone==='drawPile'?(c.position===0?'牌库顶':c.position===c.length-1?'牌库底':'牌库中'):ZONE_NAMES[c.zone]}</option>)}</select><select aria-label="卡牌移至" value={zone} onChange={e=>setZone(e.target.value as typeof zone)}>{ZONES.filter(z=>z!=='resolving').map(z=><option key={z} value={z}>{ZONE_NAMES[z]}</option>)}<option value="drawTop">牌库顶</option><option value="drawBottom">牌库底</option></select><button disabled={!cards.some(c=>c.id===cardId)} onClick={()=>setDraft(s=>{moveSceneCard(s,owner,prelude,cardId,zone as Exclude<typeof zone,'resolving'>);return s;})}>移动到所选区域</button><button disabled={!drawPile.length} onClick={()=>setDraft(s=>{const card=scenePile(s,owner,prelude,'drawPile').shift();if(card)scenePile(s,owner,prelude,'hand').push(card);return s;})}>抽一张牌</button><button disabled={drawPile.length<2} onClick={()=>setDraft(s=>{shuffle(scenePile(s,owner,prelude,'drawPile'),s);return s;})}>重洗牌库</button></div>

  </fieldset>;
}
