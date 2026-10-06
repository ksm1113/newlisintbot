const fs = require('node:fs/promises');
const path = require('node:path');

async function inspect() {
  const url = 'https://newlistings.pro/listings/upbit/nmr-104e6va74go?utm_source=tg';
  const response = await fetch(url, {signal: AbortSignal.timeout(15000)});
  if (!response.ok) throw new Error(`Listing page HTTP ${response.status}`);
  const html = await response.text();
  const directory = path.resolve(__dirname, '../data/checks/nmr-source');
  await fs.mkdir(directory, {recursive:true});
  await fs.writeFile(path.join(directory, 'newlistings.html'), html);
  const visible = html.replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, '').replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
  console.log(visible.slice(0,20000));
  console.log('links:', [...html.matchAll(/href="([^"]+)"/g)].map(m=>m[1]).filter(u=>/upbit|numer|etherscan/.test(u)));
  console.log('source:', directory);
  const officialUrl = 'https://upbit.com/service_center/notice?id=330345227';
  const officialResponse = await fetch(officialUrl, {signal:AbortSignal.timeout(15000)});
  const officialHtml = await officialResponse.text();
  await fs.writeFile(path.join(directory, 'upbit.html'), officialHtml);
  console.log('official', officialResponse.status, officialHtml.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi,'').replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi,'').replace(/<[^>]+>/g,' ').replace(/\s+/g,' ').slice(0,14000));
  const notice = await fetch('https://pub-info.upbit.com/api/v1/announcements/330345227', {signal:AbortSignal.timeout(15000)});
  const json = await notice.json();
  await fs.writeFile(path.join(directory,'upbit-announcement.json'),JSON.stringify(json,null,2));
  console.log('announcement',notice.status,JSON.stringify(json).slice(0,24000));
}
async function main(args=process.argv.slice(2)) {
  if(args.length === 1 && args[0] === '--inspect')return inspect();
  if(args.length)throw new Error('Usage: node scripts/check-listing.cjs [--inspect]');
  const {Catalog}=require('../lib/markets/catalog.cjs');
  const {NetworkCatalog}=require('../lib/networks/catalog.cjs');
  const {EnrichmentWorker}=require('../lib/networks/enrichment-worker.cjs');
  const {LookupWorker}=require('../lib/markets/lookup-worker.cjs');
  const {InfoConsumer}=require('../lib/info-consumer.cjs');
  const {normalizeListing}=require('../lib/listing-event.cjs');
  const {writeJsonAtomic}=require('../lib/jsonl.cjs');
  const checks=path.resolve(__dirname,'../data/checks');
  await fs.mkdir(checks,{recursive:true});
  const root=await fs.mkdtemp(path.join(checks,'nmr-live-'));
  let catalog,networks,worker,enrichment,consumer;
  const report={schema_version:1,status:'FAILED',started_at:new Date().toISOString(),root,
    mode:'REAL_NMR_NOTICE_RECONSTRUCTION_AND_LIVE_PUBLIC_APIS',
    provenance:{alert_url:'https://newlistings.pro/listings/upbit/nmr-104e6va74go?utm_source=tg',
      official_url:'https://upbit.com/service_center/notice?id=330345227',
      directly_received_websocket:false,fixture:'RECONSTRUCTED_FROM_USER_LINK_AND_OFFICIAL_NOTICE'},
    private_api_policy:'NO_ACCOUNT_CREDENTIALS_LOADED_BY_THIS_CHECK',trading_allowed:false};
  try {
    const event=normalizeListing({type:'announcement',id:'reconstructed-nmr-20261006',url:report.provenance.official_url,
      content:{title:'뉴메레르(NMR) KRW, USDT 마켓 디지털 자산 추가'},
      parser:{exchange:'upbit',classification:{event:'listing',type:'spot',markets:['KRW','USDT']},assets:[{symbol:'NMR',name:'Numeraire',contracts:[]}]},
      test_provenance:report.provenance});
    await fs.mkdir(path.join(root,'data'),{recursive:true});
    await fs.writeFile(path.join(root,'data','listings.jsonl'),`${JSON.stringify(event)}\n`);
    consumer=await InfoConsumer.open({root});await consumer.drain();
    catalog=await Catalog.open({root});
    networks=await NetworkCatalog.open({root,credentials:{}});
    const results=await Promise.allSettled([catalog.refresh(),networks.refresh()]);
    for(const result of results)if(result.status === 'rejected')throw result.reason;
    report.catalog=results[0].value;
    report.networks=results[1].value;
    worker=await LookupWorker.open({root,catalog});await worker.drain();
    const marketFile=path.join(root,'data','market-results',`${event.event_id}.json`);
    const marketResult=JSON.parse(await fs.readFile(marketFile,'utf8'));
    enrichment=await EnrichmentWorker.open({root,networkCatalog:networks});
    await enrichment.drain(); // Immediate local output; no identity HTTP yet.
    await enrichment.resolveQueued();await enrichment.drain();
    const output=path.join(root,'data','enrichment-results',`${event.event_id}.json`);
    const enriched=JSON.parse(await fs.readFile(output,'utf8'));
    report.event_id=event.event_id;report.market_result=marketFile;report.enrichment_result=output;
    report.identity_status=enriched.assets[0].identity_status;
    report.identity_anchor=enriched.assets[0].anchor;
    report.candidate_count=marketResult.candidate_count;
    report.candidates=enriched.assets.flatMap(a=>a.candidates.map(c=>({venue:c.venue,market_type:c.market_type,market_id:c.market_id,
      identity_status:c.identity_status,route_status:c.route_status,route_filter_passed:c.route_filter_passed,
      reasons:c.reasons,routes:c.routes})));
    report.compatible_spot_count=enriched.assets.reduce((n,a)=>n+a.compatible_spot_candidates.length,0);
    report.eligible_spot_count=enriched.eligible_spot_count;
    report.status=report.catalog.fresh_segments === report.catalog.total_segments &&
      report.networks.filter(n=>['bitget','gate'].includes(n.venue)).every(n=>n.status === 'OK')?'PASSED_WITH_AUTH_HOLDS':'PARTIAL';
  }catch(error){report.error=error.cause?.code || error.code || error.message;}
  finally {
    const outcomes=await Promise.allSettled([consumer?.close(),worker?.close(),catalog?.close(),networks?.close(),enrichment?.close()]);
    const failed=outcomes.find(row=>row.status === 'rejected');if(failed){report.status='FAILED';report.error='CHECK_SHUTDOWN_FAILED';}
  }
  report.finished_at=new Date().toISOString();await writeJsonAtomic(path.join(root,'report.json'),report);
  console.log(`[NMR 검사] ${report.status} / 상품군 ${report.catalog?.fresh_segments}/${report.catalog?.total_segments}`);
  console.log(`후보 ${report.candidate_count || 0}개 / 신원 ${report.identity_status || 'UNVERIFIED'} / 망 일치 ${report.compatible_spot_count || 0}개 / 경로 필터 통과 ${report.eligible_spot_count || 0}개`);
  for(const row of report.candidates || [])console.log(`${row.venue}/${row.market_type}/${row.market_id}: ${row.identity_status} / ${row.route_status}`);
  for(const row of report.networks || [])console.log(`[네트워크] ${row.venue}: ${row.status} / ${row.coin_count}개`);
  if(report.error)console.error(report.error);
  console.log(`보고서: ${path.join(root,'report.json')}`);
  if(report.status !== 'PASSED_WITH_AUTH_HOLDS')process.exitCode=1;
  return report;
}
if (require.main === module) main().catch(error=>{console.error(error.cause?.code || error.message);process.exitCode=1;});
module.exports = {inspect,main};
