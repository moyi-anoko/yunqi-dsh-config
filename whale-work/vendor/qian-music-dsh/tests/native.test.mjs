import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {mediaMarker,nativeParts,hasHeard} from '../lib/native.mjs';
test('listening is marked only after the native-media model response commits',async()=>{
 const root=await mkdtemp(join(tmpdir(),'qian-native-')),originalFetch=globalThis.fetch,oldKey=process.env.QIAN_OMNI_API_KEY,oldRoot=process.env.QIAN_CONFIG_DIR;
 try{process.env.QIAN_OMNI_API_KEY='test-only-not-real';process.env.QIAN_CONFIG_DIR=root;const file=join(root,'sample.wav');await writeFile(file,Buffer.from('test fixture'));
  globalThis.fetch=async url=>String(url).includes('getPolicy')?Response.json({data:{upload_host:'https://example.aliyuncs.com',upload_dir:'test',oss_access_key_id:'test',policy:'test',signature:'test'}}):new Response('');
  const marker=await mediaMarker(file,undefined,'netease:native-test');const parts=nativeParts([{role:'tool',content:JSON.stringify(marker)}]);assert.equal(parts.parts[0].type,'input_audio');assert.equal(hasHeard('netease:native-test'),false);parts.commit();assert.equal(hasHeard('netease:native-test'),true);assert.equal(nativeParts([{content:marker.marker}]).parts.length,0);
  const video=join(root,'sample.mp4');await writeFile(video,Buffer.from('video transport fixture'));const v=await mediaMarker(video,undefined,'bili:BV1nyxs66EJt:p1:video');const videoParts=nativeParts([{role:'tool',content:JSON.stringify(v)}]);assert.equal(videoParts.parts[0].type,'video_url');assert.ok(videoParts.parts[0].video_url.url.startsWith('oss://'));assert.equal(hasHeard('bili:BV1nyxs66EJt:p1:video'),false);videoParts.commit();assert.equal(hasHeard('bili:BV1nyxs66EJt:p1:video'),true);
 }finally{globalThis.fetch=originalFetch;if(oldKey===undefined)delete process.env.QIAN_OMNI_API_KEY;else process.env.QIAN_OMNI_API_KEY=oldKey;if(oldRoot===undefined)delete process.env.QIAN_CONFIG_DIR;else process.env.QIAN_CONFIG_DIR=oldRoot;await rm(root,{recursive:true,force:true});}
});
