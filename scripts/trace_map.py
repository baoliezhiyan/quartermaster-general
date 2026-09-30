"""Extract vector hit geometry from the approved raster; never modifies that raster.

Developer tool only: install opencv-python-headless and scipy in .tools/map-trace.
The reviewed graph in src/data/map.json remains the sole adjacency authority.
"""
from pathlib import Path
import sys
ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / '.tools/map-trace'))
import cv2
import numpy as np
import json

SEEDS = {
 'canada': (50,70), 'united_states': (50,225), 'latin_america': (180,650),
 'iceland': (319,24), 'british_isles': (391,111), 'scandinavia': (535,30),
 'western_europe': (394,328), 'germany': (545,253), 'italy': (494,285),
 'balkans': (575,277), 'eastern_europe': (620,221), 'ukraine': (711,233),
 'ross_region': (680,40), 'moscow': (839,155), 'siberia': (1050,95),
 'kazakhstan': (935,304), 'mongolia': (1112,180), 'vladivostok': (1325,120),
 'middle_east': (829,381), 'india': (1017,500), 'western_china': (1085,315),
 'eastern_china': (1186,388), 'southeast_asia': (1094,456), 'japan': (1350,278),
 'philippines': (1253,479), 'indonesia': (1130,556), 'new_guinea': (1386,640),
 'iwo_jima': (1385,399), 'hawaii': (1532,387), 'australia': (1280,805),
 'new_zealand': (1476,829), 'north_africa': (494,452), 'south_africa': (585,669),
 'madagascar': (698,770),
 'sea_north_atlantic': (210,310), 'sea_mid_atlantic': (350,700),
 'sea_south_atlantic': (407,811), 'sea_southeast_pacific': (25,570),
 'sea_north_sea': (307,226), 'sea_baltic': (536,157),
 'sea_mediterranean': (610,425), 'sea_black': (707,316), 'sea_caspian': (783,291),
 'sea_arabian': (901,617), 'sea_indian': (1005,777), 'sea_south_china': (1223,570),
 'sea_east_china': (1306,443), 'sea_north_pacific': (1533,267),
 'sea_central_pacific': (1450,550), 'sea_south_pacific': (1475,710),
 'sea_east_pacific': (1663,650),
 'canada-east': (1690,97), 'united_states-east': (1685,227), 'latin_america-east': (1719,378),
}

def main():
    image = cv2.imdecode(np.frombuffer((ROOT/'public/assets/final-map.png').read_bytes(), np.uint8), cv2.IMREAD_COLOR)
    b,g,r = image.astype(float).transpose(2,0,1)
    barrier = ((image.max(axis=2) < 48) | ((r>130)&(g<100)&(b<80))).astype(np.uint8)
    barrier = cv2.morphologyEx(barrier, cv2.MORPH_CLOSE, np.ones((3,3), np.uint8))
    land = r > b * .98
    # Color transition closes any ink gaps at coastlines, without changing the picture.
    coast = cv2.morphologyEx(land.astype(np.uint8), cv2.MORPH_GRADIENT, np.ones((3,3),np.uint8))
    # Ink provides the coastline; color texture alone would split narrow islands.
    count, components, stats, _ = cv2.connectedComponentsWithStats(1-barrier, connectivity=4)
    results = {}
    for key, (x,y) in SEEDS.items():
        cid = int(components[y,x])
        results[key] = {'component':cid, 'area':int(stats[cid,4]), 'box':stats[cid,:4].tolist()}
    (ROOT/'map-work/components.json').write_text(json.dumps(results,indent=2),encoding='utf-8')
    np.savez_compressed(ROOT/'map-work/components.npz', components=components, barrier=barrier)
    print(json.dumps(results,indent=2))

if __name__ == '__main__':
    main()
