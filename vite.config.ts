import { defineConfig, configDefaults } from 'vitest/config';
// @ts-ignore Build runs in Node; the application only includes browser typings.
import {readFileSync,existsSync} from 'node:fs';
// @ts-ignore Build runs in Node; the application only includes browser typings.
import {createHash} from 'node:crypto';
const images=JSON.parse(readFileSync('src/data/card-art.json','utf8')) as Record<string,string>;
const artHashes=Object.fromEntries(Object.values(images).map(src=>[src,createHash('sha256').update(readFileSync('public'+src)).digest('hex')]));

export default defineConfig({
  base: './',
  // Historical comparisons require separately supplied, untracked baseline sources.
  test:{exclude:[...configDefaults.exclude,...[['global','global-performance'],['room','room-optimization'],['view','view-performance']].filter(([,folder])=>!existsSync('outputs/'+folder+'/baseline/src')).map(([name])=>'tests/'+name+'-optimization.test.ts')]},
  define:{__CARD_ART_HASHES__:JSON.stringify(artHashes)},
  server: { port: 5173, strictPort: true, proxy:{'/api':{target:'http://127.0.0.1:4183',changeOrigin:true}} },
  preview: { port: 4173, strictPort: true },
});
