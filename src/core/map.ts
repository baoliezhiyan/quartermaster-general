import source from '../data/map.json';
import type { Alliance, CountryId, DeepReadonly } from './types';

export interface Region {
  id: string;
  name: string;
  type: 'LAND' | 'SEA';
  supply: boolean;
  homeCountry: CountryId | null;
  initialArmyCountry: CountryId | null;
  notes: string;
}
export interface Strait {
  id: string;
  name: string;
  landRegion: string;
  seaA: string;
  seaB: string;
  defaultController: Alliance;
}
export type MapEdge = readonly [string, string];
export interface AdjacencyContext {
  alliance: Alliance;
  /** Controller of occupied land; absent/null land uses the strait's default controller. */
  landControllers?: Readonly<Record<string, Alliance | null>>;
  addedEdges?: readonly MapEdge[];
  removedEdges?: readonly MapEdge[];
}

function freeze<T>(value: T): DeepReadonly<T> {
  if (value && typeof value === 'object') {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
  return value as DeepReadonly<T>;
}

export const MAP = freeze(source as {
  version: string;
  source: string;
  sourceSha256: string;
  regions: Region[];
  baseEdges: [string, string][];
  straits: Strait[];
});
export const REGIONS = MAP.regions;
export const STRAITS = MAP.straits;
export const REGION_BY_ID = Object.freeze(Object.fromEntries(REGIONS.map(region => [region.id, region])));
export const edgeKey = (a: string, b: string) => [a, b].sort().join('|');
const permanentEdges = new Set(MAP.baseEdges.map(([a, b]) => edgeKey(a, b)));

export function straitController(strait: DeepReadonly<Strait>, context: AdjacencyContext): Alliance {
  return context.landControllers?.[strait.landRegion] ?? strait.defaultController;
}

export function isAdjacent(a: string, b: string, context: AdjacencyContext): boolean {
  if (!REGION_BY_ID[a] || !REGION_BY_ID[b] || a === b) return false;
  const key = edgeKey(a, b);
  if (context.removedEdges?.some(([x, y]) => edgeKey(x, y) === key)) return false;
  if (context.addedEdges?.some(([x, y]) => edgeKey(x, y) === key)) return true;
  if (permanentEdges.has(key)) return true;
  return STRAITS.some(strait => edgeKey(strait.seaA, strait.seaB) === key && straitController(strait, context) === context.alliance);
}

export function getNeighbors(regionId: string, context: AdjacencyContext): string[] {
  return REGIONS.filter(region => isAdjacent(regionId, region.id, context)).map(region => region.id);
}

/** Printed-map distance ignores strait ownership and temporary card-created links. */
export function isDistanceAdjacent(a:string,b:string):boolean {
 if(!REGION_BY_ID[a]||!REGION_BY_ID[b]||a===b)return false;
 const key=edgeKey(a,b);
 return permanentEdges.has(key)||STRAITS.some(strait=>edgeKey(strait.seaA,strait.seaB)===key);
}

const printedDistances=new Map<string,Map<string,number>>();
export function withinPrintedDistance(a:string,b:string,n:number):boolean {
 let distances=printedDistances.get(a);
 if(!distances){distances=new Map([[a,0]]);const queue=[a];for(let i=0;i<queue.length;i++)for(const r of REGIONS)if(!distances.has(r.id)&&isDistanceAdjacent(queue[i],r.id)){distances.set(r.id,distances.get(queue[i])!+1);queue.push(r.id);}printedDistances.set(a,distances);}
 return (distances.get(b)??Infinity)<=Math.max(0,Math.ceil(n));
}
