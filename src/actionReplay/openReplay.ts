import {parseReplay} from './codec';
import {ReplayController} from './ReplayController';
import type {ReplayView} from './ReplayController';
import {parseTrainingReplay} from './trainingCodec';
import {TrainingController} from './TrainingController';
import {parseRealHandTrainingReplay,RealHandTrainingController} from './realHandTrainingReplay';
export async function openReplay(text:string):Promise<ReplayView>{
 const header=JSON.parse(text.slice(0,text.indexOf('\n')));
 if(header.mode==='resource_pool'){const view=new TrainingController(await parseTrainingReplay(text));await view.checkReplay();return view;}
 if(header.mode==='real_hand'){const view=new RealHandTrainingController(await parseRealHandTrainingReplay(text));await view.checkReplay();return view;}
 return new ReplayController(await parseReplay(text));
}
