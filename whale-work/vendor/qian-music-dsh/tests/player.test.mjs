import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {startPlayer} from '../lib/player.mjs';
import {rememberSong} from '../lib/providers.mjs';
import {parseLrc} from '../lib/lyrics.mjs';
test('LRC supports repeated timestamps, offsets and chronological highlighting',()=>{
 assert.deepEqual(parseLrc('[offset:-500]\n[01:00.20][00:02.00]一句\n[00:00]开头'),[{time:0,text:'开头'},{time:1.5,text:'一句'},{time:59.7,text:'一句'}]);
});
test('standalone player confirms controls, retains queue, persists playlists and rejects foreign clients',async t=>{
 const root=await mkdtemp(join(tmpdir(),'qian-player-'));
 const resolved=[];
 const p=await startPlayer({root,open:()=>{},resolve:async key=>{resolved.push(key);return {url:'https://example.org/test.mp3'};}});
 t.after(async()=>{await p.close();await rm(root,{recursive:true,force:true});});
 const u=new URL(p.url),base=u.origin,token=u.hash.slice(1),clientId='test-window';
 async function api(path,body,headers={}){const response=await fetch(base+path,{method:body?'POST':'GET',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json',...headers},body:body?JSON.stringify(body):undefined});return {status:response.status,body:await response.json()};}
 assert.equal((await fetch(base+'/api/state')).status,401);
 assert.equal((await api('/api/state',null,{Origin:'https://example.org'})).status,403);
 await assert.rejects(p.control('play'),/启用播放/);
 await api('/api/poll',{clientId,report:{paused:true,seconds:0,duration:180}});
 assert.equal((await api('/api/poll',{clientId:'other'})).status,409);
 for(const id of ['1','2','3'])rememberSong({key:'netease:'+id,source:'netease',id,name:'test '+id,artists:'tester'});
 await p.enqueue(['netease:1','netease:2'],{play:false});
 async function execute(operation,{error,seconds=0,paused=false}={}){const promise=operation().then(value=>({value}),error=>({error}));await new Promise(r=>setTimeout(r,10));const d=await api('/api/poll',{clientId});const cmd=d.body.commands[0];assert.ok(cmd);await api('/api/ack',{clientId,id:cmd.id,error,report:{seconds,paused,duration:180}});const result=await promise;if(result.error)throw result.error;return result.value;}
 await execute(()=>p.control('select',{index:0}));assert.equal(p.state().current.key,'netease:1');
 await execute(()=>p.control('seek',{seconds:42}),{seconds:42});assert.equal(p.state().seconds,42);
 await execute(()=>p.control('volume',{volume:0.25}));assert.equal(p.state().volume,0.25);
 await p.control('mode',{mode:'single'});await execute(()=>p.control('ended'));assert.equal(p.state().currentIndex,0);
 await p.control('mode',{mode:'loop'});await execute(()=>p.control('select',{index:1}));await execute(()=>p.control('ended'));assert.equal(p.state().currentIndex,0);
 await p.control('mode',{mode:'shuffle'});await execute(()=>p.control('next'));assert.equal(p.state().currentIndex,1);
 await p.control('mode',{mode:'order'});await p.control('ended');assert.equal(p.state().paused,true);
 await p.control('queue',{action:'move',from:1,to:0});assert.equal(p.state().currentIndex,0);
 await p.control('queue',{action:'reorder',indices:[1,0]});assert.equal(p.state().currentIndex,1);
 await assert.rejects(p.control('queue',{action:'reorder',indices:[0,0]}),/完整索引/);
 await execute(()=>p.control('queue',{action:'remove',index:1}),{paused:true});assert.equal(p.state().currentIndex,-1);
 await assert.rejects(execute(()=>p.control('select',{index:0}),{error:'autoplay blocked'}),/autoplay blocked/);assert.equal(p.state().currentIndex,-1);
 const list=await p.library.playlist('create',{name:'我的歌单'});
 await p.library.playlist('add',{id:list.id,songs:[p.state().queue[0]]});
 await p.library.playlist('rename',{id:list.id,name:'收藏'});
 await assert.rejects(p.library.playlist('delete',{id:list.id}),/confirm/);
 const again=await startPlayer({root,open:()=>{}});try{assert.equal(again.state().queue.length,1);assert.equal(again.state().playlists[0].name,'收藏');assert.equal(again.state().mode,'order');assert.equal(again.state().volume,0.25);assert.equal(again.state().playlists[0].songs[0].url,undefined);}finally{await again.close();}
 await p.library.playlist('remove',{id:list.id,keys:['netease:1']});assert.equal((await p.library.playlist('get',{id:list.id})).songs.length,0);
 await p.library.playlist('delete',{id:list.id,confirm:true});assert.equal(p.state().playlists.length,0);
 await execute(()=>p.control('queue',{action:'clear'}),{paused:true});assert.equal(p.state().queue.length,0);
 assert.ok(resolved.length>=5);
});
