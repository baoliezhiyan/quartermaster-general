"""Author reviewed SVG hit areas and three unit slots; never changes raster or rule graph.

Requires shapely in .tools/placement. Source snapshot makes repeated runs deterministic.
"""
from pathlib import Path
import sys, json, re, math
ROOT=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(ROOT/'.tools/placement'))
import numpy as np
import shapely as sh
from shapely.geometry import Polygon, Point, MultiPoint, box
from shapely.ops import unary_union, polylabel

OUT=ROOT/'outputs/unit-layout-review'
OUT.mkdir(parents=True,exist_ok=True)
source=OUT/'geometry-before.json'
target=ROOT/'src/ui/map/traced-geometry.json'
if not source.exists(): source.write_bytes(target.read_bytes())
shapes=json.loads(source.read_text(encoding='utf-8'))
def parse(path):
    result=Polygon()
    for ring in path.split('Z'):
        pts=[tuple(map(float,p)) for p in re.findall(r'(-?[\d.]+),(-?[\d.]+)',ring)]
        if len(pts)>2: result=result.symmetric_difference(sh.make_valid(Polygon(pts)))
    return result
polys={s['key']:parse(s['path']) for s in shapes}
original=polys.copy()
primaries=[s for s in shapes if not s.get('fragment')]
mic=sh.maximum_inscribed_circle(polys['iwo_jima'],tolerance=.1)
old_diameter=mic.length*2
D=36 # Previous 15px radius increased to 120% = 18px.
R=D/2
GAP=2
PAD=1.5
step=D+GAP
room_centers=[]
print('Iwo Jima old inscribed diameter',old_diameter,'new unit diameter',D,flush=True)

def candidates(poly):
    safe=poly.buffer(-R-PAD)
    if safe.is_empty:return np.empty((0,2))
    a,b,c,d=safe.bounds
    xx,yy=np.meshgrid(np.arange(a,c+1,3),np.arange(b,d+1,3))
    pts=np.column_stack([xx.ravel(),yy.ravel()])
    return pts[sh.contains_xy(safe,pts[:,0],pts[:,1])]

def layout(poly,triangle_only=False):
    safe=poly.buffer(-R-PAD)
    pts=candidates(poly)
    if room_centers:pts=np.vstack([pts,np.array(room_centers)])
    if len(pts)<3:return None
    center=np.array(poly.centroid.coords[0])
    # Keep groups compact and close to the region's center, with full rim clearance.
    best=None; best_score=float('inf')
    templates=[np.array([[-step/2,step*math.sqrt(3)/6],[step/2,step*math.sqrt(3)/6],[0,-step*math.sqrt(3)/3]])]
    if not triangle_only:templates.append(np.array([[-step,0],[0,0],[step,0]]))
    for template in templates:
        for deg in range(0,360,30):
            t=math.radians(deg);rot=np.array([[math.cos(t),-math.sin(t)],[math.sin(t),math.cos(t)]])
            offsets=template@rot
            groups=pts[:,None,:]+offsets
            ok=np.all(sh.contains_xy(safe,groups[:,:,0],groups[:,:,1]),axis=1)
            if not np.any(ok):continue
            valid=groups[ok];score=np.sum((valid.mean(axis=1)-center)**2,axis=1)
            i=int(np.argmin(score))
            if score[i]<best_score:best_score=float(score[i]);best=valid[i]
    if best is not None:return best
    if triangle_only:return None
    # Thin/curving territories may need a bent row instead of a rigid template.
    pts=pts[sh.contains_xy(safe,pts[:,0],pts[:,1])]
    order=np.argsort(np.sum((pts-center)**2,axis=1))
    for first in pts[order[:250]]:
        rest=pts[np.linalg.norm(pts-first,axis=1)>=step]
        rest=rest[np.argsort(np.linalg.norm(rest-first,axis=1))[:100]]
        for second in rest:
            third=rest[np.linalg.norm(rest-second,axis=1)>=step]
            if not len(third):continue
            third=third[np.argmin(np.sum((third-first)**2,axis=1)+np.sum((third-second)**2,axis=1))]
            group=np.array([first,second,third]);score=np.sum((group-center)**2)+np.sum((group-group.mean(axis=0))**2)
            if score<best_score:best_score=float(score);best=group
    return best

required={'iceland','iwo_jima','hawaii','philippines'}
optional={s['key'] for s in primaries} # User approved corresponding local expansions, including Black Sea.
expanded=[]
for s in primaries:
    key=s['key']
    if key not in required|optional:continue
    slots=layout(polys[key],key in required)
    if slots is not None and key not in required:continue
    center=np.array(polys[key].centroid.coords[0])
    # These four get a compact triangular room while retaining the original island silhouette.
    offsets=np.array([[-step/2,step*math.sqrt(3)/6],[step/2,step*math.sqrt(3)/6],[0,-step*math.sqrt(3)/3]])
    best=None
    for dx in range(-15,16,5):
        for dy in range(-15,16,5):
            positions=np.clip(center+np.array([dx,dy]),[step/2+R+PAD+4,step/math.sqrt(3)+R+PAD+4],[1743-step/2-R-PAD-4,902-step/math.sqrt(3)-R-PAD-4])+offsets
            room=MultiPoint(positions).convex_hull.buffer(R+PAD+3,quad_segs=12)
            extra=room.difference(polys[key]);cost=extra.area+3*(dx*dx+dy*dy)
            if best is None or cost<best[0]:best=(cost,room,positions.mean(axis=0))
    room_centers.append(best[2])
    room=best[1].intersection(box(0,0,1743,902))
    extra=room.difference(polys[key])
    polys[key]=polys[key].union(room)
    for other in polys:
        if other!=key and polys[other].intersects(extra):polys[other]=polys[other].difference(room)
    expanded.append(key)

def serialize(poly):
    parts=[poly] if poly.geom_type=='Polygon' else list(poly.geoms)
    rings=[]
    for p in parts:
        if p.geom_type!='Polygon':continue
        for r in [p.exterior,*p.interiors]:
            coords=list(r.coords)[:-1]
            rings.append('M '+' L '.join(f'{x:.2f},{y:.2f}' for x,y in coords)+' Z')
    return ' '.join(rings)

override_file=ROOT/'src/ui/map/unit-slot-overrides.json'
overrides=json.loads(override_file.read_text(encoding='utf-8')) if override_file.exists() else {}
report=[];failed=[]
for s in shapes:
    poly=polys[s['key']]
    if not poly.equals(original[s['key']]):s['path']=serialize(poly)
    if s.get('fragment'):continue
    slots=layout(poly,s['key'] in required)
    if s['key'] in overrides:slots=np.array(overrides[s['key']],dtype=float)
    if slots is None:failed.append(s['key']);continue
    slots=np.round(slots,2)
    s['tokenSlots']=slots.tolist();s['tokenAnchor']=s['tokenSlots'][0]
    if s['label'][0] in (0,1742) or s['label'][1] in (0,901):s['label']=slots.mean(axis=0).round(2).tolist()
    clearance=min(poly.boundary.distance(Point(p))-R for p in slots)
    separation=min(math.dist(slots[a],slots[b])-D for a,b in [(0,1),(0,2),(1,2)])
    report.append({'id':s['key'],'slots':slots.tolist(),'rimClearance':round(clearance,2),'gap':round(separation,2),'expanded':s['key'] in expanded})
print('Expanded',expanded,'failed',failed,flush=True)
if failed:raise RuntimeError(f'No placement for {failed}')
target.write_text(json.dumps(shapes,ensure_ascii=False,separators=(',',':')),encoding='utf-8')
(OUT/'placement.json').write_text(json.dumps({'diameter':D,'oldIwoInscribedDiameter':old_diameter,'regions':report},ensure_ascii=False,indent=2),encoding='utf-8')
print('Saved',len(report),'regions; smallest rim clearance',min(r['rimClearance'] for r in report),flush=True)
