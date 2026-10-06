const fs = require('node:fs/promises');
const path = require('node:path');
const {acquireLock} = require('../lock.cjs');
const {writeJsonAtomic} = require('../jsonl.cjs');
const {createNetworkRequester} = require('./http.cjs');

const IDS = ['binance','bybit','okx','bitget','gate','upbit'];
function credentialsFromEnv(env = process.env) {
  return Object.fromEntries(IDS.map(id => {
    const prefix = id.toUpperCase();
    return [id, {apiKey:env[`${prefix}_API_KEY`], apiSecret:env[`${prefix}_API_SECRET`], passphrase:env[`${prefix}_API_PASSPHRASE`]}];
  }));
}
const symbolKey = value => typeof value === 'string' ? value.trim().toUpperCase() : null;
function validateCoins(coins, venue) {
  if (!Array.isArray(coins) || coins.length > 20000) throw new Error('Invalid network coin list.');
  const seen = new Set();
  return coins.map(coin => {
    const key = symbolKey(coin.coin);
    if (coin.venue !== venue || !key || seen.has(key) || !Array.isArray(coin.networks) || coin.networks.length > 100) throw new Error('Invalid or duplicate network currency.');
    seen.add(key);
    const url = new URL(coin.source);
    if (url.protocol !== 'https:' || url.search || url.username || url.password) throw new Error('Invalid unsigned network source.');
    const codes = new Set();
    const networks = coin.networks.map(item => {
      const code = symbolKey(item.network_code);
      if (!code || codes.has(code)) throw new Error('Invalid or duplicate network chain.');
      codes.add(code);
      for (const field of ['deposit_enabled','withdraw_enabled','withdraw_delayed','need_tag']) {
        if (![true,false,null].includes(item[field])) throw new Error('Invalid network flag.');
      }
      if (item.contract_address != null && typeof item.contract_address !== 'string') throw new Error('Invalid network contract.');
      // Store only metadata output by the adapters. No complete response/account raw.
      const {raw, ...metadata} = item;
      return metadata;
    });
    const {raw, ...metadata} = coin;
    return {...metadata, networks};
  });
}
class NetworkCatalog {
  static async open({root, adapters = IDS.map(id=>require(`./adapters/${id}.cjs`)), requestJson,
    credentials = credentialsFromEnv(), now = Date.now, refreshIntervalMs = 300000, ttlMs = 600000, retryMs = 30000} = {}) {
    if (!root || !adapters.length || new Set(adapters.map(a=>a.id)).size !== adapters.length ||
        ![refreshIntervalMs,ttlMs,retryMs].every(n=>Number.isSafeInteger(n)&&n>0)) throw new Error('Invalid network catalog configuration.');
    const self = new NetworkCatalog();
    Object.assign(self, {root,adapters,requestJson:requestJson || createNetworkRequester(),credentials,now,refreshIntervalMs,ttlMs,retryMs,
      records:new Map(), listeners:new Set(),closed:false,timer:null,active:null,controller:new AbortController()});
    await fs.mkdir(path.join(root,'state'),{recursive:true});
    await fs.mkdir(path.join(root,'data','networks'),{recursive:true});
    self.release = await acquireLock(path.join(root,'state','networks.lock'));
    try {
      for (const adapter of adapters) {
        let record, exists=false;
        try {record = JSON.parse(await fs.readFile(self.file(adapter.id),'utf8'));exists=true;}
        catch (error) {if(error.code !== 'ENOENT') throw error;}
        if (exists) {
          if (!record || typeof record !== 'object' || Array.isArray(record) || record.schema_version !== 1 || record.venue !== adapter.id || !['OK','ERROR','AUTH_REQUIRED'].includes(record.status) ||
              !Number.isFinite(Date.parse(record.attempted_at)) || !Number.isFinite(Date.parse(record.next_refresh_at))) throw new Error('Invalid network snapshot.');
          record.coins = validateCoins(record.coins,adapter.id);
          if ((record.status === 'OK' || record.checked_at != null || record.valid_until != null) && (!Number.isFinite(Date.parse(record.checked_at)) || !Number.isFinite(Date.parse(record.valid_until)) || Date.parse(record.valid_until)<=Date.parse(record.checked_at))) throw new Error('Invalid network snapshot dates.');
          self.records.set(adapter.id,record);
        }
      }
      return self;
    } catch(error) {await self.release();throw error;}
  }
  file(id) {return path.join(this.root,'data','networks',`${id}.json`);}
  views() {
    return this.adapters.map(adapter=>{
      const row = this.records.get(adapter.id);
      if (!row) return {venue:adapter.id,status:'NOT_FETCHED',checked_at:null,valid_until:null,coins:[]};
      const fresh = row.status === 'OK' && Date.parse(row.valid_until)>this.now() && Date.parse(row.checked_at)<=this.now();
      return {...row, status:row.status === 'OK' && !fresh ? 'STALE' : row.status};
    });
  }
  coin(venue,coin) {
    const view = this.views().find(row=>row.venue === venue);
    const found = view?.coins.find(row=>symbolKey(row.coin) === symbolKey(coin));
    return {...(found || {venue,coin,networks:[]}),status:view?.status || 'NOT_FETCHED',
      checked_at:view?.checked_at || null, valid_until:view?.valid_until || null,
      currency_status:found ? 'FOUND' : view?.status === 'OK' ? 'NOT_IN_ACCOUNT_SCOPE' : 'UNKNOWN', error:view?.error || null};
  }
  refresh({dueOnly=false} = {}) {
    if (this.closed) return Promise.resolve();
    if (this.active) return this.active;
    this.active = this.performRefresh(dueOnly).finally(()=>{this.active=null;});
    return this.active;
  }
  async performRefresh(dueOnly) {
    // API failures are records; persistence/schema recovery failures remain fatal.
    const outcomes = await Promise.allSettled(this.adapters.map(async adapter=>{
      const prior = this.records.get(adapter.id);
      if (dueOnly && prior && Date.parse(prior.next_refresh_at)>this.now()) return;
      let record;
      const attempted = this.now();
      try {
        const coins = validateCoins(await adapter.fetchCoins({requestJson:this.requestJson,credentials:this.credentials[adapter.id],signal:this.controller.signal}),adapter.id);
        const finished = this.now();
        record = {schema_version:1,venue:adapter.id,status:'OK',coins,attempted_at:new Date(attempted).toISOString(),
          checked_at:new Date(finished).toISOString(),valid_until:new Date(finished+this.ttlMs).toISOString(),
          next_refresh_at:new Date(finished+this.refreshIntervalMs).toISOString(),error:null};
      } catch(error) {
        const code = /^[A-Z][A-Z0-9_]{0,63}$/.test(error.code || '') ? error.code : 'METADATA_ERROR';
        const wait = code === 'AUTH_REQUIRED' ? this.refreshIntervalMs : Math.max(this.retryMs,Number.isFinite(error.retryAfterMs)?error.retryAfterMs:0);
        record = {schema_version:1,venue:adapter.id,status:code === 'AUTH_REQUIRED'?'AUTH_REQUIRED':'ERROR',coins:prior?.coins || [],
          checked_at:prior?.checked_at || null,valid_until:prior?.valid_until || null,attempted_at:new Date(attempted).toISOString(),
          next_refresh_at:new Date(this.now()+wait).toISOString(),error:{code,message:'Network metadata unavailable.'}};
      }
      await writeJsonAtomic(this.file(adapter.id),record);
      this.records.set(adapter.id,record);
      for(const listener of this.listeners) listener(record);
    }));
    const failed = outcomes.find(row=>row.status === 'rejected');
    if (failed) throw failed.reason;
    return this.views().map(({coins,...row})=>({...row,coin_count:coins.length}));
  }
  subscribe(listener) {this.listeners.add(listener);return ()=>this.listeners.delete(listener);}
  start({onError=()=>{}}={}) {
    const tick=()=>{void this.refresh({dueOnly:true}).catch(onError);};
    this.timer=setInterval(tick,1000);tick();
  }
  async close() {
    if (this.closing) return this.closing;
    this.closed=true;clearInterval(this.timer);this.timer=null;this.controller.abort();
    this.closing=(async()=>{try{await this.active;}finally{await this.release();}})();return this.closing;
  }
}
module.exports = {NetworkCatalog,credentialsFromEnv,validateCoins};
