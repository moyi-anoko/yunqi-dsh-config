import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {MusicSession,currentTime,sleep} from '../lib/session.mjs';
import {importSong,resolveSong,songRecord} from '../lib/providers.mjs';
test('official CLI import accepts actual platform links without persisting signed URL',async()=>{
 const s=importSong({source:'netease',id:'123',name:'test',url:'https://m8.music.126.net/example.mp3?token=test-only'});
 assert.equal((await resolveSong(s.key)).url,'https://m8.music.126.net/example.mp3?token=test-only');assert.equal(songRecord(await resolveSong(s.key)).url,undefined);
 assert.throws(()=>importSong({source:'netease',id:'123',name:'test',url:'http://127.0.0.1/private'}),/官方音乐/);
});
test('DJ wakes the same agent; track timers cancel on song changes; memory and history persist',async t=>{
 const root=await mkdtemp(join(tmpdir(),'qian-session-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const s=await new MusicSession(root).load(),messages=[],calls=[],agent={followup:m=>messages.push(m)};let state={current:{key:'netease:123'},playEpoch:1,seconds:0,paused:false};
 const player={state:()=>state,control:async(action,args)=>calls.push({action,args})};
 s.setMode('dj',agent);await s.trackStarted(state);assert.equal(messages.length,1);s.setMode('off',agent);await s.trackStarted(state);assert.equal(messages.length,1);
 s.schedule({trigger:'track_time',seconds:15,action:'volume',args:{volume:0.4}},agent,player);s.tick({...state,seconds:14});assert.equal(calls.length,0);s.tick({...state,seconds:15,paused:true});assert.equal(calls.length,0);s.tick({...state,seconds:15});await new Promise(r=>setImmediate(r));assert.equal(calls[0].args.volume,0.4);
 s.schedule({trigger:'track_time',seconds:30,action:'pause'},agent,player);s.tick({...state,playEpoch:2,seconds:50});assert.equal(s.listTimers()[1].status,'cancelled');
 s.schedule({trigger:'reminder',seconds:0,reason:'继续找歌'},agent,player);s.tick(state);await new Promise(r=>setImmediate(r));assert.equal(messages.length,2);
 assert.throws(()=>s.schedule({trigger:'clock',at_time:'2028-01-01T12:00:00',action:'pause'},agent,player),/时区/);
 await s.remember('preference',{note:'星尘优先'});await s.remember('listening',{key:'netease:123',note:'声音很清亮',selected:true});await s.history({event:'play',key:'netease:123',seconds:0});
 const copy=await new MusicSession(root).load();assert.deepEqual(copy.memory.preferences,['星尘优先']);assert.equal(copy.memory.listening.length,1);assert.equal((await copy.readHistory()).total,1);assert.equal(copy.mode,'off');s.close();copy.close();
});
test('real clock and cancellable sleep',async()=>{assert.ok(Math.abs(currentTime('Asia/Shanghai').unixMs-Date.now())<1000);const controller=new AbortController();const pending=sleep(60,controller.signal);controller.abort();await assert.rejects(pending,{name:'AbortError'});});
