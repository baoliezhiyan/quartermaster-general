import {MAP} from '../core/map';
import {COUNTRY_NAMES,UNIT_TOTALS} from '../core/basic';
import {ENGINE,VERSION,hashText} from '../actionReplay/state';
import {AI_INTERFACE_VERSION} from './contract';
export const referenceIdentity={id:`ai-reference-1:${ENGINE}`,version:1,rulesFingerprint:ENGINE};
export async function referenceData(){
 const data={...referenceIdentity,gameVersion:VERSION,interfaceVersion:AI_INTERFACE_VERSION,map:MAP,countries:COUNTRY_NAMES,printedUnitTotals:UNIT_TOTALS,
  semantics:{straits:'海峡海域连接取决于陆地控制者（无占领时按 defaultController）；动态连接以当前 observation.mapFacts 为准。',map:'baseEdges 为基础连接，供参考；卡牌修正和海峡效果均由正式 adjacentRegions 查询提供。',supply:'部队 supplied 复用正式 suppliedUnits；空军不直接因缺补给移除，底座消失时按正式免费调度处理。',reserve:'当前 reserve 复用正式 reserve 查询，printedUnitTotals 不含平衡开关的修正。'}};
 return {data,digest:await hashText(JSON.stringify(data))};
}
