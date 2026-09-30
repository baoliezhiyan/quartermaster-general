// Standalone shared contract: no client source imports required.
export type SeatId='germany'|'united_kingdom'|'japan'|'soviet_union'|'italy'|'united_states';
export type CountryId=SeatId|'france'|'china';
export type Phase='TURN_START_WINDOW'|'PLAY'|'AIR'|'SUPPLY'|'SCORE'|'DISCARD'|'DRAW';
export interface Unit {id:string;country:CountryId;type:'army'|'navy'|'air';regionId:string;}
export interface CardInstance {id:string;definitionId:string;deckOwner:SeatId;country:CountryId;balance?:boolean;}
export type ResourceZone='hand'|'drawPile'|'discardPile'|'resourcePool';
export interface ZoneRef {seat:SeatId;zone:ResourceZone;}
export interface ResourceContents extends ZoneRef {ids:string[];visibility:'public'|'owner'|'omniscient';}
/** IDs are unique within a zone, but deliberately NOT unique across zones. */
export type ResourceOperation=
 | ({op:'set'} & ResourceContents)
 | ({op:'add';id:string;index?:number} & ZoneRef)
 | ({op:'remove';id:string} & ZoneRef)
 | {op:'move';id:string;from:ZoneRef;to:ZoneRef;index?:number};
export interface TrainingCard extends CardInstance {name:string;text:string;type:string;}
export type SceneEffect=
 | {kind:'board';country:CountryId;action:'build_army'|'build_navy'|'recruit_army'|'recruit_navy'|'land_battle'|'sea_battle'|'air_deploy'|'air_move'|'air_power'|'destroy';regionId:string;attackerId?:string;defenderId?:string;airId?:string;recycleId?:string;mode?:'build'|'battle'|'deploy'|'move'|'supremacy';newUnitId?:string;airDefense?:boolean}
 | {kind:'remove';unitId:string;reason:'cost'|'supply'|'retreat'}
 | {kind:'score';seat:SeatId;amount:number}
 | {kind:'supply';unitIds:string[]}
 | {kind:'status';seat:SeatId;cardId:string;operation:'install'|'remove'};
export interface TrainingHeader {
 type:'header';seq:0;format:'quartermaster-match-log';formatVersion:3;recordingModel:'scene_actions';mode:'resource_pool';
 replayAdapter:{id:'quartermaster-training-scene';version:'1.0.0'};
 recordingId:string;gameId:string;gameVersion:string;producer:{name:string;version:string};
 sceneEngineFingerprint:string;requiredCapabilities:string[];
 training:{courseId:string;courseVersion:string;configuration:Record<string,unknown>;ruleOverrides:string[]};
 cards:TrainingCard[];
}
export interface TrainingScene {units:Unit[];scores:Record<SeatId,number>;round:number;phase:Phase;activeSeat:SeatId;balance:boolean;activeCards?:Partial<Record<SeatId,string[]>>;}
export interface TrainingStart {type:'start';seq:1;scene:TrainingScene;resources?:ResourceContents[];}
/** Ordered operations: interleave a resource update with a scene effect when order matters. */
export interface TrainingStep {
 type:'training_action';seq:number;id:string;seat:SeatId;cardId?:string;summary?:string;
 round:number;phase:Phase;activeSeat:SeatId;
 operations:Array<{kind:'resource';change:ResourceOperation}|SceneEffect>;
 sceneHash:string;
}
export interface TrainingEnd {type:'end';seq:number;contentHash:string;}
export type TrainingLine=TrainingHeader|TrainingStart|TrainingStep|TrainingEnd;
export interface TrainingArchive {header:TrainingHeader;start:TrainingStart;steps:TrainingStep[];end:TrainingEnd;}
export const TRAINING_CAPABILITIES=['scene.board.v1','scene.score.v1','scene.remove.v1','scene.supply.v1','scene.status.v1','resources.independent.v1'] as const;
