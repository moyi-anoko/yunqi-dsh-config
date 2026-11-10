import http from 'node:http';
import {randomBytes,randomUUID} from 'node:crypto';
import {privateRoot} from './config.mjs';
import {cachedSong,resolveSong,songRecord} from './providers.mjs';
import {Library} from './library.mjs';
import {lyrics} from './lyrics.mjs';
import {MusicSession} from './session.mjs';
import {serveLocal,uploadLocal} from './local-media.mjs';
export async function startPlayer({root=privateRoot(),resolve=resolveSong,allowedOrigins=[],bili}={}){
 const library=await new Library(root).load(),token=randomBytes(24).toString('hex'),commands=[],pending=new Map();
 const session=await new MusicSession(root).load();
 let client=null,currentIndex=-1,playEpoch=0,report={paused:true,seconds:0,duration:0},base;
 const online=()=>client&&Date.now()-client.seen<8000;
 const state=()=>({online:Boolean(online()),queue:library.data.queue,currentIndex,playEpoch,current:library.data.queue[currentIndex]||null,mode:library.data.mode,volume:library.data.volume,listeningMode:session.mode,...report,playlists:library.data.playlists});
 async function command(action,args={},signal){
  if(!online())throw Error('请先在 DSH 底部展开“音乐”，点击“启用播放”');
  const id=randomUUID();
  return new Promise((yes,no)=>{const finish=(error,result)=>{clearTimeout(timer);signal?.removeEventListener('abort',abort);pending.delete(id);const pos=commands.findIndex(x=>x.id===id);if(pos>=0)commands.splice(pos,1);error?no(error):yes(result);};const abort=()=>finish(signal.reason||Error('已取消'));const timer=setTimeout(()=>finish(Error('播放器未确认执行，请检查窗口')),12000);pending.set(id,{finish,client:client.id});commands.push({id,action,args});if(signal?.aborted)abort();else signal?.addEventListener('abort',abort,{once:true});});
 }
 async function enqueue(keys,{replace=false,play=true}={},signal){const tracks=keys.map(k=>songRecord(cachedSong(k)));const index=replace?0:library.data.queue.length;if(replace)library.data.queue=[];library.data.queue.push(...tracks);await library.save();if(play&&tracks.length)return control('select',{index},signal);return state();}
 async function control(action,args={},signal){
  if(action==='queue'){
   const q=library.data.queue,active=q[currentIndex],index=args.index;
   if(args.action==='clear'){await command('pause',{},signal);q.length=0;currentIndex=-1;report={paused:true,seconds:0,duration:0};}
   else if(args.action==='remove'){if(!Number.isInteger(index)||index<0||index>=q.length)throw Error('无效队列索引');if(index===currentIndex)await command('pause',{},signal);q.splice(index,1);currentIndex=active?q.indexOf(active):-1;}
   else if(args.action==='move'){if(![args.from,args.to].every(n=>Number.isInteger(n)&&n>=0&&n<q.length))throw Error('无效移动索引');q.splice(args.to,0,q.splice(args.from,1)[0]);currentIndex=q.indexOf(active);}
   else if(args.action==='reorder'){const ids=args.indices;if(!Array.isArray(ids)||ids.length!==q.length||new Set(ids).size!==q.length||ids.some(n=>!Number.isInteger(n)||n<0||n>=q.length))throw Error('indices 必须是完整索引排列');library.data.queue=ids.map(n=>q[n]);currentIndex=library.data.queue.indexOf(active);}
   else throw Error('未知队列操作');await library.save();return state();
  }
  if(action==='mode'){if(!['order','shuffle','single','loop'].includes(args.mode))throw Error('未知播放模式');library.data.mode=args.mode;await library.save();return state();}
  if(action==='control')return control(args.action,{},signal);
  if(['next','previous','ended'].includes(action)){
   const n=library.data.queue.length;if(!n)throw Error('队列为空');let index;
   if(action==='previous')index=Math.max(0,currentIndex-1);
   else if(action==='ended'&&library.data.mode==='single')index=currentIndex;
   else if(library.data.mode==='shuffle'&&n>1){index=Math.floor(Math.random()*(n-1));if(index>=currentIndex)index++;}
   else index=currentIndex+1;
   if(index>=n){if(action==='ended'&&library.data.mode==='order'){report.paused=true;return state();}index=0;}
   return control('select',{index},signal);
  }
  if(action==='select'){
   if(!Number.isInteger(args.index)||!library.data.queue[args.index])throw Error('无效队列索引');
   const song=await resolve(library.data.queue[args.index].key,signal),url=song.source==='local'?base+'/api/local-audio/'+encodeURIComponent(song.key)+'?token='+token:song.url;const result=await command('load',{url,volume:library.data.volume},signal);currentIndex=args.index;playEpoch++;report={...report,...result};await session.history({event:'play',song:songRecord(song),seconds:report.seconds});void session.trackStarted(state()).catch(e=>session.history({event:'dj_error',error:e.message}));return state();
  }
  if(action==='play'&&currentIndex<0&&library.data.queue.length)return control('select',{index:0},signal);
  if(action==='seek'&&(!Number.isFinite(args.seconds)||args.seconds<0))throw Error('无效秒数');
  if(action==='volume'&&(!Number.isFinite(args.volume)||args.volume<0||args.volume>1))throw Error('音量范围为 0 到 1');
  if(!['play','pause','seek','volume'].includes(action))throw Error('未知播放操作');
  const result=await command(action,args,signal);report={...report,...result};await session.history({event:action,key:state().current?.key,seconds:report.seconds,...(action==='volume'?{volume:args.volume}:{})});if(action==='volume'){library.data.volume=args.volume;await library.save();}return state();
 }
 const server=http.createServer(async(req,res)=>{
  const reply=(data,status=200)=>{res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'});res.end(JSON.stringify(data));};
  try{
   if(req.headers.host!==new URL(base).host)return reply({error:'Host 不匹配'},403);
   const origin=req.headers.origin;
   if(origin&&![base,'dsh-app://app','file://','null',...allowedOrigins].includes(origin))return reply({error:'来源不匹配'},403);
   if(origin){res.setHeader('Access-Control-Allow-Origin',origin);res.setHeader('Vary','Origin');}
   if(req.method==='OPTIONS'){res.writeHead(204,{'Access-Control-Allow-Methods':'GET, HEAD, POST, OPTIONS','Access-Control-Allow-Headers':'Authorization, Content-Type, Range','Access-Control-Max-Age':'600'});return res.end();}
   const requestURL=new URL(req.url,base),path=requestURL.pathname,isLocalAudio=path.startsWith('/api/local-audio/')&&['GET','HEAD'].includes(req.method);
   if(req.headers.authorization!=='Bearer '+token&&!(isLocalAudio&&requestURL.searchParams.get('token')===token))return reply({error:'播放器未授权'},401);
   if(isLocalAudio)return await serveLocal(req,res,decodeURIComponent(path.slice('/api/local-audio/'.length)));
   if(path==='/api/local-import'&&req.method==='POST'){const song=await uploadLocal(req,root,requestURL.searchParams.get('name')||'');await enqueue([song.key],{play:false});return reply({song,state:state()});}
   if(req.method==='GET'&&path==='/api/state')return reply(state());
   let body='';for await(const chunk of req)body+=chunk;const a=body?JSON.parse(body):{};
   if(req.method!=='POST')return reply({error:'不支持的方法'},405);
   if(path==='/api/poll'){if(online()&&client.id!==a.clientId)return reply({error:'已有播放器窗口在线，请关闭旧窗口后重试'},409);client={id:a.clientId,seen:Date.now()};if(a.report&&Number.isFinite(a.report.seconds))report={paused:Boolean(a.report.paused),seconds:a.report.seconds,duration:Number.isFinite(a.report.duration)?a.report.duration:0};return reply({commands:[...commands],state:state()});}
   if(path==='/api/ack'){const p=pending.get(a.id);if(p&&p.client===a.clientId)p.finish(a.error?Error(a.error):null,a.report);return reply({ok:true});}
   if(path==='/api/control')return reply(await control(a.action,a.args));
   if(path==='/api/ended')return reply(await control('ended'));
   if(path==='/api/enqueue')return reply(await enqueue(a.keys,a));
   if(path==='/api/lyrics')return reply(await lyrics(a.key));
   if(path==='/api/history')return reply(await session.readHistory(a.offset||0,a.limit||100));
   if(path==='/api/memory')return reply(session.memory);
   if(path==='/api/bilibili'){if(!bili)throw Error('B站扩展未加载');return reply(await bili.account(a.action||'status'));}
   if(path==='/api/playlist'){if(a.action==='add')a.songs=(a.songs||[]).map(s=>cachedSong(s.key));return reply(await library.playlist(a.action,a));}
   return reply({error:'未找到'},404);
  }catch(e){if(res.headersSent)res.destroy();else reply({error:e.message},400);}
 });
 await new Promise((yes,no)=>{server.once('error',no);server.listen(0,'127.0.0.1',yes);});base='http://127.0.0.1:'+server.address().port;server.unref();
 const ticker=setInterval(()=>session.tick(state()),250);ticker.unref();
 return {state,control,enqueue,library,session,url:base+'/#'+token,connection:{base,token},close(){clearInterval(ticker);session.close();for(const p of pending.values())p.finish(Error('播放器关闭'));return new Promise(resolve=>server.close(resolve));}};
}
