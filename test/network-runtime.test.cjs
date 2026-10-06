const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const os=require('node:os');
const path=require('node:path');
const {createNetworkRequester}=require('../lib/networks/http.cjs');
const {NetworkCatalog}=require('../lib/networks/catalog.cjs');
const {EnrichmentWorker}=require('../lib/networks/enrichment-worker.cjs');
const {writeJsonAtomic}=require('../lib/jsonl.cjs');
const CA='0x1776e1f26f98b1a5df9cd347953a26dd3cb46671';
const URL='https://upbit.com/service_center/notice?id=330345227';
const NOW=Date.parse('2026-10-06T12:00:00Z');
const time=n=>new Date(NOW+n).toISOString();
async function rootFor(t) {
  const directory=path.resolve(os.tmpdir());
  const root=await fs.mkdtemp(path.join(directory,'network-runtime-'));
  t.after(async()=>{assert.equal(path.dirname(path.resolve(root)),directory);assert.ok(path.basename(root).startsWith('network-runtime-'));await fs.rm(root,{recursive:true,force:true});});
  return root;
}
const coin=()=>({venue:'bitget',coin:'NMR',source:'https://api.bitget.com/api/v2/spot/public/coins',raw:{doNotStore:true},networks:[{
  network_code:'ERC20',contract_address:CA,withdraw_enabled:true,deposit_enabled:true,withdraw_delayed:null,need_tag:false,raw:{doNotStore:true}}]});
const anchor=()=>({scope:'NOTICE',confirmed:true,symbol:'NMR',exchange:'upbit',source_url:URL,confirmed_at:time(-1000),valid_until:time(100000),
  contracts:[{chain_id:'eip155:1',contract_address:CA,token_kind:'TOKEN'}],deposit_networks:['eip155:1'],
  evidence:[{url:URL,authority:'OFFICIAL',purpose:'LISTED_TOKEN_AND_NETWORK'}]});
const input=()=>({schema_version:1,event_id:'a'.repeat(64),source_url:URL,listing_exchange:'upbit',prepared_at:time(0),candidate_count:1,assets:[{symbol:'NMR',contracts:[],candidates:[{
  venue:'bitget',base_symbol:'NMR',market_type:'spot',market_id:'NMRUSDT',market_status:'ACTIVE',catalog_status:'FRESH',fetched_at:time(-1000),valid_until:time(100000)}]}]});

test('authenticated network requester forwards headers but blocks execution endpoints and methods',async()=>{
  let calls=0;
  const request=createNetworkRequester({minIntervalMs:0,fetchImpl:async(url,options)=>{calls++;assert.equal(options.headers.Authorization,'test-readonly');return new Response('{}');}});
  assert.deepEqual(await request('https://api.upbit.com/v1/status/wallet',{headers:{Authorization:'test-readonly'}}),{});
  assert.throws(()=>request('https://api.upbit.com/v1/withdraws/coin'),/Unsupported/);
  assert.throws(()=>request('https://api.upbit.com/v1/status/wallet',{method:'POST'}),/Unsupported/);
  assert.throws(()=>request('https://api.upbit.com/v1/status/wallet',{body:{}}),/Unsupported/);
  assert.equal(calls,1);
});
test('network snapshots retain last good data on error, fail closed, persist backoff and omit raw',async t=>{
  const root=await rootFor(t);let now=NOW,fail=false,calls=0;
  const adapter={id:'bitget',fetchCoins:async()=>{calls++;if(fail){const error=new Error('SECRET response url?signature=PRIVATE');error.code='HTTP_429';error.retryAfterMs=60000;throw error;}return [coin()];}};
  let catalog=await NetworkCatalog.open({root,adapters:[adapter],credentials:{},now:()=>now,refreshIntervalMs:300000,ttlMs:600000});
  await catalog.refresh();assert.equal(catalog.coin('bitget','nmr').status,'OK');
  const file=path.join(root,'data','networks','bitget.json');
  assert.equal((await fs.readFile(file,'utf8')).includes('doNotStore'),false);
  fail=true;now+=300000;await catalog.refresh();
  const stale=catalog.coin('bitget','NMR');assert.equal(stale.status,'ERROR');assert.equal(stale.networks.length,1);
  assert.equal((await fs.readFile(file,'utf8')).includes('SECRET'),false);
  await catalog.close();catalog=await NetworkCatalog.open({root,adapters:[adapter],credentials:{},now:()=>now});
  await catalog.refresh({dueOnly:true});assert.equal(calls,2);assert.equal(catalog.coin('bitget','NMR').status,'ERROR');await catalog.close();
});
test('network cache distinguishes auth missing, account scope missing, unknown, expired and bad snapshots',async t=>{
  const root=await rootFor(t);let now=NOW;
  const adapter={id:'bitget',fetchCoins:async()=>[coin()]};
  let catalog=await NetworkCatalog.open({root,adapters:[adapter],now:()=>now});
  assert.equal(catalog.coin('bitget','NMR').status,'NOT_FETCHED');await catalog.refresh();
  assert.equal(catalog.coin('bitget','NOPE').currency_status,'NOT_IN_ACCOUNT_SCOPE');now+=600000;
  assert.equal(catalog.coin('bitget','NMR').status,'STALE');await catalog.close();
  await fs.writeFile(path.join(root,'data','networks','bitget.json'),'{}');
  await assert.rejects(NetworkCatalog.open({root,adapters:[adapter]}),/Invalid/);
  for(const broken of ['null','false','0','""']){
    await fs.writeFile(path.join(root,'data','networks','bitget.json'),broken);
    await assert.rejects(NetworkCatalog.open({root,adapters:[adapter]}),/Invalid/);
  }
  await assert.rejects(fs.stat(path.join(root,'state','networks.lock')),{code:'ENOENT'});
});
test('durable enrichment publishes local candidates before slow identity lookup, resumes queued work and reuses cache',async t=>{
  const root=await rootFor(t);
  await fs.mkdir(path.join(root,'data','market-results'),{recursive:true});
  await writeJsonAtomic(path.join(root,'data','market-results',`${'a'.repeat(64)}.json`),input());
  const networkCatalog={views:()=>[],coin:()=>({status:'AUTH_REQUIRED',checked_at:null,valid_until:null,networks:[]})};
  let calls=0;
  const resolver=async()=>{calls++;return anchor();};
  let worker=await EnrichmentWorker.open({root,networkCatalog,resolveIdentity:resolver,now:()=>NOW});
  await worker.drain();assert.equal(calls,0);
  const output=path.join(root,'data','enrichment-results',`${'a'.repeat(64)}.json`);
  const first=JSON.parse(await fs.readFile(output,'utf8'));
  assert.equal(first.status,'ROUTE_FILTER_EVALUATED');assert.equal(first.assets[0].anchor,null);
  await worker.close();worker=await EnrichmentWorker.open({root,networkCatalog,resolveIdentity:resolver,now:()=>NOW});
  await worker.resolveQueued();await worker.drain();assert.equal(calls,1);
  const result=JSON.parse(await fs.readFile(output,'utf8'));
  assert.equal(result.status,'ROUTE_FILTER_EVALUATED');assert.equal(result.assets[0].identity_status,'LISTED_ASSET_VERIFIED');assert.equal(result.eligible_spot_count,0);assert.equal(result.trading_allowed,false);
  const before=(await fs.stat(output)).mtimeMs;await worker.resolveQueued();await worker.drain();assert.equal(calls,1);assert.equal((await fs.stat(output)).mtimeMs,before);
  await worker.close();
});
test('enrichment recovers crash between result write and job registration and corrupt data halts',async t=>{
  const root=await rootFor(t);await fs.mkdir(path.join(root,'data','market-results'),{recursive:true});
  await writeJsonAtomic(path.join(root,'data','market-results',`${'a'.repeat(64)}.json`),input());
  const networkCatalog={views:()=>[],coin:()=>({status:'AUTH_REQUIRED',networks:[]})};
  const worker=await EnrichmentWorker.open({root,networkCatalog,now:()=>NOW});
  await worker.drain();const job=[...worker.jobs.values()][0];worker.jobs.clear();await fs.unlink(path.join(root,'data','identities',`${job.key}.json`));
  await worker.drain();assert.equal(worker.jobs.size,1);
  await fs.writeFile(path.join(root,'data','market-results',`${'a'.repeat(64)}.json`),'broken');
  await assert.rejects(worker.drain(),SyntaxError);await worker.close();
});
