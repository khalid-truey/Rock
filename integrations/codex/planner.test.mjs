import test from 'node:test';
import assert from 'node:assert/strict';
import { plannerInput,completion,writeCompletion } from './planner.mjs';
test('preserves history roles and turns inline images into actual image inputs',()=>{
  const r=plannerInput({messages:[{role:'system',content:'rules'},{role:'tool',tool_call_id:'abc',content:[{type:'text',text:'screen'},{type:'image_url',image_url:{url:'data:image/png;base64,ABC'}}]}]});
  const history=JSON.parse(r.input[0].text).messages;
  assert.equal(history[0].role,'system');assert.equal(history[1].tool_call_id,'abc');assert.equal(r.input[1].type,'image');
});
test('never fetches remote image URLs',()=>assert.throws(()=>plannerInput({messages:[{content:[{type:'image_url',image_url:{url:'https://example.com/a'}}]}]})));
test('rejects invented tools and malformed arguments before POK can execute',()=>{
  assert.throws(()=>completion({text:'',tool_calls:[{name:'delete_all',arguments:'{}'}]},[{name:'list_windows'}],'x'));
  assert.throws(()=>completion({text:'',tool_calls:[{name:'list_windows',arguments:'[]'}]},[{name:'list_windows'}],'x'));
});
test('OpenAI streaming carries IDs, arguments, usage and terminal marker',()=>{
  const result=completion({text:'',tool_calls:[{name:'list_windows',arguments:'{}'}]},[{name:'list_windows'}],'x',{inputTokens:10,outputTokens:2,totalTokens:12});
  let output='';const res={writeHead(){},write(s){output+=s;},end(s){output+=s;}};
  writeCompletion(res,result,true);assert.match(output,/"index":0/);assert.match(output,/"finish_reason":"tool_calls"/);assert.match(output,/"total_tokens":12/);assert.ok(output.endsWith('data: [DONE]\n\n'));
});
