import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {dirname,resolve} from 'node:path';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
console.log('本机 AI 接口已启用。先在普通客户端创建 AI 用户、入座并绑定同阵营国家，再配置 local-ai-private/session.json。\n命令：node scripts/local-ai-cli.mjs connect / status / observe / wait / submit。\n不会自动创建游戏、绑定座位或调用模型。连接及绑定状态可随时用 status 查看。');
const child=spawn(process.execPath,[resolve(root,'scripts/multiplayer-server.mjs'),...(process.argv.includes('--open')?['--open']:[])],{cwd:root,env:{...process.env,QM_LOCAL_AI:'1'},stdio:'inherit',windowsHide:true});child.on('exit',code=>{process.exitCode=code??1;});process.on('SIGINT',()=>child.kill());
