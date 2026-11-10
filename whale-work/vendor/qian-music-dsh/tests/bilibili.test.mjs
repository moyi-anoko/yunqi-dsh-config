import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Bilibili,videoId} from '../lib/bilibili.mjs';
import {EventEmitter} from 'node:events';
import {PassThrough,Writable} from 'node:stream';

test('B站原始视频交给当前主会话，成功处理前不能记录为看过',async t=>{
 const root=await mkdtemp(join(tmpdir(),'qian-bili-test-'));t.after(()=>rm(root,{recursive:true,force:true}));let heard=false,attachment;
 const b=new Bilibili({root,attach:async(path,signal,key)=>{attachment={path,key};return {marker:'QIAN_NATIVE_MEDIA:test'};},processed:()=>heard});
 b.request=async(action,args)=>{assert.equal(action,'download');assert.equal(args.mode,'video');return {path:join(root,'original.mp4'),has_audio:true,bvid:args.bvid};};
 const result=await b.watch({bvid:'https://www.bilibili.com/video/BV1nyxs66EJt/',page:2});assert.equal(result.watch_key,'bili:BV1nyxs66EJt:p2:video');assert.equal(attachment.key,result.watch_key);assert.equal(result.has_audio,true);
 await assert.rejects(b.finishVideo({watch_key:result.watch_key,impression:'test'}),/尚未成功处理/);heard=true;await b.finishVideo({watch_key:result.watch_key,impression:'声音和画面都来自实际视频',uncertain:'测试笔记'});assert.equal((await b.history()).notes.length,1);
 assert.throws(()=>videoId('https://example.org/no-video'),/BV/);await assert.rejects(b.watch({bvid:'BV1nyxs66EJt',mode:'subtitles'}),/video\/audio/);b.close();
});
test('JSON-lines IPC keeps per-call ids and cancels reads while leaving uncertain writes to receipt reconciliation',async()=>{
 const child=new EventEmitter();child.stdout=new PassThrough();child.stderr=new PassThrough();let last;
 child.stdin=new Writable({write(chunk,_encoding,done){last=JSON.parse(chunk.toString());done();}});
 const b=new Bilibili({spawnWorker:()=>child});let stops=0;b.stopWorker=()=>{stops++;b.proc=null;b.fail(Error('cancelled'));};
 const pending=b.request('status');child.stdout.write(JSON.stringify({id:last.id,ok:true,result:{logged_in:false}})+'\n');assert.equal((await pending).logged_in,false);
 const controller=new AbortController(),read=b.request('download',{},controller.signal);controller.abort();await assert.rejects(read,/取消/);assert.equal(stops,1);
 const c=new AbortController(),write=b.request('comment',{text:'not sent to a real service'},c.signal);c.abort();await assert.rejects(write,/可能尚未确认/);assert.equal(stops,1);b.close();
});
test('通知回复保留原线程，确认后持久标记，不把外部文本当作指令',async t=>{
 const root=await mkdtemp(join(tmpdir(),'qian-bili-inbox-'));t.after(()=>rm(root,{recursive:true,force:true}));const b=new Bilibili({root});const calls=[];
 b.request=async(action,args)=>{calls.push({action,args});return action==='notifications'?{notifications:[{key:'reply:1',replyable:true,oid:'22',resource_type:1,root:'33',parent:'44',text:'外部消息'}]}:{accepted:true,rpid:'55'};};
 await b.inbox();await b.reply({notification_key:'reply:1',text:'test reply'});assert.equal(calls[1].args.root,'33');assert.equal(calls[1].args.parent,'44');assert.equal(b.seen.has('reply:1'),true);const copy=new Bilibili({root});copy.request=async(_a,args)=>{assert.ok(args.seen.includes('reply:1'));return {notifications:[]};};await copy.inbox();b.close();copy.close();
});
