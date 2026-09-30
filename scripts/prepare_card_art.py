"""Prepare supplied card illustrations without modifying source images."""
import argparse
import hashlib
import json
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont, ImageOps

BASIC = {'建设陆军', '建设海军', '发起陆战', '发起海战', '空中力量'}
CATEGORY = {'事件', '响应', '增强', '经济战', '状态', '历史', '军备'}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('source', type=Path)
    parser.add_argument('--output', type=Path, default=Path('outputs/card-art-v1.3'))
    args = parser.parse_args()
    records = []
    for folder in sorted(args.source.iterdir()):
        if not folder.is_dir():
            continue
        for source in sorted(folder.iterdir()):
            if source.suffix.lower() not in {'.png', '.jpg', '.jpeg', '.webp'}:
                continue
            kind = next((name for name in BASIC | CATEGORY if source.stem.endswith(name)), None)
            if kind is None:
                continue
            basic = kind in BASIC
            height = 139 if basic else 104
            original = ImageOps.exif_transpose(Image.open(source)).convert('RGB')
            width, original_height = original.size
            # All supplied illustrations are taller than the target aspect ratio.
            # Crop vertically only; preserve category headings at the top.
            crop_height = width * height / 174
            if crop_height > original_height + 1e-6:
                raise ValueError(f'Image too short for width-only scaling: {source}')
            top = (original_height - crop_height) / 2 if basic else 0
            box = (0, top, width, top + crop_height)
            relative = Path(folder.name) / (source.stem + '.png')
            for scale, directory in [(1, '标准尺寸'), (2, '双倍清晰尺寸')]:
                target = args.output / directory / relative
                target.parent.mkdir(parents=True, exist_ok=True)
                original.resize((174 * scale, height * scale), Image.Resampling.LANCZOS, box=box).save(target, optimize=True)
            records.append({'file': relative.as_posix(), 'deckFolder': folder.name,
                            'type': kind, 'spec': '基础牌' if basic else '类别牌',
                            'source': str(source), 'sourceSize': [width, original_height],
                            'sourceSHA256': hashlib.sha256(source.read_bytes()).hexdigest(),
                            'cropBox': list(box), 'displaySize': [174, height],
                            'highResolutionSize': [348, height * 2],
                            'cropAnchor': 'center' if basic else 'top'})
    args.output.mkdir(parents=True, exist_ok=True)
    (args.output / '图片处理清单.json').write_text(json.dumps(records, ensure_ascii=False, indent=2), encoding='utf-8')
    font = ImageFont.truetype('C:/Windows/Fonts/msyh.ttc', 12)
    sheet = Image.new('RGB', (6 * 190, ((len(records) + 5) // 6) * 170), '#e9e6df')
    draw = ImageDraw.Draw(sheet)
    for index, record in enumerate(records):
        image = Image.open(args.output / '标准尺寸' / record['file'])
        x, y = (index % 6) * 190 + 10, (index // 6) * 170 + 5
        sheet.paste(image, (x, y))
        draw.text((x, y + 141), Path(record['file']).stem, font=font, fill='#222222')
    sheet.save(args.output / '处理后总览.jpg', quality=95)
    for record in records:
        for scale, directory in [(1, '标准尺寸'), (2, '双倍清晰尺寸')]:
            with Image.open(args.output / directory / record['file']) as image:
                assert image.size == tuple(value * scale for value in record['displaySize'])
                image.load()
        assert hashlib.sha256(Path(record['source']).read_bytes()).hexdigest() == record['sourceSHA256']
    counts = {name: sum(r['spec'] == name for r in records) for name in ['基础牌', '类别牌']}
    print(json.dumps({'count': len(records), 'specCounts': counts}, ensure_ascii=True))


if __name__ == '__main__':
    main()
