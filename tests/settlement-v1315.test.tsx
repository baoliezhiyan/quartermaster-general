import {it,expect,vi,afterEach} from 'vitest';
import {renderToStaticMarkup as render} from 'react-dom/server';
import {createGame,transition} from '../src/core/game';
import type {GameState,SeatId} from '../src/core';
import {specialCard} from '../src/core/cardCatalog';
import {startResolution,resolveChoice} from '../src/core/resolution';
import {countryScore} from '../src/core/supply';
import {discardDeckTop} from '../src/core/decks';
import {projectState} from '../src/network/project';
import {PublicGameLog} from '../src/ui/PublicGameLog';
import {GuidedPrompt} from '../src/ui/GuidedPrompt';
import {guidedChoices} from '../src/ui/guidedChoices';
import {fullCardEffects} from '../src/core/fullCardEffects';
import {preludeTriggers} from '../src/core/preludeTriggers';
import {TableHand} from '../src/ui/TableHand';
import {saveReplay} from '../src/ui/LocalTools';
function game(seat:SeatId='germany'){
 const s=createGame('v1315',1940,'FULL',true);s.prelude!.active=false;s.phase='PLAY';s.status='PLAYING';s.round=2;s.activeSeat=s.viewSeat=s.operatorSeat=seat;s.settings.ignoreOtherPlayerInterrupts=false;
 for(const d of Object.values(s.decks)){d.drawPile.push(...d.hand,...d.active,...d.faceDown);d.hand=[];d.active=[];d.faceDown=[];}
 return s;
}
function add(s:GameState,id:string,zone:'active'|'hand'|'faceDown'|'discardPile'){
 const d=specialCard(id)!;const c={id:'fixture-'+id,definitionId:id,country:d.country,deckOwner:d.deckOwner};s.decks[d.deckOwner][zone].push(c);return c;
}
function choose(s:GameState,label?:string){const c=s.resolution!.choice!;const option=label?c.options.find(o=>o.label===label||o.id===label):undefined;if(label)expect(option,JSON.stringify(c)).toBeDefined();expect(resolveChoice(s,c.seat,c.id,option?[option.id]:[])).toBe(true);}
function actions(s:GameState,region:string){for(let n=0;n<10&&s.resolution?.choice?.kind==='ACTION';n++){const c=s.resolution.choice;choose(s,c.options.find(o=>o.id===region)?.id??c.options[0].id);}}
it('Enigma can remove completed Blitz speed before its battle triggers Dive Bombers',()=>{
 const s=game();add(s,'special_137','active');add(s,'special_134','active');add(s,'special_17','faceDown');
 s.units=[{id:'g',country:'germany',type:'army',regionId:'germany'},{id:'e',country:'germany',type:'army',regionId:'eastern_europe'},{id:'u',country:'soviet_union',type:'army',regionId:'ukraine'},{id:'b',country:'soviet_union',type:'army',regionId:'balkans'}];
 startResolution(s,'建设陆军','germany',[{kind:'action',country:'germany',action:'build_army',regions:['western_europe'],label:'建设'}],[]);actions(s,'western_europe');
 choose(s,'兵贵神速');actions(s,'balkans');
 expect(s.resolution!.choice!.seat).toBe('united_kingdom');choose(s,'破译恩尼格玛密码');
 expect(s.resolution!.frames.find(f=>f.cardId==='fixture-special_137')!.finalZone).toBe('discardPile');
 expect(s.resolution!.choice!.options.some(o=>o.label==='俯冲式轰炸机')).toBe(true);
 choose(s,'俯冲式轰炸机');actions(s,'ukraine');for(let i=0;i<10&&s.resolution?.choice;i++)choose(s);
 expect(s.decks.germany.discardPile.some(c=>c.definitionId==='special_137')).toBe(true);
 expect(s.decks.germany.active.some(c=>c.definitionId==='special_134')).toBe(true);
});
it('Kamikaze resolves before Shipyards; the successful construction window survives destruction',()=>{
 const s=game('united_states');add(s,'special_89','active');add(s,'special_84','active');add(s,'special_196','faceDown');
 s.units=[{id:'us',country:'united_states',type:'army',regionId:'hawaii'},{id:'n',country:'united_states',type:'navy',regionId:'sea_north_pacific'},{id:'j',country:'japan',type:'army',regionId:'iwo_jima'},{id:'jn',country:'japan',type:'navy',regionId:'sea_central_pacific'}];
 startResolution(s,'海战','united_states',[{kind:'action',country:'united_states',action:'sea_battle',regions:['sea_central_pacific'],label:'海战'}],[]);actions(s,'sea_central_pacific');choose(s,'航空母舰');actions(s,'sea_central_pacific');
 expect(s.resolution!.choice!.seat).toBe('japan');choose(s,'神风敢死队');expect(s.units.some(u=>u.country==='united_states'&&u.regionId==='sea_central_pacific')).toBe(false);
 choose(s,'先进造船厂');actions(s,'sea_central_pacific');expect(s.units.some(u=>u.country==='united_states'&&u.regionId==='sea_central_pacific')).toBe(true);
});
it('Scorched Earth removes Axis scoring only',()=>{const s=game();add(s,'special_48','active');s.units=[{id:'u',country:'germany',type:'army',regionId:'ukraine'}];expect(countryScore(s,'germany')).toBe(0);s.units[0].country='soviet_union';expect(countryScore(s,'soviet_union')).toBe(2);});
it('nested brackets produce one complete card index link',()=>{const d=specialCard('special_109')!;expect(d.name).toContain('现购');const html=render(<PublicGameLog entries={[{seat:d.deckOwner,round:1,text:`美国打出事件【${d.name}】。`}]}/>);expect(html.match(/class="card-index-link"/g)).toHaveLength(1);expect(html).toContain(`【${d.name}】</button>`);});
it('discard details go only to the affected deck owner, including network projections',()=>{const s=game();const ids=s.decks.soviet_union.drawPile.slice(0,2).map(c=>c.id);discardDeckTop(s,'soviet_union',2,'germany');const su=projectState(s,{kind:'player',seat:'soviet_union'},'soviet_union')!,de=projectState(s,{kind:'player',seat:'germany'},'germany')!;expect(su.responseNotices![0].cards.map(c=>c.id)).toEqual(ids);expect(de.responseNotices).toEqual([]);expect(de.decks.soviet_union.discardPile).toEqual([]);});
it('pure mandatory scoring statuses resolve without an order prompt',()=>{const s=game('italy');s.phase='SCORE';add(s,'special_212','active');add(s,'special_217','active');s.units=[{id:'a',country:'italy',type:'army',regionId:'western_europe'},{id:'b',country:'italy',type:'army',regionId:'balkans'}];startResolution(s,'计分','italy',[{kind:'signal',tag:'PHASE:SCORE',label:'计分开始'}],[]);expect(s.resolution!.choice).toBeNull();expect(s.scores.italy).toBe(2);});
it('We Shall Never Surrender uses SCORE, not DRAW',()=>{const s=game('united_kingdom');add(s,'prelude_UK-05','faceDown');s.units.push({id:'invader',country:'germany',type:'army',regionId:'british_isles'});const f={id:'f',currentEventId:'e'} as any;expect(preludeTriggers(s,f,{kind:'signal',tag:'PHASE:SCORE',label:'score'},'After')).toHaveLength(1);expect(preludeTriggers(s,f,{kind:'signal',tag:'PHASE:DRAW',label:'draw'},'After')).toHaveLength(0);expect(specialCard('prelude_UK-05')!.text).toContain('计分阶段');});
it('discarding automatically replenishes the hand and enters the next country',()=>{const s=game();s.phase='DISCARD';s.settings.ignoreOtherPlayerInterrupts=true;const result=transition(s,{type:'DISCARD_HAND',seat:'germany',expectedRevision:s.revision,cardIds:[]});expect(result.ok).toBe(true);if(result.ok){expect(result.state.decks.germany.hand).toHaveLength(7);expect(result.state.activeSeat).toBe('united_kingdom');expect(result.state.phase).toBe('DISCARD');}});
const props=(s:GameState)=>({state:s,selected:[],toggle:()=>{},focusCard:null,playCardId:null,playTargets:[],setPlayTargets:()=>{},busy:false,dispatch:async()=>{},cancelPlay:()=>{}});
it('filtered production search opens a standalone candidate window in multiplayer',()=>{const s=game();const card=add(s,'special_151','hand');startResolution(s,'生产构思','germany',fullCardEffects(s,card,[])!,[]);const view=projectState(s,{kind:'player',seat:'germany'},'germany')!;expect(guidedChoices(view).ordered).toBe(true);expect(guidedChoices(view).panels.size).toBe(0);expect(render(<GuidedPrompt {...props(view)}/>)).toContain('候选卡牌选择');});
it('a revealed card has direct play/return buttons without needing selection',()=>{const s=game('italy');const card=add(s,'special_212','discardPile');startResolution(s,'翻牌','italy',[{kind:'extraPlay',seat:'italy',from:'discardPile',onlyCardIds:[card.id],allowSkip:true,returnOnSkip:true,label:'打出或放回'}],[]);const view=projectState(s,{kind:'player',seat:'italy'},'italy')!;const html=render(<GuidedPrompt {...props(view)}/>);expect(html).toContain('确认打出');expect(html).toContain('放回牌库顶');expect(html).not.toContain('disabled');choose(s);expect(s.decks.italy.drawPile[0].id).toBe(card.id);});
it('no air movement prompt appears when there is no possible move',()=>{const s=game();s.phase='AIR';s.units=[];const html=render(<TableHand state={s} busy={false} dispatch={async()=>{}} choiceCards={{}} chosenCards={[]} onChoiceCard={()=>{}} onPlayCard={()=>{}} playCardId={null} onMapAction={()=>{}} revealHand={()=>{}}/>);expect(html).not.toContain('是否进行空军调度');});
afterEach(()=>{vi.unstubAllGlobals();vi.useRealTimers();});
it('replay download waits for complete contents and never requests file-write permissions',async()=>{vi.useFakeTimers();const click=vi.fn(),link={href:'',download:'',click};vi.stubGlobal('document',{createElement:()=>link});const picker=vi.fn();vi.stubGlobal('window',{showSaveFilePicker:picker});let finish!:(s:string)=>void;const pending=new Promise<string>(resolve=>finish=resolve);const saved=saveReplay('replay.json',pending);expect(click).not.toHaveBeenCalled();finish('{"complete":true}');await saved;expect(click).toHaveBeenCalledTimes(1);expect(picker).not.toHaveBeenCalled();expect(await (await fetch(link.href)).text()).toBe('{"complete":true}');vi.runAllTimers();});
