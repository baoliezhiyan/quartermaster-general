import {it,expect} from 'vitest';
// @ts-expect-error Node-only sample generation.
import {mkdir,writeFile} from 'node:fs/promises';
import {LocalGameController} from '../src/controller/LocalGameController';

import {parseReplay} from '../src/actionReplay/codec';

import {SEATS} from '../src/core';
it('generates exchange samples from actual client commands with the new action protocol',async()=>{
 const c=new LocalGameController();await c.dispatch({type:'CREATE_GAME',gameId:'client-standard-sample',seed:1940,mode:'FULL',neutrality:true,balance:true});
 for(const seat of SEATS){const s=c.getSnapshot()!;expect(await c.dispatch({type:'KEEP_OPENING',seat,expectedRevision:s.revision,cardIds:s.decks[seat].hand.slice(0,7).map(c=>c.id)})).toMatchObject({ok:true});}
 const standard=await c.exportReplay();await parseReplay(standard);await mkdir('outputs/match-log-samples',{recursive:true});await writeFile('outputs/match-log-samples/client-standard.jsonl',standard);

},60000);
