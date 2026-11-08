import {it,expect} from 'vitest';
import {renderToStaticMarkup} from 'react-dom/server';
import {createGame} from '../src/core/game';
import {startResolution,resolveChoice} from '../src/core/resolution';
import {specialCard} from '../src/core/cardCatalog';
import {guidedChoices} from '../src/ui/guidedChoices';
import {GuidedPrompt} from '../src/ui/GuidedPrompt';
import {triggerTimingLabel} from '../src/controller/triggerTimingLabel';
import {projectState} from '../src/network/project';
import type {GameState,SeatId} from '../src/core/types';
function game(seat:SeatId){const s=createGame('labels',1940,'FULL',true,false,true);s.prelude!.active=false;s.phase='PLAY';s.status='PLAYING';s.round=2;s.activeSeat=s.viewSeat=s.operatorSeat=seat;for(const d of Object.values(s.decks)){d.drawPile.push(...d.hand,...d.active,...d.faceDown);d.hand=[];d.active=[];d.faceDown=[];}return s;}
function add(s:GameState,id:string,zone:'active'|'faceDown'|'discardPile'){const def=specialCard(id,true)!,d=s.decks[def.deckOwner],n=d.drawPile.findIndex(c=>c.definitionId===id),c=n>=0?d.drawPile.splice(n,1)[0]:{id:'test:'+id,definitionId:id,deckOwner:def.deckOwner,country:def.country,balance:true};d[zone].push(c);return c.id;}
function choose(s:GameState,label:string){const q=s.resolution!.choice!,o=q.options.find(o=>o.id===label||o.label===label)!;expect(o).toBeTruthy();expect(resolveChoice(s,q.seat,q.id,[o.id])).toBe(true);}
function actions(s:GameState,region:string){for(let i=0;i<15&&s.resolution?.choice?.kind==='ACTION';i++){const q=s.resolution.choice;choose(s,q.options.some(o=>o.id===region)?region:q.options[0].id);}}
function labels(s:GameState,focus:string){const before=JSON.stringify(s),view=projectState(s,{kind:'player',seat:s.viewSeat},s.viewSeat)!;const html=renderToStaticMarkup(<GuidedPrompt state={view} selected={[]} toggle={()=>{}} focusCard={focus} playCardId={null} playTargets={[]} setPlayTargets={()=>{}} busy={false} dispatch={async()=>{}} cancelPlay={()=>{}}/>);expect(JSON.stringify(s)).toBe(before);return html.match(/<div class="guided-options">([\s\S]*?)<\/div>/)![1];}
it('Artificial Harbor timing buttons identify each naval construction without repeating the card name',()=>{
 const s=game('united_states');add(s,'special_84','active');const card=add(s,'special_80','active');s.units=[{id:'u',type:'army',country:'united_states',regionId:'united_states'},{id:'h',type:'army',country:'united_states',regionId:'hawaii'}];
 startResolution(s,'建设海军','united_states',[{kind:'action',country:'united_states',action:'build_navy',regions:['sea_east_pacific'],label:'建设海军'}],[]);actions(s,'sea_east_pacific');choose(s,'先进造船厂');actions(s,'sea_north_pacific');
 expect(guidedChoices(s).cards[card]).toHaveLength(2);const html=labels(s,card);expect(html).toContain('>东太平洋建海</button>');expect(html).toContain('>北太平洋建海</button>');expect(html).not.toContain('人工港');
 const opts=s.resolution!.choice!.options;const event=s.resolution!.events.find(e=>e.id===s.resolution!.windows.find(w=>w.id===opts[1].windowId)!.originEventId)!;if(event.effect?.kind==='action')event.effect.option!.regionId='sea_east_pacific';expect(labels(s,card).match(/>东太平洋建海<\/button>/g)).toHaveLength(2);
});
it.each(['prelude_DE-12','prelude_DE-09'])('battle source labels work for %s and retain distinct trigger IDs',id=>{
 const s=game('germany');add(s,'special_134','active');const card=add(s,id,'faceDown');if(id==='prelude_DE-09')add(s,'special_136','discardPile');s.decks.germany.hand.push(...s.decks.germany.drawPile.splice(0,8));s.units=[{id:'g',country:'germany',type:'army',regionId:'germany'},{id:'e',country:'germany',type:'army',regionId:'eastern_europe'},{id:'u',country:'soviet_union',type:'army',regionId:'ukraine'},{id:'b',country:'soviet_union',type:'army',regionId:'balkans'}];
 startResolution(s,'陆攻','germany',[{kind:'action',country:'germany',action:'land_battle',regions:['balkans'],label:'根攻击'}],[]);actions(s,'balkans');choose(s,'俯冲式轰炸机');actions(s,'ukraine');
 const options=guidedChoices(s).cards[card];expect(new Set(options).size).toBe(2);const html=labels(s,card);expect(html).toContain('>巴尔干陆战</button>');expect(html).toContain('>乌克兰陆战</button>');expect(html).not.toContain(specialCard(id,true)!.name);
 const o=s.resolution!.choice!.options[0],event=s.resolution!.events.find(e=>e.id===s.resolution!.windows.find(w=>w.id===o.windowId)!.originEventId)!;
 event.effect={kind:'signal',tag:'PHASE:SCORE',label:'原始名称'};expect(triggerTimingLabel(s,o)).toBe('计分阶段');event.effect={kind:'deckTop',seat:'germany',count:2,label:'原始名称'};expect(triggerTimingLabel(s,o)).toBe('德国弃牌库顶');
});
