const fs = require('node:fs/promises');
const path = require('node:path');
const {createHash} = require('node:crypto');
const {acquireLock} = require('../lock.cjs');
const {writeJsonAtomic} = require('../jsonl.cjs');
const {enrichResult,validateAnchor} = require('./verify.cjs');
const {createRequester} = require('../markets/http.cjs');
const {symbolKey} = require('../markets/matcher.cjs');

class EnrichmentWorker {
  static async open({root,networkCatalog,anchorsFile=path.join(root,'config','verified-listings.json'),onResult=()=>{},now=Date.now,
    resolveIdentity,identityRequester}={}) {
    const self = new EnrichmentWorker();
    Object.assign(self,{root,networkCatalog,anchorsFile,onResult,now,active:null,resolverActive:null,timer:null,closed:false,jobs:new Map(),
      resolveIdentity:resolveIdentity || (options=>require('./upbit-identity.cjs').resolveUpbitIdentity(options)),
      identityRequester:identityRequester || createRequester(),controller:new AbortController()});
    await fs.mkdir(path.join(root,'state'),{recursive:true});
    await fs.mkdir(path.join(root,'data','enrichment-results'),{recursive:true});
    await fs.mkdir(path.join(root,'data','identities'),{recursive:true});
    self.release=await acquireLock(path.join(root,'state','enrichment.lock'));
    try {
      const files=await fs.readdir(path.join(root,'data','identities'));
      if(files.length>50000)throw new Error('Identity cache limit reached.');
      for(const file of files) {
        if(!/^[a-f0-9]{64}\.json$/.test(file))continue;
        const job=JSON.parse(await fs.readFile(path.join(root,'data','identities',file),'utf8'));
        if(job.key !== file.slice(0,-5) || !job.source_url || !job.symbol || !Number.isFinite(job.next_attempt_at))throw new Error('Invalid identity cache.');
        if(job.anchor)validateAnchor(job.anchor);
        self.jobs.set(job.key,job);
      }
      return self;
    } catch(error){await self.release();throw error;}
  }
  drain() {
    if (this.closed) return Promise.resolve();
    if (this.active) return this.active;
    this.active=this.performDrain().finally(()=>{this.active=null;});return this.active;
  }
  async performDrain() {
    let anchors=[];
    try {anchors=JSON.parse(await fs.readFile(this.anchorsFile,'utf8'));}
    catch(error){if(error.code !== 'ENOENT')throw error;}
    if(!Array.isArray(anchors) || anchors.length>50000)throw new Error('Invalid verified listing anchors file.');
    anchors.forEach(validateAnchor);
    const configuredKeys=new Set(anchors.map(a=>JSON.stringify([a.source_url,a.symbol,a.exchange])));
    for(const job of this.jobs.values()) if(job.anchor && !configuredKeys.has(JSON.stringify([job.anchor.source_url,job.anchor.symbol,job.anchor.exchange])))anchors.push(job.anchor);
    let files;
    try {files=await fs.readdir(path.join(this.root,'data','market-results'));}
    catch(error){if(error.code === 'ENOENT')return;throw error;}
    if(files.length>50000)throw new Error('Enrichment result scan limit reached.');
    const networkVersion=this.networkCatalog.views().map(v=>[v.venue,v.status,v.checked_at,v.attempted_at]);
    for(const file of files.sort()) {
      if(this.closed)break;
      if(!/^[a-f0-9]{64}\.json$/.test(file))continue;
      const inputFile=path.join(this.root,'data','market-results',file);
      const text=await fs.readFile(inputFile,'utf8');
      if(Buffer.byteLength(text)>16*1024*1024)throw new Error('Oversized enrichment input.');
      const input=JSON.parse(text);
      if(input.event_id !== file.slice(0,-5) || !Array.isArray(input.assets))throw new Error('Invalid market result for enrichment.');
      const relevant=anchors.filter(a=>a.exchange === input.listing_exchange && input.assets.some(asset=>symbolKey(asset.symbol) === symbolKey(a.symbol)));
      // Age transitions also change input identity, even without another API refresh.
      const expiry=[...relevant.map(a=>Date.parse(a.valid_until)),...input.assets.flatMap(a=>a.candidates.map(c=>Date.parse(c.valid_until)))];
      const starts=[...relevant.map(a=>Date.parse(a.confirmed_at)),...input.assets.flatMap(a=>a.candidates.map(c=>Date.parse(c.fetched_at)))];
      const ageState=[expiry.map(t=>Number.isFinite(t)&&t>this.now()),starts.map(t=>Number.isFinite(t)&&t<=this.now())];
      const hash=createHash('sha256').update(JSON.stringify([input,networkVersion,relevant,ageState])).digest('hex');
      const output=path.join(this.root,'data','enrichment-results',file);
      let previous;
      try {previous=JSON.parse(await fs.readFile(output,'utf8'));}
      catch(error){if(error.code !== 'ENOENT')throw error;}
      if(previous && (previous.event_id !== input.event_id || !previous.input_hash))throw new Error('Invalid existing enrichment result.');
      const result={...enrichResult(input,this.networkCatalog,anchors,this.now()),input_hash:hash};
      if(previous?.input_hash !== hash) {
        await writeJsonAtomic(output,result);
        this.onResult(result);
      }
      for(const asset of result.assets) {
        if(asset.anchor || !asset.symbol || result.listing_exchange !== 'upbit')continue;
        let url;
        try {url=new URL(result.source_url);}catch{continue;}
        if(url.protocol !== 'https:' || url.username || url.password || !['upbit.com','www.upbit.com'].includes(url.hostname) || url.pathname !== '/service_center/notice' || !/^\d+$/.test(url.searchParams.get('id') || ''))continue;
        const source_url=`https://upbit.com/service_center/notice?id=${url.searchParams.get('id')}`;
        const key=createHash('sha256').update(JSON.stringify([source_url,asset.symbol])).digest('hex');
        if(this.jobs.has(key))continue;
        if(this.jobs.size>=50000)throw new Error('Identity cache limit reached.');
        const job={key,source_url,symbol:asset.symbol,status:'QUEUED',next_attempt_at:0,anchor:null,error:null};
        await writeJsonAtomic(path.join(this.root,'data','identities',`${key}.json`),job);
        this.jobs.set(key,job);
      }
    }
  }
  resolveQueued() {
    if(this.closed)return Promise.resolve();
    if(this.resolverActive)return this.resolverActive;
    this.resolverActive=this.performResolve().finally(()=>{this.resolverActive=null;});return this.resolverActive;
  }
  async performResolve() {
    const pending=[...this.jobs.values()].filter(job=>job.next_attempt_at<=this.now()).slice(0,2);
    const outcomes=await Promise.allSettled(pending.map(async job=>{
      let next;
      try {
        const anchor=await this.resolveIdentity({sourceUrl:job.source_url,symbol:job.symbol,requestJson:(url,options)=>this.identityRequester(url,{...options,signal:this.controller.signal}),now:this.now});
        if(anchor)validateAnchor(anchor);
        next={...job,anchor,status:anchor?'CONFIRMED':'UNSUPPORTED_FORMAT',error:null,
          next_attempt_at:anchor?Date.parse(anchor.valid_until):this.now()+300000};
      } catch(error) {
        next={...job,anchor:null,status:'RETRY',error:{code:/^[A-Z_]{1,64}$/.test(error.code || '')?error.code:'IDENTITY_LOOKUP_FAILED'},next_attempt_at:this.now()+30000};
      }
      await writeJsonAtomic(path.join(this.root,'data','identities',`${job.key}.json`),next);
      this.jobs.set(job.key,next);
    }));
    const failure=outcomes.find(r=>r.status === 'rejected');if(failure)throw failure.reason;
  }
  start({onError=()=>{}}={}) {
    const fail=error=>{clearInterval(this.timer);this.timer=null;onError(error);};
    // Two independent lanes: local evaluation never awaits official identity HTTP.
    const tick=()=>{void this.drain().then(()=>this.resolveQueued()).catch(fail);};
    this.timer=setInterval(tick,1000);tick();
  }
  async close() {
    if(this.closing)return this.closing;
    this.closed=true;clearInterval(this.timer);this.timer=null;this.controller.abort();
    this.closing=(async()=>{try{const outcomes=await Promise.allSettled([this.active,this.resolverActive]);const failed=outcomes.find(r=>r.status === 'rejected');if(failed)throw failed.reason;}finally{await this.release();}})();return this.closing;
  }
}
module.exports={EnrichmentWorker};
