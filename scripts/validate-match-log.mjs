import {readFile} from 'node:fs/promises';
import {existsSync} from 'node:fs';
const modulePath=new URL(existsSync(new URL('../dist-server/Room.mjs',import.meta.url))?'../dist-server/Room.mjs':'../dist-server/Room.js',import.meta.url);
const {parseMatchLog,MATCH_LOG_GAME_VERSION}=await import(modulePath.href);
const file=process.argv[2];if(!file){console.error('用法：node scripts/validate-match-log.mjs <JSONL文件> [客户端gameVersion]');process.exit(2);}
try{const a=await parseMatchLog(await readFile(file,'utf8'),process.argv[3]??MATCH_LOG_GAME_VERSION);console.log(JSON.stringify({valid:true,format:a.header.format,formatVersion:a.header.formatVersion,recordingId:a.header.recordingId,recordingRevision:a.header.recordingRevision,mode:a.header.mode,origin:a.header.origin,frames:a.end.frameCount,decisions:a.end.decisionCount,stopReason:a.end.stopReason,integrity:'verified',rulesReexecuted:false},null,2));}catch(e){console.error(JSON.stringify({valid:false,error:e.message}));process.exitCode=1;}
