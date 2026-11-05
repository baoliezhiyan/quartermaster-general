import { Room, LocalAiAdapter } from '../../src/network/Room';
import { openReplay } from '../../src/actionReplay/openReplay';
import { ENGINE, VERSION } from '../../src/actionReplay/state';
import identity from '../../src/matchLog/build-identity.json';
import { makeInput, parseAction, parseAnswer, PROMPT_VERSION, PROTOCOL_VERSION } from './input';
import type { Observation } from './input';
import type { GameState, SeatId } from '../../src/core';
import type { Identity } from '../../src/network/protocol';

export { fixtures } from './cases';
export { makeInput, parseAction, parseAnswer, PROMPT_VERSION, PROTOCOL_VERSION };
export const engineIdentity = {...identity, gameVersion:VERSION, rulesFingerprint:ENGINE};
const axis = ['germany','japan','italy'] satisfies SeatId[];
const allies = ['united_kingdom','soviet_union','united_states'] satisfies SeatId[];
export const sideOf = (seat:SeatId) => (axis as SeatId[]).includes(seat) ? 0 : 1;

type Setup = {seed:number; state?:GameState; gameId:string};
export async function createDiagnosticRoom({seed,state,gameId}:Setup) {
  // Fresh in-process authority. It never accesses a live server, disk save store, or existing identity.
  const players:Identity[] = [axis,allies].map((bindings,i)=>({
    id:'diagnostic-'+i,name:i===0?'诊断轴心':'诊断同盟',token:crypto.randomUUID(),bindings,
  }));
  const room = new Room({read:async()=>null,write:async()=>{},list:async()=>[]},
    players,async()=>{},async()=>null);
  const gm = await room.createIdentity('诊断场景管理');
  const connection = crypto.randomUUID();
  await room.connect(gm.token,connection,()=>{});
  const sync = () => room.request(gm.token,{
    id:crypto.randomUUID(),connection,epoch:'',revision:null,method:'sync',args:[],
  }) as Promise<import('../../src/network/protocol').RoomSnapshot>;
  const control = async (method:string,...args:unknown[]) => {
    const current=await sync();
    return room.request(gm.token,{id:crypto.randomUUID(),connection,epoch:current.room.epoch,
      revision:current.state?.revision??null,method,args});
  };
  await control('seat',{kind:'gm'});
  if(state) {
    await control('importSave',JSON.stringify({
      format:'quartermaster-save',version:1,updatedAt:new Date().toISOString(),
      state,replayBase:state,commands:[],undo:[],rounds:[],nations:[],
    }));
  } else {
    const created=await control('dispatch',{type:'CREATE_GAME',gameId,seed,mode:'FULL',prelude:true,neutrality:true,balance:true});
    if (!(created as {ok:boolean}).ok) throw Error('CREATE_GAME rejected');
  }
  const adapter = new LocalAiAdapter(room);
  for(const p of players) await adapter.connect(p.token);
  const first = await adapter.observe(players[0].token);
  const {data:reference} = await adapter.reference(players[0].token,first.reference.id);

  return {
    reference,
    async observe(side:number):Promise<Observation> {
      const o=await adapter.observe(players[side].token);
      if(!('public' in o)) throw Error('对局未初始化');
      return o;
    },
    wait(side:number) {
      return adapter.waitDecision(players[side].token,{waitId:'diagnostic',leaseMs:100});
    },
    submit(side:number, request:Parameters<typeof adapter.submit>[1]) {
      return adapter.submit(players[side].token,request);
    },
    submitAction(side:number, request:Parameters<typeof adapter.submitAction>[1]) {
      return adapter.submitAction(players[side].token,request);
    },
    async exportReplay() {
      const text=await control('exportReplay');
      if(typeof text!=='string') throw Error('缺少正式回放');
      return text;
    },
    async close() {
      for(const p of players) await adapter.disconnect(p.token);
      await room.disconnect(gm.token,connection);
    },
  };
}

export async function checkClientReplay(text:string) {
  // Same loader/controller called by the v1.8.4 client “导入回放” entry.
  const player=await openReplay(text);
  await player.checkReplay();
  return {gameVersion:VERSION, rulesFingerprint:ENGINE, entries:player.entries.length};
}
