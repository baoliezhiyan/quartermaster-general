"""Repair SVG interaction contours; preserve the raster and logical adjacency graph."""
from pathlib import Path
import sys, json, re
ROOT=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(ROOT/'outputs/map-tools'))
from shapely.geometry import Polygon
from shapely import make_valid
from shapely.ops import unary_union
path=ROOT/'src/ui/map/traced-geometry.json'
shapes=json.loads(path.read_text(encoding='utf-8'))
def parse(path):
    result=Polygon()
    for ring in path.split('Z'):
        points=[tuple(map(float,p)) for p in re.findall(r'(-?[\d.]+),(-?[\d.]+)',ring)]
        if len(points)>2:result=result.symmetric_difference(make_valid(Polygon(points)))
    return result
polys={s['key']:parse(s['path']) for s in shapes}
polys['sea_north_sea']=polys['sea_north_sea'].difference(polys['british_isles'])
polys['sea_east_china']=polys['sea_east_china'].difference(polys['japan'])
# Join both sides of each sub-pixel gap, then dissolve the shared edges.
polys['sea_east_pacific']=unary_union([polys['sea_east_pacific'],Polygon([(1461.3,889.34),(1462.23,889.34),(1461,901),(1460,901)])])
polys['middle_east']=unary_union([polys['middle_east'],Polygon([(683,439),(689,445),(695,455),(693,452),(683,440)])])
polys['sea_arabian']=polys['sea_arabian'].difference(polys['middle_east'])
for key in ['middle_east','sea_east_pacific']:assert polys[key].geom_type=='Polygon',key
for land,sea in [('british_isles','sea_north_sea'),('japan','sea_east_china'),('middle_east','sea_arabian')]:assert polys[land].intersection(polys[sea]).area<.001
changed={'sea_north_sea','sea_east_china','sea_east_pacific','middle_east','sea_arabian'}
for s in shapes:
    if s['key'] not in changed:continue
    geom=polys[s['key']];parts=[geom] if geom.geom_type=='Polygon' else geom.geoms
    rings=[]
    for part in parts:
        for ring in [part.exterior,*part.interiors]:
            rings.append('M '+' L '.join(f'{x:.2f},{y:.2f}' for x,y in list(ring.coords)[:-1])+' Z')
    s['path']=' '.join(rings)
path.write_text(json.dumps(shapes,ensure_ascii=False,separators=(',',':')),encoding='utf-8')
print('Repaired island holes and dissolved internal fragment seams.')
