/** Delta only between consecutive snapshots for the same connection and visibility. */
export function encodeSnapshot(previous,current,diff){
 const full=()=>JSON.stringify(current);
 if(!previous||!current.room||current.room.serverId!==previous.room.serverId||current.state?.gameId!==previous.state?.gameId||JSON.stringify(current.room.access)!==JSON.stringify(previous.room.access)||(current.room.access.kind!=='gm'&&current.state?.viewSeat!==previous.state?.viewSeat))return full();
 const patch=previous.state===current.state?[]:diff(previous.state,current.state);
 const infoPatch=diff(previous.info,current.info);
 const {state,info,...rest}=current;
 let chatDelta={};
 if(current.room.chat){const {chat,...room}=current.room;rest.room=room;chatDelta={chatPatch:previous.room.chat===chat?[]:diff(previous.room.chat??[],chat)};}
 const encoded=JSON.stringify({...rest,...chatDelta,baseEpoch:previous.room.epoch,baseSequence:previous.room.sequence,statePatch:patch,infoPatch});
 // Small or entirely replaced states may be cheaper to send whole.
 return patch.length?(()=>{const whole=full();return encoded.length<whole.length?encoded:whole;})():encoded;
}
