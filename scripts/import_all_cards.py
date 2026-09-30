"""Extract the audited full catalog without modifying the source workbook."""
from pathlib import Path
from collections import Counter
import hashlib
import json
import openpyxl

ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / 'docs/sources/战场军需官-卡牌文本审计-定稿版.xlsx'
SEATS = {'英国': 'united_kingdom', '苏联': 'soviet_union', '美国': 'united_states',
         '德国': 'germany', '日本': 'japan', '意大利': 'italy'}
COUNTRIES = {**SEATS, '法国': 'france', '中共': 'china', '民国': 'china'}

def extract():
    workbook = openpyxl.load_workbook(SOURCE, read_only=True, data_only=True)
    cards = []
    for row in workbook['全量卡牌索引'].iter_rows(min_row=4, values_only=True):
        if not isinstance(row[0], int):
            continue
        assert row[4] != '马奇诺防线', 'Banned card present in audited catalog'
        assert row[3] in {'状态', '响应', '增强', '事件', '经济战'}
        assert row[4] and row[5]
        cards.append(dict(id=f'special_{row[0]}', sourceIndex=row[0],
                          deckOwner=next(v for k, v in SEATS.items() if row[1].startswith(k)),
                          country=COUNTRIES[row[2]], type=row[3], name=row[4], text=row[5]))
    workbook.close()
    # Apply explicit user revisions even when reimporting the preserved original workbook.
    overrides = json.loads((ROOT / 'src/data/card-rule-overrides.json').read_text(encoding='utf-8'))
    for card in cards:
        card.update(overrides['cards'].get(card['id'], {}))
    assert [c['sourceIndex'] for c in cards] == list(range(1, 246))
    assert Counter(c['deckOwner'] for c in cards) == dict(united_kingdom=41, soviet_union=36,
        united_states=48, germany=45, japan=39, italy=36)
    return cards

if __name__ == '__main__':
    cards = extract()
    (ROOT / 'src/data/all-cards.json').write_text(json.dumps(cards, ensure_ascii=False, indent=2)+'\n', encoding='utf-8')
    (ROOT / 'src/data/card-source.json').write_text(json.dumps(dict(file=SOURCE.name,
        sheet='全量卡牌索引', sha256=hashlib.sha256(SOURCE.read_bytes()).hexdigest(), count=len(cards), rulesOverrides='card-rule-overrides.json'),
        ensure_ascii=False, indent=2)+'\n', encoding='utf-8')
