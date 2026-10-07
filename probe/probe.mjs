import fs from 'node:fs';
const urls={
 em:'https://np-listapi.eastmoney.com/comm/web/getFastNewsList?client=web&biz=web_724&fastColumn=102&sortEnd=&pageSize=200&req_trace='+Date.now(),
 sina:'https://zhibo.sina.com.cn/api/zhibo/feed?page=1&page_size=100&zhibo_id=152&tag_id=0&dire=f&dpc=1',
 cls:'https://www.cls.cn/nodeapi/updateTelegraphList?app=CailianpressWeb&os=web&sv=8.4.6&rn=100',
 jin10:'https://flash-api.jin10.com/get_flash_list?channel=-8200&vip=1',
 wsj:'https://api-one-wscn.awtmt.com/apiv1/content/lives?channel=global-channel&limit=100',
};
const out={};
for(const [k,u] of Object.entries(urls)){try{const r=await fetch(u,{headers:{'user-agent':'Mozilla/5.0','x-app-id':'bVBF4FyRTn5NJF5n','x-version':'1.0.0',referer:'https://www.jin10.com/'}});const t=await r.text();out[k]={status:r.status,len:t.length,head:t.slice(0,300)}}catch(e){out[k]={err:String(e)}}}
// Gemini grounding test
const key=process.env.GEMINI_API_KEY;
for(const m of ['gemini-3.6-flash','gemini-3.5-flash-lite','gemini-2.5-flash']){try{const r=await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${m}:generateContent?key=${key}`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({contents:[{parts:[{text:'用中文列出过去24小时内与半导体、美股科技股相关的3条重要新闻，每条附发布时间和来源。'}]}],tools:[{google_search:{}}]})});const t=await r.text();out['g_'+m]={status:r.status,head:t.slice(0,600)}}catch(e){out['g_'+m]={err:String(e)}}}
fs.writeFileSync('probe/result.json',JSON.stringify(out,null,1));
