import {memo,useEffect,useState} from 'react';
import {cardArtCache} from './cardArtCache';

export const CardArtImage=memo(function CardArtImage({src,basic}:{src:string;basic:boolean}){
 const [image,setImage]=useState<{src:string;url:string}>();
 useEffect(()=>{
  let active=true;
  void cardArtCache.load(src).then(url=>{if(active)setImage({src,url});},()=>{if(active)setImage({src,url:src});});
  return ()=>{active=false;};
 },[src]);
 return <img className={`card-art ${basic?'card-art-basic':'card-art-category'}`} src={cardArtCache.peek(src)??(image?.src===src?image.url:undefined)} alt="" draggable={false}/>;
});
