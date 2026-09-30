"""Reproducible traced geometry. Review output in the game's boundary view.
Raster is read only. Topology is never inferred from these display contours.
"""
from trace_map import ROOT, SEEDS
import cv2, numpy as np, json
from scipy.ndimage import distance_transform_edt

c = np.load(ROOT/'map-work/components.npz')['components']
h,w=c.shape
keys=list(SEEDS)
labels=np.zeros((h,w),np.uint16)
chosen={k:[int(c[y,x])] for k,(x,y) in SEEDS.items()}
chosen.update({'iceland':[], 'british_isles':[], 'italy':[], 'eastern_europe':[127,216],
 'ross_region':[7,17], 'mongolia':[130], 'vladivostok':[11], 'japan':[],
 'indonesia':[], 'new_guinea':[], 'iwo_jima':[], 'hawaii':[], 'new_zealand':[],
 'madagascar':[], 'sea_baltic':[], 'sea_black':[], 'sea_caspian':[],
 'latin_america-east':[], 'sea_south_pacific':[], 'sea_east_pacific':[]})
chosen['canada'] += [3,4]
for k,ids in chosen.items():
 if not ids: continue
 assert 0 not in ids, k
 mask=np.isin(c,ids)
 labels[mask]=keys.index(k)+1
# Separate ocean compartments where decorative symbols interrupt boundary ink.
y,x=np.indices((h,w))
east_line=np.where(y<384,1642-(y-100)*107/284,1535-(y-384)*75/518)
labels[(c==12)&(x>east_line)]=keys.index('sea_east_pacific')+1
# Southern Pacific is east of Australia; below its coast the divider follows NZ.
labels[(c==735)&(x>np.where(y<850,1320,1415+(y-850)*.6))]=keys.index('sea_south_pacific')+1

# Supplementary contours for small islands and lettering-obscured outlines.
# These are transparent interaction areas, deliberately generous on small islands.
patches={
 'middle_east':['694,416 721,420 747,430 772,443 788,456 808,460 829,459 845,461 867,460 895,468 891,484 870,493 849,509 831,523 804,539 790,535 776,512 759,493 742,468 724,451 705,445'],
 'iceland':['316,17 329,10 342,22 343,42 329,53 312,44 308,30'],
 'british_isles':['371,88 386,85 398,95 391,111 402,125 405,146 417,159 406,174 410,188 392,196 369,189 352,197 328,185 324,171 331,152 347,147 341,136 350,122 369,120'],
 'italy':['477,272 493,266 513,272 518,284 535,291 539,311 541,328 552,341 564,351 570,366 562,374 549,365 550,382 540,397 527,392 519,382 529,373 523,357 507,341 491,340 480,327 474,310'],
 'japan':['1344,228 1357,228 1362,245 1354,265 1367,280 1361,300 1345,319 1342,339 1324,348 1312,367 1297,377 1288,368 1293,346 1308,332 1323,317 1332,294 1334,272 1344,258'],
 'philippines':['1242,459 1256,465 1258,489 1271,501 1265,523 1280,539 1271,551 1250,538 1242,516 1230,530 1224,519 1235,497'],
 'indonesia':['1083,545 1100,550 1115,568 1127,596 1143,610 1170,617 1191,629 1200,648 1182,653 1150,640 1121,625 1105,608 1099,583 1084,564', '1155,563 1172,553 1183,538 1197,537 1200,553 1187,570 1186,588 1172,604 1155,594', '1204,577 1214,570 1224,588 1237,588 1249,607 1239,620 1224,614 1214,629 1201,619 1208,602', '1245,639 1265,639 1288,650 1281,664 1261,655 1244,655'],
 'new_guinea':['1310,590 1327,587 1342,600 1356,599 1369,610 1385,610 1403,623 1420,626 1425,641 1408,650 1393,644 1380,650 1366,640 1350,637 1340,625 1323,621'],
 'new_zealand':['1480,811 1494,805 1503,820 1498,841 1486,854 1470,854 1460,843 1466,827', '1465,852 1477,861 1473,876 1454,886 1439,901 1412,901 1427,882 1445,869'],
 'madagascar':['699,699 716,688 726,694 719,717 718,740 709,768 692,790 676,797 667,784 675,764 683,745 685,721'],
 'sea_baltic':['519,107 535,111 547,99 560,101 572,92 584,94 583,115 595,123 589,145 578,169 555,172 536,165 513,163 505,150 514,130'],
 'sea_black':['650,294 665,287 680,295 695,281 708,292 718,300 729,316 719,332 702,337 682,331 669,339 648,335 640,319'],
 'sea_caspian':['787,254 801,257 804,271 795,283 803,298 805,317 820,339 816,356 799,353 787,338 785,322 773,311 767,292 773,273'],
 'latin_america-east':['1637,305 1670,303 1690,310 1715,309 1742,309 1742,416 1729,421 1723,406 1708,402 1694,387 1686,369 1665,358 1655,338'],
 'latin_america':['0,379 14,374 23,386 29,408 53,423 76,444 95,444 104,460 130,453 149,456 159,471 140,482 110,479 88,468 69,467 53,446 38,439 29,425 11,420 0,408'],
 'scandinavia':['491,0 523,0 518,36 510,61 511,77 506,98 491,108 481,100 480,81 487,68 483,54'],
 'southeast_asia':['1066,519 1080,514 1092,532 1101,548 1114,559 1111,575 1097,567 1081,548'],
}
for k,polys in patches.items():
 for p in polys:
  pts=np.array([[int(v) for v in point.split(',')] for point in p.split()],np.int32)
  cv2.fillPoly(labels,[pts],keys.index(k)+1)
for k,center,axes in [('iwo_jima',(1383,394),(18,15)),('hawaii',(1534,383),(20,17))]:
 cv2.ellipse(labels,center,axes,0,0,360,keys.index(k)+1,-1)
# Assign only ink/text gaps to their nearest traced region, preserving holes/islands.
_,nearest=distance_transform_edt(labels==0,return_indices=True)
labels=labels[tuple(nearest)]
# User-reviewed corrections: absorb the tiny northern notch and remove the
# detached southeast Indonesian hit island. Apply after gap filling so no other
# shoreline or neighboring region changes.
north_notch=(labels==keys.index('sea_north_sea')+1)&(x>=519)&(x<=540)&(y<=30)
labels[north_notch]=keys.index('scandinavia')+1
_,indonesian_parts=cv2.connectedComponents((labels==keys.index('indonesia')+1).astype(np.uint8),connectivity=8)
detached_part=indonesian_parts[650,1265]
assert detached_part != 0
labels[indonesian_parts==detached_part]=keys.index('sea_south_china')+1
# The user also assigns the detached southwest Southeast Asian piece to Arabian Sea.
_,southeast_parts=cv2.connectedComponents((labels==keys.index('southeast_asia')+1).astype(np.uint8),connectivity=8)
southwest_part=southeast_parts[540,1090]
assert southwest_part != 0 and southwest_part != southeast_parts[492,1135]
labels[southeast_parts==southwest_part]=keys.index('sea_arabian')+1
np.save(ROOT/'map-work/region-labels.npy',labels)
regions=json.loads((ROOT/'src/data/map.json').read_text(encoding='utf8'))['regions']
types={r['id']:r['type'] for r in regions}
anchors={'italy':(497,312),'germany':(548,254),'western_europe':(391,337),
 'scandinavia':(590,0),'sea_south_china':(1280,610),
 'eastern_europe':(611,214),'british_isles':(365,155),'japan':(1336,315),
 'iwo_jima':(1383,394),'hawaii':(1534,383),'latin_america':(173,651)}
shapes=[]
for i,key in enumerate(keys,1):
 mask=(labels==i).astype(np.uint8)
 contours,_=cv2.findContours(mask,cv2.RETR_LIST,cv2.CHAIN_APPROX_SIMPLE)
 paths=[]
 for contour in contours:
  if cv2.contourArea(contour)<7: continue
  points=cv2.approxPolyDP(contour,.85,True)[:,0,:]
  paths.append('M '+' L '.join(f'{a},{b}' for a,b in points)+' Z')
 assert paths,key
 dist=cv2.distanceTransform(mask,cv2.DIST_L2,5)
 yy,xx=np.unravel_index(dist.argmax(),dist.shape)
 anchor=anchors.get(key,(int(xx),int(yy)))
 assert labels[anchor[1],anchor[0]]==i,(key,anchor)
 rid=key.removesuffix('-east') if key.endswith('-east') else key
 shape={'key':key,'regionId':rid,'path':' '.join(paths),'label':anchor}
 if key.endswith('-east'): shape.update(fragment=True,fragmentSide='right')
 else: shape['tokenAnchor']=anchor
 shapes.append(shape)
(ROOT/'src/ui/map/traced-geometry.json').write_text(json.dumps(shapes,separators=(',',':')),encoding='utf8')
# Boundary audit image is a development artifact, never the production background.
source=cv2.imdecode(np.frombuffer((ROOT/'public/assets/final-map.png').read_bytes(),np.uint8),cv2.IMREAD_COLOR)
edges=np.zeros((h,w),np.uint8)
edges[1:] |= (labels[1:]!=labels[:-1]).astype(np.uint8)
edges[:,1:] |= (labels[:,1:]!=labels[:,:-1]).astype(np.uint8)
source[edges>0]=(80,255,255)
cv2.imencode('.png',source)[1].tofile(str(ROOT/'map-work/boundary-audit.png'))
print(f'Generated {len(shapes)} shapes, {len(regions)} logical regions')
