import {readFileSync,existsSync,mkdirSync,writeFileSync,statSync} from 'node:fs';
import {join,dirname} from 'node:path';
import {homedir} from 'node:os';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
export const pluginRoot=fileURLToPath(new URL('../',import.meta.url));
export function privateRoot(){return process.env.QIAN_CONFIG_DIR||join(process.env.DSH_HOME||join(homedir(),'.dsh'),'qian-music');}
export function config(){const file=join(privateRoot(),'config.json');const {musicRoomURL,...saved}=existsSync(file)?JSON.parse(readFileSync(file,'utf8')):{};return {baseURL:'https://dashscope.aliyuncs.com/compatible-mode/v1',model:'qwen3.8-omni-flash',...saved};}
export function saveConfig(value){const url=new URL(value.baseURL);if(url.protocol!=='https:'||url.username||url.password||url.search||url.hash)throw Error('模型地址需要有效的HTTPS URL。');if(!value.model?.trim())throw Error('需要模型名称。');mkdirSync(privateRoot(),{recursive:true});const next={...config(),baseURL:url.href.replace(/\/$/,''),model:value.model.trim()};writeFileSync(join(privateRoot(),'config.json'),JSON.stringify(next,null,2));return next;}
export function keyConfigured(){return Boolean(process.env.QIAN_OMNI_API_KEY||process.env.DASHSCOPE_API_KEY)||existsSync(join(privateRoot(),'qwen-key.xml'));}
let cachedKey,stamp;
export function getKey(){const env=process.env.QIAN_OMNI_API_KEY||process.env.DASHSCOPE_API_KEY;if(env)return env;const file=join(privateRoot(),'qwen-key.xml');if(!existsSync(file))throw Error('请设置 QIAN_OMNI_API_KEY，或在本地设置页填写 Key。');const current=statSync(file).mtimeMs;if(cachedKey&&stamp===current)return cachedKey;const r=spawnSync('pwsh',['-NoProfile','-File',join(pluginRoot,'protect-key.ps1'),'-Action','read','-Directory',privateRoot()],{encoding:'utf8',windowsHide:true});if(r.status!==0||!r.stdout.trim())throw Error('API Key读取失败，请在本地设置页重新保存。');cachedKey=r.stdout.trim();stamp=current;return cachedKey;}
export function saveKey(key){if(typeof key!=='string'||!key.trim())throw Error('请填写 API Key。');const r=spawnSync('pwsh',['-NoProfile','-File',join(pluginRoot,'protect-key.ps1'),'-Action','write','-Directory',privateRoot()],{input:key.trim(),encoding:'utf8',windowsHide:true});if(r.status!==0)throw Error('API Key加密保存失败。');cachedKey=undefined;stamp=undefined;}
