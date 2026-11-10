import {mkdir,readFile,writeFile,copyFile,cp,stat} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {homedir} from 'node:os';
import {join} from 'node:path';
const option=process.argv.indexOf('--profile'),profile=option<0?'desktop':process.argv[option+1];
if(!/^[\w-]+$/.test(profile))throw Error('无效 profile 名称');
const home=process.env.DSH_HOME||join(homedir(),'.dsh'),dir=join(home,'profiles',profile),patch=join(dir,'cordis.patch.yml'),entry=fileURLToPath(new URL('./index.mjs',import.meta.url)).replaceAll('\\','/');
await mkdir(dir,{recursive:true});
let text='';try{text=await readFile(patch,'utf8');await copyFile(patch,patch+'.backup-'+Date.now());}catch(e){if(e.code!=='ENOENT')throw e;}
text=text.replace(/^\s*\[\]\s*$/m,'');
if(/id:\s*qian-music\b/.test(text)){
 const pattern=/(id:\s*qian-music\s*\r?\n\s*name:\s*)[^\r\n]+/;
 if(!pattern.test(text))throw Error('已有千小姐配置格式不同，请在插件管理器中移除旧条目后重试。');
 text=text.replace(pattern,(_m,prefix)=>prefix+JSON.stringify(entry));
}else text+='\n- insert:\n    - id: qian-music\n      name: '+JSON.stringify(entry)+'\n';
if(!text.includes('provider: qian-omni'))text+='\n- id: agent-default-model\n  config:\n    provider: qian-omni\n    model: qwen3.8-omni-flash\n';
await writeFile(patch,text);
const skillTarget=join(home,'skills','qian-music');
try{await stat(skillTarget);await cp(skillTarget,join(home,'skill-backups','qian-music-'+Date.now()),{recursive:true});}catch(e){if(e.code!=='ENOENT')throw e;}
await cp(fileURLToPath(new URL('./skills/qian-music',import.meta.url)),skillTarget,{recursive:true});
console.log('已安装 qian-music Skill，含可选网易云登录与完整音乐操作指南。');
console.log('已配置 '+profile+'。重启 DSH 后，在底部展开播放器并启用播放。');
console.log('模型 Key：设置环境变量 QIAN_OMNI_API_KEY，或运行 pwsh -File ./setup-key.ps1 隐藏输入并加密保存。');
console.log('配置目录：'+home+'\n插件需保留在解压位置，移动后重新运行安装脚本。');
