import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { loadProfile } from '../lib/config.mjs';
import { readFileSync, writeFileSync } from 'node:fs';
import assert from 'node:assert/strict';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const { stateDir, profile } = loadProfile({ root });
const address = JSON.parse(readFileSync(resolve(stateDir, 'server.json'), 'utf8')).address;
const token = readFileSync(resolve(stateDir, 'token'), 'utf8').trim();
const sdkPath = resolve(process.env.PI_GATEWAY_OPENAI_SDK_PATH || resolve(root, 'node_modules/openai/index.mjs'));
let OpenAI;
try { ({ default: OpenAI } = await import(pathToFileURL(sdkPath).href)); }
catch { throw new Error('Install the official openai client in a temporary directory and set PI_GATEWAY_OPENAI_SDK_PATH to its index.mjs. See docs/openai.md.'); }
const sdkVersion = JSON.parse(readFileSync(resolve(dirname(sdkPath), 'package.json'), 'utf8')).version;
const client = new OpenAI({baseURL:address+'/v1',apiKey:token,maxRetries:0,timeout:profile.runTimeoutMs+10000});
const models = await client.models.list();
const model = models.data.find(m=>m.id.endsWith('/proof')).id;
const checks=[], runs=[];
function check(name, condition){assert.ok(condition,name);checks.push(name);console.log('PASS',name);}
async function receipt(id){const r=await fetch(address+'/runs/'+id,{headers:{authorization:'Bearer '+token}});const run=await r.json();check('fresh and reaped '+runs.length,run.status==='completed'&&run.initialMessageCount===0&&run.childExited&&run.model===profile.model&&run.provider===profile.provider);check('chat and harness hooks '+runs.length,run.hooks.some(h=>h.hook==='chat.context')&&run.hooks.some(h=>h.hook==='runtime.before_provider_request'));runs.push({id:run.id,status:run.status,sessionId:run.sessionId,initialMessageCount:run.initialMessageCount,childExited:run.childExited,provider:run.provider,model:run.model,hooks:[...new Set(run.hooks.map(h=>h.hook))]});return run;}
check('model discovery',models.object==='list'&&model);
const basic = await client.chat.completions.create({model,tools:[],messages:[{role:'system',content:'For this transport test answer exactly the user requested phrase, without explanation.'},{role:'user',content:[{type:'text',text:'Reply exactly OPENAI_GATEWAY_READY'}]}]}).withResponse();
check('nonstream SDK text',basic.data.choices[0].message.content.includes('OPENAI_GATEWAY_READY'));
await receipt(basic.response.headers.get('x-pi-run-id'));
const streaming = await client.chat.completions.create({model,tools:[],stream:true,stream_options:{include_usage:true},messages:[{role:'user',content:'Reply exactly STREAM_GATEWAY_READY and nothing else.'}]}).withResponse();
let text='',finish='',usage;
for await(const chunk of streaming.data){text+=chunk.choices[0]?.delta.content||'';finish=chunk.choices[0]?.finish_reason||finish;if(chunk.usage)usage=chunk.usage;}
check('stream SDK text/finish/usage',text.includes('STREAM_GATEWAY_READY')&&finish==='stop'&&usage.total_tokens>0);
await receipt(streaming.response.headers.get('x-pi-run-id'));
const tools=[{type:'function',function:{name:'lookup_issue',description:'Look up an issue by its integer number; call this for any issue status question.',parameters:{type:'object',properties:{number:{type:'integer'}},required:['number']}}}];
const messages=[{role:'user',content:'Use lookup_issue to get the status of issue 42. Do not answer from memory; call the function now.'}];
const tool=await client.chat.completions.create({model,tools,messages}).withResponse();
const msg=tool.data.choices[0].message,call=msg.tool_calls?.[0];
check('SDK client tool handoff',tool.data.choices[0].finish_reason==='tool_calls'&&call?.function.name==='lookup_issue'&&JSON.parse(call.function.arguments).number===42);
await receipt(tool.response.headers.get('x-pi-run-id'));
const final=await client.chat.completions.create({model,tools:[],messages:[...messages,msg,{role:'tool',tool_call_id:call.id,content:JSON.stringify({status:'CLOSED_PROOF_42',reason:'fixed'})},{role:'user',content:'Return the exact status string from the tool result, with no extra words.'}]}).withResponse();
check('SDK tool-result continuation',final.data.choices[0].message.content.includes('CLOSED_PROOF_42'));
await receipt(final.response.headers.get('x-pi-run-id'));
const repo=await client.chat.completions.create({model,messages:[{role:'user',content:'Read discount.php with your read tool. Identify the percentage calculation bug, give a concrete numeric example, and name the function.'}]}).withResponse();
check('native harness read review',repo.data.choices[0].message.content.includes('discount'));
const rr=await receipt(repo.response.headers.get('x-pi-run-id'));check('actual read tool used',rr.hooks.some(h=>h.hook==='runtime.tool_call'&&h.tool==='read'&&h.permitted));
check('distinct fresh sessions',new Set(runs.map(r=>r.sessionId)).size===runs.length);
const sources = Object.fromEntries(['server.mjs','lib/runtime.mjs','lib/config.mjs','lib/openai.mjs','profile/harness.ts','profile/chat.ts','scripts/prove-openai.mjs'].map(file=>[file,createHash('sha256').update(readFileSync(resolve(root,file))).digest('hex')]));
writeFileSync(resolve(root,'evidence/openai-sdk-proof.json'),JSON.stringify({at:new Date().toISOString(),sdk:'openai-node '+sdkVersion,pi:profile.piVersion,sources,scope:'Live local Ollama inference; no cloud inference; buffered Chat Completions streaming',checks,runs},null,2)+'\n');
console.log(JSON.stringify({passed:checks.length,runs:runs.length}));
