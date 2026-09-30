"""Convert the reviewed workbook to deterministic map data; never infer topology from art."""
from pathlib import Path
import hashlib
import json
import re
import openpyxl

ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / 'docs/sources/战场军需官-地图数据审核表.xlsx'
OUTPUT = ROOT / 'src/data/map.json'
COUNTRIES = {
    '德国': 'germany', '英国': 'united_kingdom', '日本': 'japan',
    '苏联': 'soviet_union', '意大利': 'italy', '美国': 'united_states',
    '法国': 'france', '中国': 'china',
}


def convert():
    workbook = openpyxl.load_workbook(SOURCE, read_only=True, data_only=True)
    regions = []
    for rid, name, kind, supply, home, opening, notes in list(workbook['地区属性'].values)[4:]:
        if not rid:
            continue
        regions.append({
            'id': rid, 'name': name, 'type': 'LAND' if kind == '陆地' else 'SEA',
            'supply': supply == '是', 'homeCountry': COUNTRIES.get(home),
            'initialArmyCountry': COUNTRIES.get(str(opening).removesuffix('陆军×1')),
            'notes': notes or '',
        })
    names = {r['name']: r['id'] for r in regions}
    straits = []
    for sid, name, land, a, b, controller, _ in list(workbook['海峡'].values)[4:]:
        if sid:
            straits.append({
                'id': sid, 'name': name, 'landRegion': names[land],
                'seaA': names[a], 'seaB': names[b],
                'defaultController': 'axis' if controller == '轴心国' else 'allies',
            })
    conditional = {tuple(sorted([s['seaA'], s['seaB']])) for s in straits}
    directed = set()
    for name, neighbors in list(workbook['邻接审核'].values)[4:]:
        if not name:
            continue
        for neighbor in neighbors.split('、'):
            neighbor = re.sub(r'（海峡）', '', neighbor).strip()
            pair = (names[name], names[neighbor])
            if pair in directed or pair[0] == pair[1]:
                raise ValueError(f'Duplicate/self adjacency: {pair}')
            directed.add(pair)
    assert all((b, a) in directed for a, b in directed), 'Asymmetric adjacency in source'
    edges = sorted({tuple(sorted(pair)) for pair in directed})
    assert conditional.issubset(set(edges))
    assert len(regions) == 51 and len(edges) == 132
    assert sum(r['type'] == 'LAND' for r in regions) == 34
    assert sum(r['supply'] for r in regions) == 12
    assert sum(bool(r['homeCountry']) for r in regions) == 8
    data = {
        'version': '1.2',
        'source': SOURCE.name,
        'sourceSha256': hashlib.sha256(SOURCE.read_bytes()).hexdigest(),
        'regions': regions,
        'baseEdges': [list(edge) for edge in edges if edge not in conditional],
        'straits': straits,
    }
    OUTPUT.write_text(json.dumps(data, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    print(f'Imported {len(regions)} regions, {len(data["baseEdges"])} permanent edges, {len(straits)} straits.')


if __name__ == '__main__':
    convert()
