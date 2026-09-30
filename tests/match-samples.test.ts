import {it,expect} from 'vitest';
// @ts-expect-error Node-only sample generation.
import {mkdir,writeFile} from 'node:fs/promises';
import {LocalGameController} from '../src/controller/LocalGameController';
import {constructedPool} from './match-fixtures';
import {parseMatchLog,sealMatchLog} from '../src/matchLog/codec';
import {GAME_VERSION} from '../src/matchLog/normalize';
import {SEATS} from '../src/core';
it('generates exchange samples from actual client commands and labelled constructed A/B facts',async()=>{
 const c=new LocalGameController();await c.dispatch({type:'CREATE_GAME',gameId:'client-standard-sample',seed:1940,mode:'FULL',neutrality:true,balance:true});
 for(const seat of SEATS){const s=c.getSnapshot()!;expect(await c.dispatch({type:'KEEP_OPENING',seat,expectedRevision:s.revision,cardIds:s.decks[seat].hand.slice(0,7).map(c=>c.id)})).toMatchObject({ok:true});}
 const standard=await c.exportReplay();await parseMatchLog(standard,GAME_VERSION);await mkdir('outputs/match-log-samples',{recursive:true});await writeFile('outputs/match-log-samples/client-standard.jsonl',standard);
 for(const mode of ['A','B'] as const){const text=await sealMatchLog(constructedPool(mode),'snapshot_segment');await parseMatchLog(text,GAME_VERSION);await writeFile(`outputs/match-log-samples/constructed-resource-${mode}.jsonl`,text);}
},60000);
