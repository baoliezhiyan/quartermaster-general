import {parseReplay} from './codec';
import {ReplayController} from './ReplayController';
import type {ReplayView} from './ReplayController';
import {parseTrainingReplay} from './trainingCodec';
import {TrainingController} from './TrainingController';
export async function openReplay(text:string):Promise<ReplayView>{
 const header=JSON.parse(text.slice(0,text.indexOf('\n')));
 if(header.mode==='resource_pool'){const view=new TrainingController(await parseTrainingReplay(text));await view.checkReplay();return view;}
 return new ReplayController(await parseReplay(text));
}
