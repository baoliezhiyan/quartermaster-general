"""Apply the three user-requested position adjustments; leave every path unchanged."""
from pathlib import Path
import json,sys,re,math
ROOT=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(ROOT/'.tools/placement'))
from shapely.geometry import Polygon,Point
import shapely
p=ROOT/'src/ui/map/traced-geometry.json'
shapes=json.loads(p.read_text(encoding='utf-8'))
before=ROOT/'outputs/unit-layout-review/before-northern-tuning.json'
if not before.exists():before.write_bytes(p.read_bytes())
offsets={
 'canada':([(0,-21.94),(-19,10.97),(19,10.97)],(191,150)),
 'sea_north_atlantic':([(-38,0),(0,0),(38,0)],(165,303)),
 'sea_north_sea':([(-19,-10.97),(19,-10.97),(0,21.94)],(300,302)),
}
result={}
report_path=ROOT/'outputs/unit-layout-review/placement.json'
report=json.loads(report_path.read_text(encoding='utf-8'))
for s in shapes:
 if s['key'] not in offsets:continue
 poly=Polygon()
 for ring in s['path'].split('Z'):
  pts=[tuple(map(float,p)) for p in re.findall(r'(-?[\d.]+),(-?[\d.]+)',ring)]
  if len(pts)>2:poly=poly.symmetric_difference(shapely.make_valid(Polygon(pts)))
 template,center=offsets[s['key']]
 best=None
 for dx in range(-35,36):
  for dy in range(-35,36):
   slots=[[round(center[0]+dx+x,2),round(center[1]+dy+y,2)] for x,y in template]
   if not all(poly.contains(Point(pt)) and poly.boundary.distance(Point(pt))>=19.5 for pt in slots):continue
   score=dx*dx+dy*dy
   if best is None or score<best[0]:best=(score,slots)
 if best is None:raise ValueError(s['key'])
 s['tokenSlots']=best[1];s['tokenAnchor']=best[1][0]
 result[s['key']]=best[1]
 for entry in report['regions']:
  if entry['id']==s['key']:
   entry['slots']=best[1]
   entry['rimClearance']=round(min(poly.boundary.distance(Point(pt))-18 for pt in best[1]),2)
   entry['gap']=round(min(math.dist(best[1][i],best[1][j])-36 for i,j in [(0,1),(0,2),(1,2)]),2)
 print(s['key'],best[1],flush=True)
p.write_text(json.dumps(shapes,ensure_ascii=False,separators=(',',':')),encoding='utf-8')
(ROOT/'src/ui/map/unit-slot-overrides.json').write_text(json.dumps(result,indent=2),encoding='utf-8')
report_path.write_text(json.dumps(report,ensure_ascii=False,indent=2),encoding='utf-8')
