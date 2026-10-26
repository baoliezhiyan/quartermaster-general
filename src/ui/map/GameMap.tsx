import {useCardArtHidden,toggleCardArt} from '../cardDisplay';
import {LayoutControl,useCompactLayout,layoutSize,localPointer} from '../deviceLayout';
import {CardEncyclopedia} from '../CardEncyclopedia';
import {UnitArt} from '../UnitArt';
import { useEffect, useMemo, useRef, useState } from 'react';
import type { PointerEvent, ReactNode } from 'react';
import { getNeighbors, REGION_BY_ID, REGIONS, STRAITS, straitController } from '../../core/map';
import type { AdjacencyContext } from '../../core/map';
import type { Alliance, CountryId, ReadState } from '../../core';
import { landControllers as occupiedLand, suppliedUnits, adjacent as rulesAdjacent } from '../../core/supply';
import { homeRegion, supplySource } from '../../core/modifiers';
import { UNIT_NAMES } from '../../core/basic';
import { MAP_SHAPES, MAP_WIDTH, MAP_HEIGHT, TOKEN_DIAMETER } from './geometry';
import type { RegionShape } from './geometry';
import { clampPan, stepZoom, isPanGesture } from './camera';
import { unitStacks } from './unitStacks';

const COUNTRY_NAMES: Record<CountryId, string> = {
  germany: '德国', united_kingdom: '英国', japan: '日本', soviet_union: '苏联',
  italy: '意大利', united_states: '美国', france: '法国', china: '中国',
};
const ALL_SHAPES = MAP_SHAPES;

export function GameMap({ alliance, game, legalRegions = [], onChooseRegion, selectedRegion, selectedRegions=[], targeting=false, children, footer, scoreboard, legalUnitIds=[],selectedUnitIds=[],onChooseUnit,onStandardView }: { alliance: Alliance; game?: ReadState | null; legalRegions?: readonly string[]; onChooseRegion?: (regionId: string | null) => void; selectedRegion?:string|null; selectedRegions?:readonly string[]; targeting?:boolean; children?:ReactNode; footer?:ReactNode; scoreboard?:ReactNode;legalUnitIds?:string[];selectedUnitIds?:string[];onChooseUnit?:(id:string)=>void;onStandardView?:()=>void }) {
  const compact=useCompactLayout();
  const hideCardArt=useCardArtHidden();
  const [toolsOpen,setToolsOpen]=useState(false);
  const touches=useRef(new Map<number,{x:number;y:number}>());
  const pinch=useRef<{distance:number;zoom:number;world:{x:number;y:number}}|null>(null);
  const [encyclopedia,setEncyclopedia]=useState(false);
  const [localSelected, setSelected] = useState<string | null>(null);
  const selected = selectedRegion === undefined ? localSelected : selectedRegion;
  const [info, setInfo] = useState<{id:string;left:string}|null>(null);
  const stage = useRef<HTMLDivElement>(null);
  const closeInfo = useRef<HTMLButtonElement>(null);
  useEffect(()=>{if(info) closeInfo.current?.focus();},[info]);
  const [hovered, setHovered] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [zoom, setZoom] = useState(.8);
  const [viewLocked,setViewLocked]=useState(false);
  const [boundaries, setBoundaries] = useState(false);
  const [pageExpanded,setPageExpanded]=useState(false);
  const [nativeFullscreen,setNativeFullscreen]=useState(false);
  const fullscreen=pageExpanded||nativeFullscreen;
  const fullscreenRoot = useRef<HTMLElement>(null);
  
  const [fullscreenBusy, setFullscreenBusy] = useState(false);
  useEffect(()=>{
    const sync=()=>setNativeFullscreen(document.fullscreenElement===fullscreenRoot.current);
    document.addEventListener('fullscreenchange',sync);
    return ()=>document.removeEventListener('fullscreenchange',sync);
  },[]);
  const toggleFullscreen=async()=>{
    setFullscreenBusy(true);
    try{
      if(pageExpanded){setPageExpanded(false);return;}
      if(document.fullscreenElement===fullscreenRoot.current){await document.exitFullscreen();return;}
      try{
        const root=fullscreenRoot.current;
        if(!root?.requestFullscreen||document.fullscreenEnabled===false)throw new Error('unsupported');
        await root.requestFullscreen();
      }catch{setPageExpanded(true);}
    }catch{
      // If a native exit is rejected, leave the active mode and its exit control intact.
      setNativeFullscreen(document.fullscreenElement===fullscreenRoot.current);
    }finally{setFullscreenBusy(false);}
  };
  const phaseFooter = useRef<HTMLDivElement>(null);
  useEffect(()=>{
    if(!fullscreen)return;
    const previous=document.body.style.overflow;
    document.body.style.overflow='hidden';
    const escape=(event:KeyboardEvent)=>{
      if(event.key==='Escape'){setPageExpanded(false);if(document.fullscreenElement===fullscreenRoot.current)void document.exitFullscreen().catch(()=>{});}
    };
    window.addEventListener('keydown',escape);
    return ()=>{document.body.style.overflow=previous;window.removeEventListener('keydown',escape);};
  },[fullscreen]);

  const viewport = useRef<HTMLDivElement>(null);
  useEffect(()=>{
    const view=viewport.current;
    if(!fullscreen||!view)return;
    let lastStep=-Infinity;
    const wheel=(event:WheelEvent)=>{
      if(!event.deltaY)return;
      event.preventDefault();
      if(viewLocked)return;
      const now=performance.now();
      if(now-lastStep<80)return;
      lastStep=now;
      setZoom(value=>stepZoom(value,event.deltaY<0?1:-1));
    };
    view.addEventListener('wheel',wheel,{passive:false});
    return ()=>view.removeEventListener('wheel',wheel);
  },[fullscreen,viewLocked]);
  const [size, setSize] = useState({width:0,height:0});
  const [leftAligned,setLeftAligned]=useState(true);

  const [pan, setPan] = useState({x:0,y:0});
  const toolbar = useRef<HTMLDivElement>(null);
  const drag = useRef<{ x:number;y:number;pan:{x:number;y:number};moved:boolean;button:number;regionId:string|null } | null>(null);
  const suppressClick = useRef(false);
  const scale = size.width / MAP_WIDTH * zoom;
  const boundedPan = leftAligned?{x:MAP_WIDTH/2-MAP_WIDTH/(2*zoom),y:0}:clampPan(pan, size, zoom);
  useEffect(()=>{
    const view=viewport.current;
    if(!view)return;
    const measure=()=>{
      const currentStage=stage.current;
      if(!currentStage||!view.isConnected)return;
      const box=currentStage.getBoundingClientRect();
      const top=box.top+(fullscreen?0:window.scrollY);
      view.style.height=`${Math.max(fullscreen||compact?80:320,layoutSize().height-top-(phaseFooter.current?.offsetHeight??0)-(fullscreen?0:8))}px`;
      setSize({width:view.clientWidth,height:view.clientHeight});
    };
    const observer=new ResizeObserver(measure);
    observer.observe(view);
    observer.observe(toolbar.current!);
    observer.observe(document.querySelector('.topbar')??view);
    if(phaseFooter.current)observer.observe(phaseFooter.current);
    window.addEventListener('resize',measure);window.visualViewport?.addEventListener('resize',measure);measure();
    return ()=>{observer.disconnect();window.removeEventListener('resize',measure);window.visualViewport?.removeEventListener('resize',measure);};
  },[fullscreen,compact]);
  useEffect(()=>{setPan(p=>clampPan(p,size,zoom));},[size,zoom]);
  const context: AdjacencyContext = useMemo(() => ({alliance,landControllers:game?occupiedLand(game):{}}), [alliance,game]);
  const supplied = useMemo(() => game ? suppliedUnits(game) : new Set<string>(), [game]);
  const stacks = useMemo(()=>unitStacks(game?.units??[]),[game?.units]);
  const neighbors = useMemo(() => info ? game ? REGIONS.filter(r=>rulesAdjacent(game,game.viewSeat,info.id,r.id)).map(r=>r.id) : getNeighbors(info.id, context) : [], [info, context,game]);
  const region = info ? REGION_BY_ID[info.id] : null;
  const results = query.trim() ? REGIONS.filter(item => item.name.includes(query.trim())) : [];

  const selectRegion = (id: string, reveal = false) => {
    if (targeting && !legalRegions.includes(id)) return;
    const next = !reveal && selected === id ? null : id;
    setSelected(next);
    onChooseRegion?.(next);
    setQuery('');
    if (reveal) {
      const visual=ALL_SHAPES.find(item=>item.regionId===id&&!item.fragment);
      if(visual){setLeftAligned(false);setPan(clampPan({x:MAP_WIDTH/2-visual.label[0],y:MAP_HEIGHT/2-visual.label[1]},size,zoom));}
    }
  };
  const resetView = () => {if(viewLocked)return;setLeftAligned(false);setZoom(1);setPan({x:0,y:0});};
  const pointerPosition=(event:{clientX:number;clientY:number})=>localPointer(viewport.current!.getBoundingClientRect(),event.clientX,event.clientY);
  const showInfo = (id:string,x:number) => {
    selectRegion(id);
    const bounds=stage.current?.getBoundingClientRect();
    setInfo({id,left:bounds && x<size.width/2?'65%':'35%'});
  };
  const beginPan = (event: PointerEvent<HTMLDivElement>) => {
    if(event.button!==0 && event.button!==2)return;
    const point=pointerPosition(event);
    if(event.pointerType==='touch'){
      touches.current.set(event.pointerId,point);
      if(touches.current.size>=2){const [a,b]=[...touches.current.values()];pinch.current={distance:Math.max(1,Math.hypot(a.x-b.x,a.y-b.y)),zoom,world:{x:((a.x+b.x)/2-size.width/2)/scale-boundedPan.x,y:((a.y+b.y)/2-size.height/2)/scale-boundedPan.y}};drag.current=null;suppressClick.current=true;return;}
    }
    suppressClick.current=false;
    const target=event.target as Element;
    drag.current={x:point.x,y:point.y,pan:boundedPan,moved:false,button:event.button,regionId:target.closest('[data-region-id]')?.getAttribute('data-region-id')??null};
    if(event.button===2){event.preventDefault();event.currentTarget.setPointerCapture(event.pointerId);}
  };
  const movePan = (event: PointerEvent<HTMLDivElement>) => {
    const point=pointerPosition(event);
    if(event.pointerType==='touch'&&touches.current.has(event.pointerId)){
      touches.current.set(event.pointerId,point);
      if(pinch.current&&touches.current.size>=2){suppressClick.current=true;if(viewLocked)return;const [a,b]=[...touches.current.values()],p=pinch.current,next=Math.max(.5,Math.min(2,p.zoom*Math.hypot(a.x-b.x,a.y-b.y)/p.distance)),nextScale=size.width/MAP_WIDTH*next;setLeftAligned(false);setZoom(next);setPan(clampPan({x:((a.x+b.x)/2-size.width/2)/nextScale-p.world.x,y:((a.y+b.y)/2-size.height/2)/nextScale-p.world.y},size,next));return;}
    }
    const start=drag.current;
    if(!start || !event.buttons || !scale)return;
    if(viewLocked){if(isPanGesture(point.x-start.x,point.y-start.y))suppressClick.current=true;return;}
    const dx=point.x-start.x,dy=point.y-start.y;
    if(start.moved || isPanGesture(dx,dy)) {
      start.moved=true;suppressClick.current=true;
      event.currentTarget.setPointerCapture(event.pointerId);
      setLeftAligned(false);setPan(clampPan({x:start.pan.x+dx/scale,y:start.pan.y+dy/scale},size,zoom));
    }
  };
  const endPan = (event: PointerEvent<HTMLDivElement>) => {
    const point=pointerPosition(event);
    const start=drag.current;
    if(start?.button===2 && !start.moved && !isPanGesture(point.x-start.x,point.y-start.y) && start.regionId)showInfo(start.regionId,point.x);
    touches.current.delete(event.pointerId);
    if(pinch.current){suppressClick.current=true;if(touches.current.size<2)pinch.current=null;}
    drag.current=null;
    if(event.currentTarget.hasPointerCapture(event.pointerId))event.currentTarget.releasePointerCapture(event.pointerId);
  };

  const renderRegion = (visual: RegionShape) => {
    const info = REGION_BY_ID[visual.regionId];
    const active = selected === info.id || selectedRegions.includes(info.id);
    const land = info.type === 'LAND';
    return (
      <g key={visual.key} role="button" tabIndex={0}
        aria-label={`${info.name}${visual.fragment ? `（${visual.fragmentSide === 'left' ? '左' : '右'}侧跨图片段）` : ''}，${land ? '陆地' : '海域'}${info.supply ? '，补给点' : ''}`}
        aria-pressed={active} data-region-id={info.id} data-fragment={visual.fragment || undefined}
        className={`map-region ${land ? 'land' : 'sea'}${active ? ' is-selected' : ''}${hovered === info.id ? ' is-hovered' : ''}${legalRegions.includes(info.id) ? ' is-legal-target' : ''}`}
        onContextMenu={event => {
          event.preventDefault(); event.stopPropagation();
          if(event.button!==2)showInfo(info.id,pointerPosition(event).x);
        }}
        onClick={() => selectRegion(info.id)}
        onKeyDown={event => {
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            selectRegion(info.id);
          }
        }}
        onPointerEnter={() => setHovered(info.id)} onPointerLeave={() => setHovered(null)}>
        <title>{info.name} · {land ? '陆地' : '海域'}{info.homeCountry ? ` · ${COUNTRY_NAMES[info.homeCountry]}大本营` : ''}</title>
        <path className="region-area" d={visual.path} fillRule="evenodd" />
      </g>
    );
  };

  return (
    <section ref={fullscreenRoot} className={`game-map${fullscreen?' map-fullscreen':''}${pageExpanded?' map-page-expanded':''}`} aria-label="战略地图模块">
      <div className="map-toolbar" ref={toolbar}>
        <div><h3>战略地图</h3><button className="map-tool encyclopedia-toggle" aria-expanded={encyclopedia} onClick={()=>setEncyclopedia(v=>!v)}>全卡图鉴</button><span className="map-subtitle">左键选择 · 右键选择并查看详情／按住拖动</span></div>
        {scoreboard}
        <button className="compact-tools-toggle" aria-expanded={toolsOpen} onClick={()=>setToolsOpen(v=>!v)}>设置</button>
        <div className={`map-tools${toolsOpen?' tools-open':''}`}><LayoutControl/><button className="map-tool" aria-pressed={hideCardArt} onClick={toggleCardArt}>{hideCardArt?'开启卡图显示':'关闭卡图显示'}</button>
          <div className="map-search">
            <input aria-label="查找地图地区" placeholder="查找地区…" value={query} onChange={event => setQuery(event.target.value)}
              onKeyDown={event => {
                if (event.key === 'Enter' && results.length === 1) selectRegion(results[0].id, true);
                if (event.key === 'Escape') setQuery('');
              }} />
            {query.trim() && <div className="map-search-results" aria-label="地区搜索结果">
              {results.length ? results.map(item => <button key={item.id} onClick={() => selectRegion(item.id, true)}>{item.name}<small>{item.type === 'LAND' ? '陆地' : '海域'}</small></button>) : <p>没有匹配的地区</p>}
            </div>}
          </div>
          <div className="zoom-tools" aria-label="地图缩放">
            <button aria-label="缩小地图" disabled={viewLocked || zoom <= .5} onClick={() => setZoom(value => stepZoom(value,-1))}>−</button>
            <button aria-label="还原地图缩放" disabled={viewLocked} onClick={resetView}>{Math.round(zoom * 100)}%</button>
            <button aria-label="放大地图" disabled={viewLocked || zoom >= 2} onClick={() => setZoom(value => stepZoom(value,1))}>＋</button>
          </div>
          <button className="map-tool" aria-pressed={viewLocked} onClick={()=>{drag.current=null;setViewLocked(v=>!v);}}>视角锁定{viewLocked?' · 已开启':''}</button>
          <button className="map-tool" onClick={()=>{if(compact){setLeftAligned(false);setPan({x:0,y:0});}else{setLeftAligned(true);onStandardView?.();}}}>{compact?'居中视图':'标准视图'}</button>
          <button className={boundaries ? 'map-tool active' : 'map-tool'} aria-pressed={boundaries} onClick={() => setBoundaries(value => !value)}>边界显示</button>
          <button className="map-tool" disabled={fullscreenBusy} aria-pressed={fullscreen} title="优先使用浏览器全屏；不支持时在页面内展开游戏" onClick={()=>void toggleFullscreen()}>{pageExpanded?'退出展开':nativeFullscreen?'退出全屏':'全屏'}</button>
        </div>

      </div>
      <div className="map-stage" ref={stage}>
        {selected&&<button className="touch-region-detail" onClick={()=>setInfo({id:selected,left:'50%'})}>查看{REGION_BY_ID[selected]?.name}详情</button>}
        {compact&&legalUnitIds.length>0&&<details className="touch-unit-picker"><summary>选择部队（{selectedUnitIds.length} 已选）</summary>{game?.units.filter(u=>legalUnitIds.includes(u.id)).map(u=><button key={u.id} aria-pressed={selectedUnitIds.includes(u.id)} onClick={()=>onChooseUnit?.(u.id)}>{COUNTRY_NAMES[u.country]} · {UNIT_NAMES[u.type]} · {REGION_BY_ID[u.regionId]?.name}</button>)}</details>}
        {encyclopedia&&<CardEncyclopedia balance={game?.rules?.balanceEnabled??true}/> }
      <div className="map-viewport" ref={viewport} data-zoom={Math.round(zoom*100)} onPointerDown={beginPan} onPointerMove={movePan}
        onPointerUp={endPan} onPointerCancel={endPan} onLostPointerCapture={endPan}
        onContextMenu={event=>event.preventDefault()}
        onClickCapture={event => {
          if(suppressClick.current){event.preventDefault();event.stopPropagation();suppressClick.current=false;}
        }}>
        <div className="map-sheet" style={{width:size.width*zoom,height:size.width*zoom*MAP_HEIGHT/MAP_WIDTH,left:size.width/2+boundedPan.x*scale,top:size.height/2+boundedPan.y*scale}}>
          <svg className={`world-map${boundaries ? ' show-boundaries' : ''}`} viewBox={`0 0 ${MAP_WIDTH} ${MAP_HEIGHT}`} aria-label="战场军需官世界地图" xmlns="http://www.w3.org/2000/svg">
            <image href="/assets/final-map.png" width={MAP_WIDTH} height={MAP_HEIGHT} pointerEvents="none" />
            {ALL_SHAPES.map(renderRegion)}
            <g className="unit-layer" pointerEvents="none" aria-label="地图部队">{ALL_SHAPES.filter(s=>!s.fragment).map(visual=>{
              const regionStacks=stacks.filter(s=>s.regionId===visual.regionId);
              const markers=regionStacks.map(stack=>({country:stack.country,type:stack.top.type,ids:stack.members.map(u=>u.id),unsupplied:stack.members.some(u=>!supplied.has(u.id)),description:stack.members.map(u=>UNIT_NAMES[u.type]).join('、')}));
              return <g key={visual.key} data-token-region={visual.regionId}>{markers.slice(0,3).map((marker,index)=>{
                const point=visual.tokenSlots?.[index];if(!point)return null;
                return <g pointerEvents={marker.ids.some(id=>legalUnitIds.includes(id))?"auto":"none"} onClick={event=>{event.stopPropagation();const id=marker.ids.find(id=>legalUnitIds.includes(id));if(id)onChooseUnit?.(id);}} key={marker.country} data-unit-ids={marker.ids.join(',')} aria-label={`${COUNTRY_NAMES[marker.country]}${marker.description}，${REGION_BY_ID[visual.regionId].name}${marker.unsupplied?'，断补给':''}`} transform={`translate(${point[0]},${point[1]})`} className={`unit-token${marker.ids.some(id=>legalUnitIds.includes(id))?' unit-available':''}${marker.ids.some(id=>selectedUnitIds.includes(id))?' unit-selected':''}${marker.unsupplied?' unsupplied':''}`}>
                  <UnitArt country={marker.country} type={marker.type} size={TOKEN_DIAMETER} x={-TOKEN_DIAMETER/2} y={-TOKEN_DIAMETER/2}/><circle className="unit-ring" r={TOKEN_DIAMETER/2}/>{marker.ids.some(id=>selectedUnitIds.includes(id))&&<text className="unit-order" y={-TOKEN_DIAMETER/2-4} textAnchor="middle">{selectedUnitIds.findIndex(id=>marker.ids.includes(id))+1}</text>}
                </g>;
              })}{markers.length>3&&visual.tokenSlots?.[2]&&<text className="unit-overflow" x={visual.tokenSlots[2][0]} y={visual.tokenSlots[2][1]+24} textAnchor="middle">另有 {markers.length-3} 国 · 右键详情</text>}</g>;
            })}</g>
          </svg>
        </div>
      </div>
      {children}
      {info && <section className="region-info-dialog" role="dialog" aria-label="地区详情" style={{left:info!.left}} onKeyDown={e=>{if(e.key==='Escape')setInfo(null);}}><button ref={closeInfo} className="region-info-close" aria-label="关闭地区详情" onClick={()=>setInfo(null)}>×</button>
        {region ? <>
          <div className="region-summary"><span className="eyebrow">SELECTED REGION</span><h3>{region.name}<small>{region.type === 'LAND' ? '陆地' : '海域'}</small></h3>
            <p>{region.homeCountry ? `${COUNTRY_NAMES[region.homeCountry]}大本营 · ` : ''}{region.supply ? '补给点' : '非补给点'}{region.notes ? ` · ${region.notes}` : ''}</p>
            {game&&<p>当前规则：{(Object.keys(COUNTRY_NAMES) as CountryId[]).filter(c=>homeRegion(game,c)===region.id).map(c=>`${COUNTRY_NAMES[c]}大本营`).join('、')||'非大本营'}；补给适用：{(Object.keys(COUNTRY_NAMES) as CountryId[]).filter(c=>supplySource(game,c,region.id,region.supply)).map(c=>COUNTRY_NAMES[c]).join('、')||'无'}。</p>}
            <div className="region-units"><h4>当前部队</h4>{game?.units.some(u=>u.regionId===region.id) ? <ul>{(Object.keys(COUNTRY_NAMES) as CountryId[]).map(country=>{
              const units=game.units.filter(u=>u.regionId===region.id&&u.country===country);
              return units.length ? <li key={country}>{COUNTRY_NAMES[country]}：{(['army','navy','air'] as const).flatMap(type=>{
                return units.some(u=>u.type===type) ? [UNIT_NAMES[type]] : [];
              }).join('、')}</li> : null;
            })}</ul> : <p>无部队</p>}</div>
          </div>
          <div className="neighbor-details"><h4>当前相邻 <span>{neighbors.length}</span></h4><div className="neighbor-list">{neighbors.map(id => <button key={id} onClick={() => setInfo(previous=>previous?{...previous,id}:null)}>{REGION_BY_ID[id].name}</button>)}</div>
            {STRAITS.filter(strait => [strait.seaA, strait.seaB].includes(region.id) || strait.landRegion === region.id).map(strait => <p className="strait-explanation" key={strait.id}>{strait.name} · {REGION_BY_ID[strait.landRegion].name}控制 · {(game?rulesAdjacent(game,game.viewSeat,strait.seaA,strait.seaB):straitController(strait, context) === alliance) ? '本阵营可通过' : '本阵营不可通过'}</p>)}
          </div>
        </> : <p className="map-hint">选择任一陆地或海域，查看补给点、大本营和当前阵营的邻接关系。</p>}
      </section>}
      </div>
      <div className="map-footer" ref={phaseFooter}>{footer ?? <div className="map-phase-panel"><p>右键地图地区查看详情。</p></div>}</div>
    </section>
  );
}
