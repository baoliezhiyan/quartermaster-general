/** Conservative event subscriptions, independent of legality and player choices.
 * Every candidate still runs its authoritative handler against the current state.
 * Unknown future IDs fail open; equivalence tests guard the known card catalog.
 */
import type {Effect} from './resolutionTypes';
type Timing='Before'|'After';
const index=new Map<string,Set<string>>();
const add=(ids:(number|string)[],timing:Timing,...events:string[])=>{for(const id of ids){const key=typeof id==='number'?`special_${id}`:`prelude_${id}`;const set=index.get(key)??new Set<string>();for(const event of events)set.add(`${timing}:${event}`);index.set(key,set);}};
const phase=(ids:(number|string)[],...names:string[])=>add(ids,'After',...names.map(n=>'PHASE:'+n));
const act=(ids:(number|string)[],timing:Timing,...actions:string[])=>add(ids,timing,...actions.map(a=>'action:'+a));
add([15,37,39],'Before','CARD_EFFECT');
add([87,121,128,133,144,149,220,226,230],'Before','deckTop');
add([55],'Before','remove');
phase([259],'SCORE');
phase([247],'SUPPLY');
phase([256,'SU-06'],'TURN_START_WINDOW');
add([11,14,16,18,54,56,60,58,195,200,222],'Before','remove');
act([53,86,126,127,138,207,219,254],'Before','land_battle','sea_battle');
act([2,8],'Before','build_army');
phase([226],'EARLY_TURN_START');
phase([3,36,38,75,79,117,120,131,139,147,171,172,173,174,175,176,177,204,206,212,213,214,216,217,224,225,229,251],'SCORE');
phase([59,129,194,248,249,251],'TURN_START_WINDOW');
phase([40,76,123,132,142,143,145,148,186,187,188,189,190,202,228,246],'PLAY');
phase([41,77,116,125],'AIR');
phase([72,74,85,87,122,145,209],'DISCARD');
add([13],'After','STANDARD_CARD_PLAYED');
add([17],'After','CARD_EFFECT_DONE');
add([45,179],'After','CARD_PLAYED');
add([55,191,227],'After','*');
add([73,140,221,223],'After','remove');
act([4,89,192,198],'After','sea_battle');
act([19,43,51,88,134,136,178,185,197,199,201],'After','land_battle');
act([71,118],'After','land_battle','sea_battle');
act([12,44,45,50,57,83,130,137,218],'After','build_army');
act([90],'After','build_army','recruit_army','land_battle');
act([250],'After','build_army','recruit_army');
act([78,80,84,124,141,183,184,193,196,208],'After','build_navy');
act([70,119,146,205],'After','air_deploy','air_move','air_power');
add([203],'After','action:*');
// Prelude armaments and treaties.
phase(['DE-02','DE-08','DE-11','UK-03','UK-05','UK-06','JP-01','JP-02','JP-03','JP-06','JP-09','SU-04','IT-02','IT-03','IT-04','IT-05','IT-06','IT-07','IT-12','US-02','US-16'],'SCORE');
phase(['DE-03','DE-04','DE-06','DE-10','UK-10','US-01','US-05'],'TURN_START_WINDOW');
phase(['UK-10'],'SUPPLY');
phase(['IT-15'],'TURN_START_WINDOW');
add(['UK-07','US-04','SU-06'],'After','PHASE:*','ARMAMENT_ANYTIME');
add(['DE-09'],'Before','*');add(['DE-09'],'After','*');
add(['UK-04'],'Before','ARMAMENT');
act(['DE-01','DE-07','JP-04','JP-14','SU-08','SU-10','UK-17'],'Before','land_battle','sea_battle');
act(['SU-06','SU-15'],'Before','land_battle');
act(['DE-05','DE-12','SU-01','SU-07'],'After','land_battle');
act(['JP-05'],'After','sea_battle');act(['JP-08'],'After','build_navy');
act(['SU-16'],'After','land_battle','sea_battle');add(['SU-18'],'After','action:*');
add(['SU-03'],'After','remove');
act(['UK-01'],'After','build_navy','recruit_navy');
act(['UK-02','JP-07'],'After','build_army','recruit_army');
act(['UK-08','IT-01'],'After','build_navy');act(['UK-09','US-03'],'After','build_army');
// Explicitly audited non-trigger cards. Do not derive this from the live catalog:
// a newly added card without an index entry must still reach its handler.
const noTriggers=new Set([
 "neutrality_united_states_status","prelude_DE-13","prelude_DE-14","prelude_DE-15","prelude_DE-16","prelude_DE-17","prelude_DE-18","prelude_DE-19",
 "prelude_DE-20","prelude_IT-08","prelude_IT-09","prelude_IT-10","prelude_IT-11","prelude_IT-13","prelude_IT-14","prelude_IT-15",
 "prelude_IT-16","prelude_JP-10","prelude_JP-11","prelude_JP-12","prelude_JP-13","prelude_JP-15","prelude_JP-16","prelude_JP-17",
 "prelude_JP-18","prelude_JP-19","prelude_SU-02","prelude_SU-05","prelude_SU-09","prelude_SU-11","prelude_SU-12","prelude_SU-13",
 "prelude_SU-14","prelude_SU-17","prelude_UK-11","prelude_UK-12","prelude_UK-13","prelude_UK-14","prelude_UK-15","prelude_UK-16",
 "prelude_UK-18","prelude_UK-19","prelude_UK-20","prelude_US-06","prelude_US-07","prelude_US-08","prelude_US-09","prelude_US-10",
 "prelude_US-11","prelude_US-12","prelude_US-13","prelude_US-14","prelude_US-15","special_1","special_10","special_100",
 "special_101","special_102","special_103","special_104","special_105","special_106","special_107","special_108",
 "special_109","special_110","special_111","special_112","special_113","special_114","special_115","special_135",
 "special_150","special_151","special_152","special_153","special_154","special_155","special_156","special_157",
 "special_158","special_159","special_160","special_161","special_162","special_163","special_164","special_165",
 "special_166","special_167","special_168","special_169","special_170","special_180","special_181","special_182",
 "special_20","special_21","special_210","special_211","special_215","special_22","special_23","special_231",
 "special_232","special_233","special_234","special_235","special_236","special_237","special_238","special_239",
 "special_24","special_240","special_241","special_242","special_243","special_244","special_245","special_247",
 "special_25","special_252","special_253","special_255","special_26","special_27","special_28","special_29",
 "special_30","special_31","special_32","special_33","special_34","special_35","special_42","special_46",
 "special_47","special_48","special_49","special_5","special_52","special_6","special_61","special_62",
 "special_63","special_64","special_65","special_66","special_67","special_68","special_69","special_7",
 "special_81","special_82","special_9","special_91","special_92","special_93","special_94","special_95",
 "special_96","special_97","special_98","special_99",
]);
let seen=0,accepted=0;
export function resetTriggerScanStats(){seen=accepted=0;}
export function triggerScanStats(){return {seen,accepted,skipped:seen-accepted};}
export function triggerCandidate(id:string,e:Effect,timing:Timing):boolean{
 seen++;
 const subscriptions=index.get(id);
 const tag=e.kind==='signal'?(e.tag==='PHASE:SCORE_STATUS'?'PHASE:SCORE':e.tag):e.kind==='action'?`action:${e.action}`:e.kind;
 const eligible=subscriptions?.has(`${timing}:*`)||subscriptions?.has(`${timing}:${tag}`)||e.kind==='action'&&subscriptions?.has(`${timing}:action:*`)||e.kind==='signal'&&tag.startsWith('PHASE:')&&subscriptions?.has(`${timing}:PHASE:*`)
  ||!subscriptions&&!noTriggers.has(id);
 if(eligible)accepted++;return !!eligible;
}

/** Descriptive subscriptions for frozen replay catalogues, never used to execute replay. */
export const triggerSubscriptions=(id:string)=>[...(index.get(id)??[])];
