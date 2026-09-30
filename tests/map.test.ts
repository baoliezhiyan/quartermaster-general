import { describe, expect, it } from 'vitest';
import { edgeKey, getNeighbors, isAdjacent, MAP, REGIONS, REGION_BY_ID, STRAITS, straitController } from '../src/core/map';
import { INLAND_SEA_SHAPES, LAND_SHAPES, SEA_SHAPES, MAP_WIDTH, MAP_HEIGHT, TOKEN_DIAMETER } from '../src/ui/map/geometry';
import type { Alliance } from '../src/core';

describe('reviewed map data', () => {
  it('has 51 unique regions, 34 lands, 17 seas, 12 supply points and 8 headquarters', () => {
    expect(REGIONS).toHaveLength(51);
    expect(new Set(REGIONS.map(region => region.id)).size).toBe(51);
    expect(REGIONS.filter(region => region.type === 'LAND')).toHaveLength(34);
    expect(REGIONS.filter(region => region.type === 'SEA')).toHaveLength(17);
    expect(REGIONS.filter(region => region.supply)).toHaveLength(12);
    expect(REGIONS.filter(region => region.homeCountry)).toHaveLength(8);
    expect(REGIONS.filter(region => region.initialArmyCountry)).toHaveLength(8);
    expect(REGION_BY_ID.western_europe.homeCountry).toBe('france');
    expect(REGION_BY_ID.eastern_china.homeCountry).toBe('china');
    expect(REGION_BY_ID.sea_caspian.type).toBe('SEA');
  });
  it('has exactly 127 permanent and 5 conditional undirected edges, without duplicate/self/unknown edges', () => {
    const allEdges = [...MAP.baseEdges, ...STRAITS.map(strait => [strait.seaA, strait.seaB] as const)];
    expect(MAP.baseEdges).toHaveLength(127);
    expect(STRAITS).toHaveLength(5);
    expect(new Set(allEdges.map(([a, b]) => edgeKey(a, b))).size).toBe(132);
    allEdges.forEach(([a, b]) => {
      expect(a).not.toBe(b);
      expect(REGION_BY_ID[a]).toBeDefined();
      expect(REGION_BY_ID[b]).toBeDefined();
    });
  });
  it.each<Alliance>(['axis', 'allies'])('is symmetric with no isolated regions for %s', alliance => {
    REGIONS.forEach(a => {
      expect(getNeighbors(a.id, { alliance }).length).toBeGreaterThan(0);
      REGIONS.forEach(b => expect(isAdjacent(a.id, b.id, { alliance })).toBe(isAdjacent(b.id, a.id, { alliance })));
    });
  });
  it.each<Alliance>(['axis', 'allies'])('never invents the two point-contact diagonals for %s', alliance => {
    expect(isAdjacent('middle_east', 'balkans', { alliance })).toBe(false);
    expect(isAdjacent('sea_mediterranean', 'sea_black', { alliance })).toBe(false);
    expect(isAdjacent('middle_east', 'sea_black', { alliance })).toBe(true);
    expect(isAdjacent('balkans', 'sea_mediterranean', { alliance })).toBe(true);
  });
  it('explicitly connects East Pacific to all three cross-map American regions', () => {
    const neighbors = getNeighbors('sea_east_pacific', { alliance: 'axis' });
    expect(neighbors).toHaveLength(9);
    expect(neighbors).toEqual(expect.arrayContaining(['canada', 'united_states', 'latin_america', 'sea_southeast_pacific']));
  });
  it('keeps source topology immutable and handles unknown/self queries safely', () => {
    expect(Object.isFrozen(MAP.baseEdges[0])).toBe(true);
    expect(Object.isFrozen(REGION_BY_ID.canada)).toBe(true);
    expect(isAdjacent('unknown', 'canada', { alliance: 'axis' })).toBe(false);
    expect(isAdjacent('canada', 'canada', { alliance: 'axis' })).toBe(false);
    expect(getNeighbors('unknown', { alliance: 'axis' })).toEqual([]);
  });
});

describe('five controlled straits', () => {
  it.each(STRAITS)('$name uses its authoritative sea endpoints and default controller', strait => {
    const other: Alliance = strait.defaultController === 'axis' ? 'allies' : 'axis';
    expect(REGION_BY_ID[strait.landRegion].type).toBe('LAND');
    expect(REGION_BY_ID[strait.seaA].type).toBe('SEA');
    expect(REGION_BY_ID[strait.seaB].type).toBe('SEA');
    expect(isAdjacent(strait.seaA, strait.seaB, { alliance: strait.defaultController })).toBe(true);
    expect(isAdjacent(strait.seaA, strait.seaB, { alliance: other })).toBe(false);
    const occupation = { [strait.landRegion]: other };
    expect(isAdjacent(strait.seaA, strait.seaB, { alliance: other, landControllers: occupation })).toBe(true);
    expect(isAdjacent(strait.seaB, strait.seaA, { alliance: strait.defaultController, landControllers: occupation })).toBe(false);
    expect(straitController(strait, { alliance: other, landControllers: { [strait.landRegion]: null } })).toBe(strait.defaultController);
  });
  it('supports reversible dynamic edge overlays without changing the baseline', () => {
    const edge = ['canada', 'united_states'] as const;
    expect(isAdjacent(...edge, { alliance: 'axis', removedEdges: [edge] })).toBe(false);
    expect(isAdjacent(...edge, { alliance: 'axis' })).toBe(true);
    const added = ['canada', 'australia'] as const;
    expect(isAdjacent(...added, { alliance: 'allies', addedEdges: [added] })).toBe(true);
    expect(isAdjacent(...added, { alliance: 'allies' })).toBe(false);
  });
});

describe('SVG geography binding', () => {
  const shapes = [...SEA_SHAPES, ...LAND_SHAPES, ...INLAND_SEA_SHAPES];
  it('provides closed, clickable geometry and a label for every logical region', () => {
    expect(new Set(shapes.map(shape => shape.regionId))).toEqual(new Set(REGIONS.map(region => region.id)));
    expect(new Set(shapes.map(shape => shape.key)).size).toBe(shapes.length);
    shapes.forEach(shape => {
      expect(shape.path).toMatch(/^M .+ Z$/);
      expect(shape.label[0]).toBeGreaterThanOrEqual(0);
      expect(shape.label[0]).toBeLessThanOrEqual(MAP_WIDTH);
      expect(shape.label[1]).toBeGreaterThanOrEqual(0);
      expect(shape.label[1]).toBeLessThanOrEqual(MAP_HEIGHT);
    });
  });
  it.each(['canada', 'united_states', 'latin_america'])('reuses %s for the right edge fragment', id => {
    const fragments = shapes.filter(shape => shape.regionId === id);
    expect(fragments).toHaveLength(2);
    expect(fragments.filter(shape => shape.fragment)).toHaveLength(1);
    expect(fragments.find(shape => shape.fragment)?.label[0]).toBeGreaterThan(1600);
  });
  it('anchors units only on primary pieces, with one consistent European scale', () => {
    shapes.filter(s => s.fragment).forEach(s => expect(s.tokenAnchor).toBeUndefined());
    shapes.filter(s => !s.fragment).forEach(s => expect(s.tokenAnchor).toHaveLength(2));
    expect(shapes.find(s => s.regionId === 'latin_america' && !s.fragment)?.tokenAnchor?.[0]).toBeLessThan(300);
    expect(TOKEN_DIAMETER).toBe(36);
  });
  it('fits three separate full token footprints inside every primary region', () => {
    const contains = (path: string, x: number, y: number) => {
      let inside = false;
      for (const ring of path.split(' Z').filter(Boolean)) {
        const points = [...ring.matchAll(/(-?[\d.]+),(-?[\d.]+)/g)].map(m => [Number(m[1]), Number(m[2])]);
        for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
          const [ax, ay] = points[i], [bx, by] = points[j];
          if ((ay > y) !== (by > y) && x < (bx - ax) * (y - ay) / (by - ay) + ax) inside = !inside;
        }
      }
      return inside;
    };
    for (const shape of shapes.filter(s=>!s.fragment)) {
      expect(shape.tokenSlots,shape.regionId).toHaveLength(3);
      for (const [i,[x,y]] of shape.tokenSlots!.entries()) {
        expect(contains(shape.path,x,y),shape.regionId).toBe(true);
        for (let angle = 0; angle < Math.PI * 2; angle += Math.PI / 36) {
          expect(contains(shape.path, x + Math.cos(angle) * (TOKEN_DIAMETER / 2+.75), y + Math.sin(angle) * (TOKEN_DIAMETER / 2+.75)), shape.regionId).toBe(true);
        }
        for(const [a,b] of shape.tokenSlots!.slice(i+1))expect(Math.hypot(x-a,y-b),shape.regionId).toBeGreaterThan(TOKEN_DIAMETER+1.9);
      }
    }
  });
});

// Match SVG even-odd fill, including sea holes around island hit areas.
function insidePath(path:string,x:number,y:number){let inside=false;for(const ring of path.split('Z')){const ps=[...ring.matchAll(/(-?[\d.]+),(-?[\d.]+)/g)].map(m=>[+m[1],+m[2]]);for(let i=0,j=ps.length-1;i<ps.length;j=i++){const [ax,ay]=ps[i],[bx,by]=ps[j];if((ay>y)!==(by>y)&&x<(bx-ax)*(y-ay)/(by-ay)+ax)inside=!inside;}}return inside;}
it.each([['british_isles','sea_north_sea'],['japan','sea_east_china']])('island %s is never covered by %s', (land,sea)=>{
 const island=LAND_SHAPES.find(s=>s.regionId===land)!,water=SEA_SHAPES.find(s=>s.regionId===sea)!;
 for(let x=0;x<MAP_WIDTH;x+=3)for(let y=0;y<MAP_HEIGHT;y+=3)if(insidePath(island.path,x,y))expect(insidePath(water.path,x,y),`${land} ${x},${y}`).toBe(false);
});
it.each(['middle_east','sea_east_pacific'])('%s has one dissolved outline, without an internal fragment seam',id=>{
 const s=[...LAND_SHAPES,...SEA_SHAPES].find(s=>s.regionId===id)!;expect(s.path.match(/M /g)).toHaveLength(1);
});
