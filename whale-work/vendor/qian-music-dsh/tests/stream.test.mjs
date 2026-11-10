import test from 'node:test';
import assert from 'node:assert/strict';
import {stream} from '../lib/stream.mjs';
import {wireMessages} from '../lib/native.mjs';
const options={model:'qwen3.8-omni-flash',messages:[{role:'user',content:[{type:'text',text:'找歌'}]}]};
function response(chunks){return new Response(chunks.map(c=>'data: '+JSON.stringify(c)+'\n\n').join('')+'data: [DONE]\n\n');}
test('tool arguments and usage survive the OpenAI to DSH stream bridge',async()=>{
 let body;const fetcher=async(_url,init)=>{body=JSON.parse(init.body);return response([{choices:[{delta:{tool_calls:[{index:0,id:'call_1',function:{name:'qian_music_search',arguments:'{"keyword":'}}]}}]},{choices:[{delta:{tool_calls:[{index:0,function:{arguments:'"雨"}'}}]},finish_reason:'tool_calls'}]},{choices:[],usage:{prompt_tokens:100,completion_tokens:20,total_tokens:120,prompt_tokens_details:{cached_tokens:30}}}]);};
 const chunks=await Array.fromAsync(stream(options,{},fetcher,()=> 'test-only'));
 assert.equal(body.modalities[0],'text');assert.equal(body.messages[0].content,'找歌');
 assert.deepEqual(chunks.find(c=>c.type==='block-end').block,{type:'tool-call',id:'call_1',name:'qian_music_search',arguments:'{"keyword":"雨"}'});
 assert.equal(chunks.find(c=>c.type==='usage').usage.inputTokens,70);assert.equal(chunks.at(-1).reason.kind,'tool-calls');
});
test('an interrupted stream is an error, never a successful completion',async()=>{
 await assert.rejects(async()=>Array.fromAsync(stream(options,{},async()=>response([{choices:[{delta:{content:'未完成'}}]}]),()=> 'test-only')),/意外中断/);
});
test('tool result retains its parent call id',()=>{
 assert.deepEqual(wireMessages({messages:[{role:'tool',source:{callId:'c1'},content:[{type:'text',text:'found'}]}]}),[{role:'tool',tool_call_id:'c1',content:'found'}]);
});
