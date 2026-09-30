"""Reproduce the step-six subset from the audited workbook, without changing it."""
from pathlib import Path
import json
import openpyxl

ROOT = Path(__file__).resolve().parents[1]
INDICES = {13, 23, 25, 36, 41, 51, 59, 65, 77, 83, 90, 104, 114, 125,
           129, 134, 136, 158, 162, 164, 171, 188, 201, 213, 224, 235, 243}
SEATS = {'英国': 'united_kingdom', '苏联': 'soviet_union', '美国': 'united_states',
         '德国': 'germany', '日本': 'japan', '意大利': 'italy'}
COUNTRIES = {**SEATS, '法国': 'france', '中共': 'china', '民国': 'china'}
workbook = openpyxl.load_workbook(ROOT / 'docs/sources/战场军需官-卡牌文本审计-定稿版.xlsx',
                                read_only=True, data_only=True)
cards = []
for row in workbook['全量卡牌索引'].iter_rows(min_row=4, values_only=True):
    if row[0] in INDICES:
        cards.append(dict(id=f'special_{row[0]}', sourceIndex=row[0],
                          deckOwner=next(v for k, v in SEATS.items() if row[1].startswith(k)),
                          country=COUNTRIES[row[2]], type=row[3], name=row[4], text=row[5]))
assert len(cards) == len(INDICES)
workbook.close()
(ROOT / 'src/data/representative-cards.json').write_text(
    json.dumps(cards, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
