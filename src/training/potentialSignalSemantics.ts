/** Training-only, audited static descriptions of installed status/response capability.
 * Trigger subscriptions still come from the production trigger index. These rows
 * describe what happens AFTER the trigger; they never execute game effects.
 * Unknown is distinct from no cost / no target and must remain visible to the actor.
 */
import {triggerSubscriptions} from '../core/triggerIndex';
import {TRAINING_SIGNAL_IDS_BY_SEAT} from '../core/trainingCourse';

type Row=readonly [effects:string,target:string,fee:string,limit?:string,
  unit?:string,alliance?:string,branch?:string,conditionalExtraFee?:number];
const rows:Record<number,Row>={
  // Germany
  139:['score','fixed:ukraine,kazakhstan,ross_region','none'],
  137:['land_battle','adjacent_built_army','deck:1','turn','army'],
  136:['build_army','battle_region','deck:1','turn','army'],
  135:['build_army','any_legal','deck:2','none','army','owner','replace_play'],
  134:['land_battle','battle_or_adjacent','deck:1','turn','army'],
  131:['score,score','fixed:sea_baltic,scandinavia','none','none','army,navy','owner','conditional'],
  130:['build_army','adjacent_built_army','deck:2','turn','army'],
  129:['recruit_army','fixed:germany','deck:1','turn','army'],
  163:['sea_battle','fixed:sea_baltic','deck:2','none','navy','owner','replace_play',1],
  // United States
  80:['build_army','adjacent_built_navy','deck:1','turn','army'],
  78:['land_battle','adjacent_built_navy','deck:1','none','army'],
  79:['score','fixed:eastern_europe,south_africa,latin_america,western_china','none'],
  89:['build_navy','battle_region','deck:1','turn','navy'],
  88:['build_army','battle_region','deck:1','turn','army'],
  86:['prevent_remove','fixed:sea_central_pacific','deck:2','turn','navy'],
  84:['build_navy','any_legal','deck:1','turn','navy'],
  83:['build_army','any_legal','deck:1','turn','army'],
  // Japan
  201:['land_battle','battle_or_adjacent','none','none','army'],
  200:['prevent_remove','same_unit','none','none','navy'],
  199:['build_army,land_battle','battle_then_fixed_or_adjacent:eastern_china','none','none','army','owner','sequence'],
  198:['build_army,build_army','adjacent_battle_region','none','none','army','owner','range_1_2'],
  197:['sea_battle,recruit_army','fixed:sea_south_china,southeast_asia','none','none','army,navy','owner','sequence'],
  196:['destroy','new_enemy_navy','none','none','navy','enemy'],
  195:['prevent_remove','fixed:eastern_china,western_china,vladivostok,mongolia','none','none','army'],
  194:['recruit_navy','fixed_or_adjacent:sea_north_pacific','none','none','navy'],
  193:['build_army,build_army','adjacent_built_navy','none','none','army','owner','range_1_2'],
  192:['sea_battle,land_battle','any_legal_except:united_states','none','none','army,navy','owner','sequence'],
  177:['score','fixed:hawaii,canada,new_zealand','none','none','army'],
  176:['score','fixed:indonesia,new_guinea,southeast_asia','none','none','army'],
  175:['score','fixed:iwo_jima,philippines','none','none','army'],
  174:['score','fixed:hawaii','none','none','army','enemy'],
  190:['destroy','any_chinese_army','none','none','army','enemy'],
  189:['recruit_army','fixed:eastern_china','none','none','army'],
  188:['recruit_army','fixed:southeast_asia','none','none','army'],
  183:['land_battle,land_battle','adjacent_built_navy','none','none','army','owner','range_1_2'],
  184:['sea_battle,sea_battle','adjacent_built_navy','none','none','navy','owner','range_1_2'],
  187:['land_battle','fixed_or_adjacent:eastern_china','none','none','army'],
  185:['build_army','fixed:india','none','none','army'],
  186:['sea_battle','any_legal','none','none','navy'],
  171:['score','global_navy_count','none','none','navy'],
  172:['score,score','fixed:vladivostok,siberia','none','none','army','owner','conditional'],
  173:['score','fixed:sea_central_pacific','none','none','navy'],
  178:['build_army,land_battle','fixed_then_adjacent:vladivostok','none','none','army','owner','sequence'],
  249:['destroy','fixed:hawaii','none','none','army','enemy'],
  // Soviet Union
  58:['recruit_army,recruit_army','fixed:siberia,kazakhstan','none','none','army'],
  55:['prevent_remove','fixed:siberia,kazakhstan','none','none','army'],
  44:['land_battle','adjacent_built_army','hand:2:build_army,land_battle','none','army'],
  52:['recruit_army','fixed:western_china,eastern_china,mongolia','none','none','army','owner','replace_play'],
  42:['home_base,supply','fixed:siberia,moscow','none'],
  50:['build_army','any_legal','hand:1:build_army','turn','army'],
  59:['recruit_army,destroy','fixed_or_adjacent:moscow','none','none','army','enemy','sequence'],
  60:['prevent_remove','fixed:ross_region','none','none','army'],
  56:['prevent_remove','fixed:moscow','none','none','army'],
  54:['prevent_remove','fixed:ukraine','none','none','army'],
  57:['destroy','fixed_or_adjacent:moscow','none','none','army','enemy'],
  43:['land_battle','battle_or_adjacent','hand:2:any','turn','army'],
  46:['recycle_play','discard_build_army','hand:2:any','none','army','owner','replace_play'],
  48:['supply','fixed:ukraine','none'],
  47:['supply','all_own_army','none','none','army'],
  51:['land_battle','battle_region','hand:1:any','turn','army'],
  45:['return_card','played_build_army','none','none','army'],
  // Italy
  223:['recruit_army','removed_unit_region','none','none','army','ally'],
  222:['prevent_remove','fixed:italy','none','none','army','ally'],
  221:['recruit_army','removed_unit_region','none','none','army','ally'],
  216:['score','fixed:ross_region,ukraine','none','none','army'],
  217:['score','fixed:balkans','none','none','army'],
  215:['land_battle','any_legal','deck:2','none','army','owner','replace_play'],
  214:['score','fixed:north_africa,south_africa,middle_east','none','none','army','ally'],
  213:['score','global_navy_count','none','none','navy'],
  219:['prevent_remove','fixed_or_adjacent:italy','none','none','army'],
  218:['destroy','adjacent_allied_army','none','none','army','enemy'],
  212:['score','fixed:western_europe','none','none','army'],
  // United Kingdom
  17:['discard_status','triggered_german_status','none','none','unknown','enemy'],
  11:['prevent_remove','same_unit','none','none','army'],
  16:['prevent_remove','same_unit','none','none','navy','ally'],
  12:['destroy','fixed:india,australia,canada','none','none','army','enemy'],
  14:['prevent_remove','fixed_or_adjacent:british_isles','none','none','any'],
  2:['recruit_army','fixed:australia','none','none','army','owner','replacement'],
  8:['recruit_army','fixed:india','none','none','army','owner','replacement'],
  3:['score,score','fixed:sea_north_atlantic,canada','none','none','army,navy','owner','conditional'],
  1:['land_battle','fixed:western_europe,italy','hand:2:any','none','army','owner','replace_play'],
  4:['sea_battle','battle_or_adjacent','hand:2:any','turn','navy'],
  18:['prevent_remove','same_unit','none','none','army'],
  19:['recruit_army','fixed:north_africa,south_africa,middle_east,western_europe','none','none','army','ally'],
  5:['home_base','fixed:western_europe,british_isles','none'],
  9:['supply','all_french_units','none'],
  10:['supply,recruit_army','fixed:south_africa','none','none','army','owner','replace_play'],
  7:['supply,recruit_army','fixed:eastern_europe','none','none','army','owner','replace_play'],
};

const actionNames=new Set(['build_army','build_navy','recruit_army','recruit_navy',
  'land_battle','sea_battle','destroy','score','prevent_remove','home_base',
  'supply','recycle_play','return_card','discard_status']);
const targetNames=new Set(['adjacent_built_army','adjacent_built_navy','battle_region',
  'battle_or_adjacent','adjacent_battle_region','any_legal','same_unit',
  'new_enemy_navy','any_chinese_army','global_navy_count','removed_unit_region',
  'adjacent_allied_army','discard_build_army','all_own_army','all_french_units',
  'played_build_army','triggered_german_status']);
const split=(value:string)=>value?value.split(','):[];

export const potentialSignalCoverage=()=>{
  const ids=Object.values(TRAINING_SIGNAL_IDS_BY_SEAT).flat();
  const missing=ids.filter(id=>id!=='special_227'&&!rows[Number(id.slice(8))]);
  const extra=Object.keys(rows).map(n=>`special_${n}`).filter(id=>!ids.includes(id));
  return {total:ids.length,described:Object.keys(rows).length,missing,extra,
    eventOnly:['special_227']};
};

export const potentialSignalSemantics=(id:string)=>{
  const row=rows[Number(id.slice(8))];
  if(!row)return undefined;
  const [rawEffects,rawTarget,rawFee,limit='none',unit='unknown',alliance='unknown',branch='single',conditionalExtraFee=0]=row;
  const effects=split(rawEffects);
  const [targetMode,regionsRaw='']=rawTarget.split(':');
  const [feeKind,feeCountRaw='0',resourcesRaw='']=rawFee.split(':');
  const feeCount=Number(feeCountRaw);
  if(effects.some(effect=>!actionNames.has(effect))||
     !targetNames.has(targetMode)&&!['fixed','fixed_or_adjacent','fixed_then_adjacent',
       'battle_then_fixed_or_adjacent','any_legal_except'].includes(targetMode)||
     !['none','deck','hand','unknown'].includes(feeKind)||
     (feeKind!=='unknown'&&!Number.isFinite(feeCount)))
    throw new Error(`Training signal semantics invalid: ${id}`);
  return {subscriptions:triggerSubscriptions(id).sort(),futureActions:effects,
    targetMode,targetRegions:split(regionsRaw),feeKind,feeCount,
    feeResourceActions:split(resourcesRaw),conditionalExtraFee,useLimit:limit,unitConstraint:split(unit),
    allianceConstraint:alliance,branchMode:branch,
    known:{effects:true,target:targetMode!=='unknown',fee:feeKind!=='unknown',
      unit:unit!=='unknown',alliance:alliance!=='unknown'},
    potentialOnly:true};
};
