import fs from 'node:fs';
const urls={
 tx_kline:'https://web.ifzq.gtimg.cn/appstock/app/fqkline/get?param=sh000001,day,,,5,qfq',
 tx_kline_etf:'https://web.ifzq.gtimg.cn/appstock/app/fqkline/get?param=sh512480,day,,,5,qfq',
 tx_hk:'https://web.ifzq.gtimg.cn/appstock/app/fqkline/get?param=hkHSTECH,day,,,5,qfq',
 sina_k:'https://quotes.sina.cn/cn/api/jsonp_v2.php/var/CN_MarketDataService.getKLineData?symbol=sh000001&scale=240&ma=no&datalen=5',
 tx_q:'https://qt.gtimg.cn/q=sh000001,sz399006,sh000688,sh512480,sh515260,hkHSTECH',
 fundgz:'https://fundgz.1234567.com.cn/js/002910.js',
 yahoo_sh:'https://query1.finance.yahoo.com/v8/finance/chart/000001.SS?range=10d&interval=1d',
};
const out={};
for(const [k,u] of Object.entries(urls)){try{const r=await fetch(u,{headers:{'user-agent':'Mozilla/5.0',referer:'https://finance.sina.com.cn/'}});const b=Buffer.from(await r.arrayBuffer());let t=b.toString('utf8');if(k==='tx_q')t=new TextDecoder('gbk').decode(b);out[k]={status:r.status,head:t.slice(0,700)}}catch(e){out[k]={err:String(e)}}}
fs.writeFileSync('probe/result.json',JSON.stringify(out,null,1));
