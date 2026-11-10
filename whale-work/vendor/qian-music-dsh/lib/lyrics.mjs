import {cachedSong} from './providers.mjs';
import {readFile} from 'node:fs/promises';
import {extname} from 'node:path';
export function parseLrc(text=''){
 const rows=[];let offset=Number(text.match(/\[offset:([+-]?\d+)\]/i)?.[1]||0)/1000;
 for(const line of text.split(/\r?\n/)){const stamps=[...line.matchAll(/\[(\d+):(\d+(?:\.\d+)?)\]/g)],words=line.replace(/\[[^\]]*\]/g,'').trim();for(const stamp of stamps)rows.push({time:Math.max(0,Number(stamp[1])*60+Number(stamp[2])+offset),text:words});}
 return rows.sort((a,b)=>a.time-b.time);
}
export async function lyrics(key,signal){
 const s=cachedSong(key);let url,headers={},pick;
 if(s.source==='local'){try{const bytes=await readFile(s.localPath.slice(0,-extname(s.localPath).length)+'.lrc');let text=new TextDecoder('utf-8').decode(bytes);if(text.includes('\uFFFD'))text=new TextDecoder('gb18030').decode(bytes);return {key,rows:parseLrc(text),translation:[],text,note:'本地同名LRC歌词'};}catch(e){return {key,rows:[],translation:[],note:e.code==='ENOENT'?'暂无同名本地LRC歌词':'本地歌词读取失败'};}}
 if(s.source==='netease'){url='https://music.163.com/api/song/lyric?id='+encodeURIComponent(s.id)+'&lv=-1&kv=-1&tv=-1';headers.Referer='https://music.163.com/';pick=d=>({text:d.lrc?.lyric,translation:d.tlyric?.lyric});}
 if(s.source==='qq'){url='https://c.y.qq.com/lyric/fcgi-bin/fcg_query_lyric_new.fcg?songmid='+encodeURIComponent(s.id)+'&format=json&nobase64=1';headers.Referer='https://y.qq.com/';pick=d=>({text:d.lyric,translation:d.trans});}
 if(s.source==='kugou'){url='https://m.kugou.com/app/i/getSongInfo.php?cmd=playInfo&hash='+encodeURIComponent(s.id);pick=d=>({text:d.lyrics});}
 if(s.source==='kuwo'){url='https://m.kuwo.cn/newh5/singles/songinfoandlrc?musicId='+encodeURIComponent(s.id);headers.Referer='https://www.kuwo.cn/';pick=d=>({rows:(d.data?.lrclist||[]).map(x=>({time:Number(x.time),text:x.lineLyric}))});}
 if(s.source==='migu'){url='https://music.migu.cn/v3/api/music/audioPlayer/getLyric?copyrightId='+encodeURIComponent(s.id);pick=d=>({text:d.lyric});}
 try{const r=await fetch(url,{headers,signal:signal?AbortSignal.any([signal,AbortSignal.timeout(12000)]):AbortSignal.timeout(12000)});if(!r.ok)throw Error('HTTP '+r.status);const d=pick(await r.json());const rows=d.rows||parseLrc(d.text);return {key,rows,translation:parseLrc(d.translation),text:d.text||'',note:rows.length?'来源返回的歌词':'该来源暂无歌词'};}catch(e){if(signal?.aborted)throw e;return {key,rows:[],translation:[],note:'歌词暂不可用：'+e.message};}
}
