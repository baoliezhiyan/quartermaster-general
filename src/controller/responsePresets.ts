import { createGame, transition } from '../core/game';
import { SEATS } from '../core';
import type { SeatId } from '../core';
import type { SaveSession } from './saveFormat';
export const RESPONSE_PRESETS=[
 {id:'bletchley',name:'布莱切利园 · 取消德国增强',hint:'在德国手牌中选择高亮的云量，再点击地图上方确认；切到英国，用布莱切利园支付费用取消云量，或跳过。'},
 {id:'anti-submarine',name:'反潜战术 · 取消经济战',hint:'德国打出潜艇袭击无防备运输船；切到英国，发动已暗置的反潜战术。取消后德国不加分、英国不烧牌库。'},
 {id:'keep-calm',name:'保持冷静 · 取消状态效果',hint:'德国在出牌阶段发动征兵；切到英国，打出保持冷静，继续前进并弃一张手牌。'},
 {id:'bletchley-no-fee',name:'布莱切利园 · 无费用牌对照',hint:'英国只有布莱切利园，没有其他手牌。德国触发云量后，英国不能支付费用，因此不询问这张牌的响应。'},
 {id:'guided-battle',name:'地图交互 · 双方空军',hint:'德国打出发起陆战，攻击西欧；选择英国兵模和德国发起部队，再分别切换视角回答防御、拦截。'},
 {id:'guided-planning',name:'地图交互 · 卓越规划与云量',hint:'手牌和持续生效栏都有可用效果；卓越规划在中央展示四张牌，按点击顺序放回。'},
 {id:'guided-democracy',name:'地图交互 · 民主兵工厂',hint:'美国打出民主兵工厂，第一次选择陆地或海域决定建设顺序，也可跳过其中一项。'},
 {id:'guided-barbarossa',name:'地图交互 · 巴巴罗萨',hint:'德国手牌选择巴巴罗萨行动，在地图点击苏联兵模确定目标与顺序，然后逐次作战。'},
] as const;
export function responsePreset(id:string,gameId:string):SaveSession {
 if(!RESPONSE_PRESETS.some(p=>p.id===id))throw new Error('未知响应测试场景。');
 let s=createGame(gameId,1940,'FULL');
 s.status='PLAYING';s.round=1;s.phase=id.startsWith('bletchley')?'TURN_START_WINDOW':'PLAY';s.setupCompleted=[...SEATS];s.redistributed=true;
 for(const seat of SEATS){const d=s.decks[seat];d.drawPile=[...d.hand,...d.drawPile];d.hand=[];}
 const give=(seat:SeatId,definitionId:string,zone:'hand'|'active'|'faceDown'='hand')=>{
  const d=s.decks[seat],i=d.drawPile.findIndex(c=>c.definitionId===definitionId);if(i<0)throw new Error(`场景缺牌：${definitionId}`);d[zone].push(...d.drawPile.splice(i,1));
 };
 give('germany','build_army');give('germany','build_navy');
 if(id.startsWith('bletchley')){give('germany','special_142');give('united_kingdom','special_39');}
 if(id==='anti-submarine'){give('germany','special_168');give('united_kingdom','special_15','faceDown');}
 if(id==='keep-calm'){give('germany','special_135','active');give('united_kingdom','special_37');}
 if(id!=='bletchley-no-fee'){give('united_kingdom','build_army');give('united_kingdom','build_navy');}
 if(id==='guided-battle'){give('germany','land_battle');s.units=s.units.filter(u=>u.regionId!=='western_europe');s.units.push({id:'test:uk',country:'united_kingdom',type:'army',regionId:'western_europe'},{id:'test:uk-air',country:'united_kingdom',type:'air',regionId:'western_europe'},{id:'test:de-air',country:'germany',type:'air',regionId:'germany'},{id:'test:us',country:'united_states',type:'army',regionId:'western_europe'});}
 if(id==='guided-planning'){give('germany','special_132','active');give('germany','special_142');s.phase='TURN_START_WINDOW';}
 if(id==='guided-democracy'){give('united_states','special_98');s.activeSeat=s.operatorSeat=s.viewSeat='united_states';}
 if(id==='guided-barbarossa'){give('germany','special_162');s.units.push({id:'test:su-east',country:'soviet_union',type:'army',regionId:'eastern_europe'},{id:'test:su-west',country:'soviet_union',type:'army',regionId:'western_europe'});s.units=s.units.filter(u=>!(u.country==='france'&&u.regionId==='western_europe'));}
 if(id.startsWith('bletchley')||id==='guided-planning'){const result=transition(s,{type:'ADVANCE_PHASE',seat:'germany',expectedRevision:s.revision});if(!result.ok)throw new Error('无法进入场景出牌阶段。');s=result.state;}
 const createdAt=new Date().toISOString();
 return {format:'quartermaster-save',version:1,updatedAt:createdAt,state:s,replayBase:structuredClone(s),commands:[],undo:[],rounds:s.activeSeat==='germany'?[{id:'round:1',round:1,seat:'germany',createdAt,state:structuredClone(s)}]:[],nations:[{id:`nation:1:${s.activeSeat}`,round:1,seat:s.activeSeat,createdAt,state:structuredClone(s)}]};
}
