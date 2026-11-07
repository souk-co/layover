// Actual main entrypoint ordering; hardware, custody and gateways are explicit stand-ins.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
const source = fs.readFileSync(new URL('../agent.mjs', import.meta.url), 'utf8');
async function run(fail) {
 const dir = fs.mkdtempSync(path.join(os.tmpdir(),'guest-publication-')), events = path.join(dir,'events'), loader = path.join(dir,'fixture.mjs');
 const priv = crypto.generateKeyPairSync('x25519').privateKey.export({format:'der',type:'pkcs8'}).toString('hex');
 const state = {enc_priv:priv,ca:{old:true},wallet:'private-wallet',chain:{seq:8,head:'old-head',entries:[{entry:{seq:2}},{entry:{seq:8}}]},budget:{used:19},appraisal_salt:'aa',probe_last_commit:17,leases:[{id:'retained',startSeq:2}],holds:[{id:'retained-hold'}]};
 const common = `import fs from 'node:fs';const event=x=>fs.appendFileSync(${JSON.stringify(events)},JSON.stringify(x)+'\\n');`;
 const names = source.match(/import \{([\s\S]*?)\} from "\.\/core.mjs"/)[1].split(',').map(x=>x.trim());
 const overrides = {
  OUT:JSON.stringify(dir),AGENT_ID:'"host"',OPERATOR:'"0x'+ '11'.repeat(20)+'"',GUEST_ESCROW:'"0x'+'22'.repeat(20)+'"',LIFETIME_MS:'0',
  budget:'{}',chain:'{seq:0,entries:[]}',claimer:'{address:"0x'+'33'.repeat(20)+'",privateKey:"private-claim"}',wallet:'{address:"wallet",privateKey:"private-wallet"}',
  claimManifest:'"new-manifest"',savedClaimIdentity:'{manifest:"new-manifest",operator:"owner"}',claimHistory:'[{key:"old-claim"}]',guestClaims:'{pending:"preserved"}',
  useWallet:'()=>{}',useClaimer:'()=>event({kind:"choose"})',attestedManifest:'()=>"new-manifest"',gatewayUp:'async()=>{}',directEgress:'async()=>({})',lineFacts:'async()=>({region:"r",isp_class:"c",residential:true})',
  hex:'b=>Buffer.from(b).toString("hex")',sha256:'()=>Buffer.alloc(32)',x25519Raw:'()=>Buffer.alloc(32)',addressWord:'()=>Buffer.alloc(32)',attest:'async()=>{event({kind:"attest"});return "aa"}',
  log:'()=>{}',record:'()=>{}',post:'async(url,body)=>{event({kind:"publish",url,body});throw Error("fixture halt after publication")}'
 };
 const core = common + names.map(n=>`export const ${n}=${overrides[n]??'()=>{}'};`).join('\n');
 const lease = common+`let restored={leases:[],holds:[]};export const prepareLeases=s=>{restored=s;event({kind:'hydrate'})};export const exportLeases=()=>({leases:restored.leases,holds:restored.holds,keepFrom:2});export const makeCA=async()=>({der:Buffer.alloc(1),saved:{old:true}});export const useSave=()=>{};export const resumeLeases=()=>{throw Error('resume before publication')};export const serveRelay=()=>{};export const reservedBy=()=>{};export const pollLeases=()=>{};`;
 const st = common+`export const restore=async()=>({state:${JSON.stringify(state)}});export const commit=async(c,state)=>{event({kind:'commit',state});${fail?"throw Error('fixture commit refused')":""}};export const restoreExisting=()=>{};export const custodySnapshot=()=>{};`;
 const mods = {'core.mjs':core,'lease.mjs':lease,'state.mjs':st,'appraise.mjs':'export const serveRequest=()=>{};export const serveProbe=()=>{};','drain-preflight.mjs':'export const drainPreflight=()=>{};'};
 fs.writeFileSync(loader,`import{registerHooks}from'node:module';const mods=${JSON.stringify(mods)};registerHooks({resolve(s,c,next){const code=mods[s.split('/').at(-1)];return code?{url:'data:text/javascript,'+encodeURIComponent(code),shortCircuit:true}:next(s,c)}});`);
 try {const r=spawnSync(process.execPath,['--import',loader,new URL('../agent.mjs',import.meta.url).pathname],{env:{PATH:process.env.PATH},encoding:'utf8',timeout:5000});return {status:r.status,stderr:r.stderr,events:fs.existsSync(events)?fs.readFileSync(events,'utf8').trim().split('\n').map(JSON.parse):[],proof:fs.existsSync(path.join(dir,'guest-key'))?JSON.parse(fs.readFileSync(path.join(dir,'guest-key'))):null};}
 finally{fs.rmSync(dir,{recursive:true,force:true})}
}
test('commit refusal in actual main publishes neither guest-key artifact nor registration',async()=>{
 const r=await run(true);assert.match(r.stderr,/fixture commit refused/);assert.equal(r.proof,null);assert.equal(r.events.some(x=>x.kind==='publish'),false);assert.equal(r.events.filter(x=>x.kind==='attest').length,1);
});
test('actual main seals selected claim identity and preserved lease/chain/budget before public proof',async()=>{
 const r=await run(false);assert.match(r.stderr,/fixture halt after publication/);const commit=r.events.find(x=>x.kind==='commit'),pub=r.events.find(x=>x.kind==='publish');assert.ok(commit&&pub,r.stderr);
 assert.ok(r.events.indexOf(commit)<r.events.indexOf(pub));assert.deepEqual(commit.state.leases,[{id:'retained',startSeq:2}]);assert.deepEqual(commit.state.holds,[{id:'retained-hold'}]);assert.equal(commit.state.chain.entries.length,2);assert.equal(commit.state.budget.used,19);assert.equal(commit.state.claim_key,'private-claim');assert.deepEqual(commit.state.claim_history,[{key:'old-claim'}]);assert.deepEqual(commit.state.guest_claims,{pending:'preserved'});assert.equal(commit.state.claim_manifest,'new-manifest');assert.deepEqual(pub.body.guest_key,r.proof);assert.deepEqual(Object.keys(r.proof).sort(),['address','attestation','escrow','operator']);assert.equal(JSON.stringify(r.proof).includes('private-'),false);
});
