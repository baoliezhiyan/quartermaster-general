import {createHash} from 'node:crypto';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {dirname} from 'node:path';
export function validReference(envelope,observation){
 const d=envelope?.data,r=observation.reference;
 return !!d&&d.id===r.id&&d.version===r.version&&d.rulesFingerprint===r.rulesFingerprint&&d.gameVersion===observation.gameVersion&&d.interfaceVersion===observation.interfaceVersion&&envelope.digest===createHash('sha256').update(JSON.stringify(d)).digest('hex');
}
export async function cachedReference(path,observation,fetchReference){
 let cached;try{cached=JSON.parse(await readFile(path,'utf8'));}catch{}
 if(validReference(cached,observation))return cached;
 const fresh=await fetchReference(observation.reference.id);
 if(!validReference(fresh,observation))throw Object.assign(Error('静态资料版本或摘要不匹配，未使用旧资料'),{code:'REFERENCE_MISMATCH'});
 await mkdir(dirname(path),{recursive:true});await writeFile(path,JSON.stringify(fresh),'utf8');return fresh;
}
