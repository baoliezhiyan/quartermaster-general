import {readFile,writeFile,readdir} from 'node:fs/promises';
import {createHash} from 'node:crypto';
async function fingerprint(dirs){const h=createHash('sha256');async function walk(path){for(const e of (await readdir(path,{withFileTypes:true})).sort((a,b)=>a.name.localeCompare(b.name))){const file=path+'/'+e.name;if(file==='src/matchLog/build-identity.json')continue;if(e.isDirectory())await walk(file);else{h.update(file);h.update(await readFile(file));}}}for(const d of dirs)await walk(d);return h.digest('hex');}
await writeFile('src/matchLog/build-identity.json',JSON.stringify({rulesFingerprint:await fingerprint(['src/core','src/data']),buildFingerprint:await fingerprint(['src','scripts'])},null,2)+'\n');
