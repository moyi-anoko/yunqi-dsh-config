import {spawn} from 'node:child_process';
import {join} from 'node:path';
import {mkdir} from 'node:fs/promises';
import {privateRoot,pluginRoot} from './lib/config.mjs';
const root=join(privateRoot(),'bilibili'),venv=join(root,'venv');await mkdir(root,{recursive:true});
async function run(command,args){await new Promise((yes,no)=>{const p=spawn(command,args,{stdio:'inherit',windowsHide:true});p.on('error',no);p.on('exit',code=>code===0?yes():no(Error('B站依赖安装失败，请查看上述提示；音乐功能不受影响。')));});}
const option=process.argv.indexOf('--python'),python=option<0?'python':process.argv[option+1];
await run(python,['-m','venv',venv]);
const executable=join(venv,process.platform==='win32'?'Scripts/python.exe':'bin/python');
await run(executable,['-m','pip','install','-r',join(pluginRoot,'bilibili','requirements.txt')]);
console.log('B站运行环境已就绪。在DSH内调用 qian_bili_login，或展开播放器的“B站账号”扫码。');
