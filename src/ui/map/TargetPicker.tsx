import { useState } from 'react';
import type { MapTarget } from './targetChoices';
import { REGION_BY_ID } from '../../core/map';

export function TargetPicker({ options, pickedRegion, busy, onConfirm, onClear }: {
  options: readonly MapTarget[]; pickedRegion: string | null; busy: boolean;
  onConfirm: (id: string) => void; onClear: () => void;
}) {
  const [optionId, setOptionId] = useState('');
  const candidates = options.filter(o => o.regionId === pickedRegion);
  const selected = candidates.length === 1 ? candidates[0] : candidates.find(o => o.id === optionId);
  return <div className="map-target-picker">
    <p>{candidates.length ? `已选择：${REGION_BY_ID[pickedRegion!].name}` : '请点击地图上的绿色地区。黄色表示已选目标，确认前不会执行。'}</p>
    {candidates.length > 1 && <fieldset><legend>此地区有多个方案，请选择</legend>{candidates.map(o => <label key={o.id}><input type="radio" name="map-action-option" checked={selected?.id === o.id} onChange={() => setOptionId(o.id)} disabled={busy} />{o.label}</label>)}</fieldset>}
    <div className="turn-actions"><button className="primary" disabled={busy || !selected} onClick={() => selected && onConfirm(selected.id)}>确认{selected ? `：${selected.label}` : '选择'}</button><button disabled={busy || !pickedRegion} onClick={() => { setOptionId(''); onClear(); }}>取消选择</button></div>
  </div>;
}
