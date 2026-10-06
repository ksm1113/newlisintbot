const {normalizeChain,normalizeContract} = require('./chains.cjs');
const {normalizeUrl} = require('../listing-event.cjs');
const {symbolKey} = require('../markets/matcher.cjs');

function fresh(record,now) {
  return record?.status === 'OK' && Number.isFinite(Date.parse(record.checked_at)) &&
    Date.parse(record.checked_at)<=now && Date.parse(record.valid_until)>now;
}
function listingUrl(value) {
  try {
    const url=new URL(normalizeUrl(value));
    if (['upbit.com','www.upbit.com'].includes(url.hostname) && url.pathname === '/service_center/notice') {
      return `https://upbit.com/service_center/notice?id=${url.searchParams.get('id')}`;
    }
    return url.toString();
  } catch {return null;}
}
function validateAnchor(anchor) {
  if (!anchor || anchor.confirmed !== true || !symbolKey(anchor.symbol) || !anchor.exchange ||
      !anchor.source_url || !Array.isArray(anchor.contracts) || !anchor.contracts.length ||
      !Array.isArray(anchor.deposit_networks) || !anchor.deposit_networks.length ||
      !Number.isFinite(Date.parse(anchor.confirmed_at)) || !Number.isFinite(Date.parse(anchor.valid_until)) ||
      !Array.isArray(anchor.evidence) || !anchor.evidence.length) throw new Error('Invalid verified identity anchor.');
  const sourceUrl=new URL(anchor.source_url);
  if(sourceUrl.protocol !== 'https:' || sourceUrl.username || sourceUrl.password ||
    (anchor.scope != null && !['NOTICE','VENUE_ASSET'].includes(anchor.scope)) || Date.parse(anchor.valid_until)<=Date.parse(anchor.confirmed_at))throw new Error('Invalid identity anchor scope or dates.');
  for (const evidence of anchor.evidence) {
    const url = new URL(evidence.url);
    if (url.protocol !== 'https:' || evidence.authority !== 'OFFICIAL' || !evidence.purpose) throw new Error('Invalid official identity evidence.');
  }
  const keys = new Set();
  for (const contract of anchor.contracts) {
    if (contract.token_kind !== 'TOKEN' || !normalizeContract(contract.chain_id,contract.contract_address)) {
      // Native representations need a separate verified model; an empty CA is not evidence.
      throw new Error('Unsupported or incomplete verified token contract.');
    }
    const key = `${contract.chain_id}/${normalizeContract(contract.chain_id,contract.contract_address)}`;
    if (keys.has(key)) throw new Error('Duplicate verified token contract.');keys.add(key);
  }
  for (const chain of anchor.deposit_networks) if (!anchor.contracts.some(c=>c.chain_id === chain)) throw new Error('Unbound deposit network.');
  return anchor;
}
function selectAnchor(anchors, result, asset, now) {
  const source=listingUrl(result.source_url);
  const found = anchors.filter(a=>Date.parse(a.confirmed_at)<=now && Date.parse(a.valid_until)>now && symbolKey(a.symbol) === symbolKey(asset.symbol) && a.exchange === result.listing_exchange &&
    (a.scope === 'VENUE_ASSET' || (source && listingUrl(a.source_url) === source)));
  if (!found.length) return null;
  const signature=a=>JSON.stringify([a.contracts.map(c=>`${c.chain_id}/${normalizeContract(c.chain_id,c.contract_address)}`).sort(),[...a.deposit_networks].sort()]);
  found.forEach(validateAnchor);
  if(new Set(found.map(signature)).size>1)return null;
  const anchor = found.find(a=>a.scope !== 'VENUE_ASSET') || found[0];
  if (Date.parse(anchor.confirmed_at)>now || Date.parse(anchor.valid_until)<=now) return null;
  // Conflicting feed contracts remain visible and require reconciliation.
  for (const contract of asset.contracts || []) {
    const feedChains={ethereum:'eip155:1',arbitrum:'eip155:42161',optimism:'eip155:10',base:'eip155:8453',polygon:'eip155:137',bsc:'eip155:56',solana:'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp'};
    const chain = contract.chain_id || feedChains[contract.chain?.toLowerCase()] || normalizeChain(result.listing_exchange,contract.chain);
    const address = normalizeContract(chain,contract.contract_address || contract.contract);
    if (!address || !anchor.contracts.some(c=>c.chain_id === chain && normalizeContract(chain,c.contract_address) === address)) return null;
  }
  return anchor;
}
function verifyCandidate(candidate,anchor,networkCatalog,listingExchange,symbol,now) {
  const held = reason=>({...candidate,identity_status:'UNVERIFIED',asset_id:null,route_status:'HELD',route_filter_passed:false,
    reasons:[reason],routes:[],trading_allowed:false});
  if (candidate.market_type !== 'spot') {
    // A spot wallet's ticker/CA cannot prove a derivative's underlying/index.
    return {...held('DERIVATIVE_UNDERLYING_MAPPING_REQUIRED'),route_status:'NOT_APPLICABLE'};
  }
  // CEX routes are matched by ticker + chain. An official CA anchor is recorded
  // as identity information only; it is kept for later DEX pool lookups.
  if (anchor) validateAnchor(anchor);
  const proof = anchor && Date.parse(anchor.confirmed_at)<=now && Date.parse(anchor.valid_until)>now &&
    anchor.exchange === listingExchange && symbolKey(anchor.symbol) === symbolKey(symbol) ? anchor : null;
  const assetId = proof ? `${proof.contracts[0].chain_id}/${proof.contracts[0].chain_id.startsWith('solana:')?'token':'erc20'}:${normalizeContract(proof.contracts[0].chain_id,proof.contracts[0].contract_address)}` : null;
  const source = networkCatalog.coin(candidate.venue,candidate.base_symbol);
  const destination = networkCatalog.coin(listingExchange,symbol);
  const sourceFresh = fresh(source,now), destinationFresh = fresh(destination,now);
  const routes = source.networks.map(network=>{
    const chain = normalizeChain(candidate.venue,network.network_code);
    const ca = normalizeContract(chain,network.contract_address);
    const bound = proof?.contracts.find(c=>c.chain_id === chain && normalizeContract(chain,c.contract_address) === ca);
    const destNetworks = chain ? destination.networks.filter(n=>normalizeChain(listingExchange,n.network_code) === chain) : [];
    const reasons=[], warnings=[];
    if (!sourceFresh) reasons.push(`SOURCE_${source.status}`);
    if (!chain) reasons.push('UNKNOWN_SOURCE_CHAIN');
    if (candidate.venue === listingExchange) reasons.push('SOURCE_IS_LISTING_DESTINATION');
    if (candidate.catalog_status !== 'FRESH' || !Number.isFinite(Date.parse(candidate.valid_until)) || !Number.isFinite(Date.parse(candidate.fetched_at)) || Date.parse(candidate.valid_until)<=now || Date.parse(candidate.fetched_at)>now) reasons.push('MARKET_CATALOG_NOT_FRESH');
    if (candidate.market_status !== 'ACTIVE') reasons.push('MARKET_NOT_ACTIVE');
    if (candidate.limits?.buy_enabled === false) reasons.push('SPOT_BUY_DISABLED');
    if (candidate.venue === 'okx' && candidate.limits?.ruleType != null && candidate.limits.ruleType !== 'normal') reasons.push('RESTRICTED_MARKET_RULE');
    if (source.delisted === true || source.trade_disabled === true) reasons.push('SOURCE_CURRENCY_DISABLED');
    if (network.withdraw_enabled !== true) reasons.push(network.withdraw_enabled === false?'WITHDRAWAL_DISABLED':'WITHDRAWAL_STATUS_UNKNOWN');
    if (network.withdraw_delayed === true) reasons.push('WITHDRAWAL_DELAYED');
    if (!destinationFresh) reasons.push(`DESTINATION_${destination.status}`);
    else if (destination.currency_status !== 'FOUND' && !destination.networks.length) reasons.push('DESTINATION_CURRENCY_NOT_FOUND');
    else if (chain && destNetworks.length !== 1) reasons.push(destNetworks.length?'AMBIGUOUS_DESTINATION_CHAIN':'DESTINATION_CHAIN_NOT_SUPPORTED');
    const dest = destNetworks.length === 1 ? destNetworks[0] : null;
    // CA and the destination's current deposit status are recorded, not used as gates.
    const destCa = dest?.contract_address ? normalizeContract(chain,dest.contract_address) : null;
    if (ca && destCa && destCa !== ca) warnings.push('CONTRACT_DIFFERS');
    const compatible = !!chain && !!dest && sourceFresh && destinationFresh;
    return {chain_id:chain,contract_address:ca,destination_contract_address:destCa,source_network_code:network.network_code,
      destination_network_code:dest?.network_code || null,identity_status:sourceFresh && bound?'VERIFIED':'UNVERIFIED',
      network_compatible:compatible,route_filter_passed:reasons.length === 0,
      status:reasons.length === 0?'FILTER_PASSED':compatible?'NETWORK_COMPATIBLE_HELD':'EXCLUDED_OR_UNKNOWN',reasons,warnings,
      destination_status_realtime:dest?.status_realtime ?? null,
      withdraw_enabled:network.withdraw_enabled,deposit_enabled:dest?.deposit_enabled ?? null,
      withdraw_delayed:network.withdraw_delayed,min_withdraw:network.min_withdraw ?? null,withdraw_fee:network.withdraw_fee ?? null,
      need_tag:network.need_tag,source:{url:source.source || null,checked_at:source.checked_at,valid_until:source.valid_until},
      destination:{url:destination.source || null,checked_at:destination.checked_at,valid_until:destination.valid_until,status_notice:dest?.status_notice || null},
      assurance:'CACHED_METADATA_FILTER_ONLY',trading_allowed:false};
  });
  const verified = routes.some(r=>r.identity_status === 'VERIFIED');
  const pass = routes.some(r=>r.route_filter_passed);
  return {...candidate,identity_status:verified?'VERIFIED':'UNVERIFIED',asset_id:verified?assetId:null,
    route_status:pass?'FILTER_PASSED':routes.some(r=>r.network_compatible)?'NETWORK_COMPATIBLE_HELD':'HELD',route_filter_passed:pass,routes,
    reasons:routes.length ? [] : [sourceFresh?'SOURCE_CURRENCY_OR_NETWORK_NOT_IN_ACCOUNT_SCOPE':`SOURCE_${source.status}`],trading_allowed:false};
}
function enrichResult(result,networkCatalog,anchors,now=Date.now()) {
  const assets = result.assets.map(asset=>{
    const anchor=selectAnchor(anchors,result,asset,now);
    const candidates=asset.candidates.map(candidate=>verifyCandidate(candidate,anchor,networkCatalog,result.listing_exchange,asset.symbol,now));
    return {...asset,anchor:anchor || null,identity_status:anchor?'LISTED_ASSET_VERIFIED':'UNVERIFIED',candidates,
      eligible_spot_candidates:candidates.filter(c=>c.market_type === 'spot' && c.route_filter_passed),
      compatible_spot_candidates:candidates.filter(c=>c.market_type === 'spot' && c.routes.some(r=>r.network_compatible)),
      perpetual_candidates:candidates.filter(c=>c.market_type === 'perpetual'),trading_allowed:false};
  });
  return {schema_version:1,event_id:result.event_id,prepared_at:new Date(now).toISOString(),
    status:'ROUTE_FILTER_EVALUATED',
    source_url:result.source_url,listing_exchange:result.listing_exchange,market_result_prepared_at:result.prepared_at,
    candidate_count:result.candidate_count,assets,eligible_spot_count:assets.reduce((n,a)=>n+a.eligible_spot_candidates.length,0),
    network_coverage:networkCatalog.views().map(({coins,...row})=>({...row,coin_count:coins.length})),
    trading_allowed:false,dex_spot:{status:'NOT_QUERIED'}};
}
module.exports={fresh,validateAnchor,selectAnchor,verifyCandidate,enrichResult};
