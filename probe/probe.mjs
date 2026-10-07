import fs from 'node:fs';
const out={};const key=process.env.GEMINI_API_KEY;
async function g(m,tools){const r=await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${m}:generateContent?key=${key}`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({contents:[{parts:[{text:'用中文一句话：过去24小时美股半导体板块有什么重要新闻？附来源。'}]}],...(tools?{tools:[{google_search:{}}]}:{})})});const t=await r.text();return {status:r.status,head:t.slice(0,500)}}
for(const m of ['gemini-3.8-flash','gemini-3.6-flash','gemini-3.5-flash-lite']){for(const t of [false,true]){try{out[m+(t?'+search':'')]=await g(m,t)}catch(e){out[m]={err:String(e)}}}}
const ms=await fetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${key}&pageSize=100`).then(r=>r.json()).catch(e=>({e:String(e)}));
out.models=(ms.models||[]).map(m=>m.name).join(' ');
// paging depth tests
async function j(u,h={}){const r=await fetch(u,{headers:{'user-agent':'Mozilla/5.0',...h}});return r.json()}
try{const a=await j('https://api-one-wscn.awtmt.com/apiv1/content/lives?channel=global-channel&limit=100');const it=a.data.items;out.wscn={n:it.length,first:it[0].display_time,last:it.at(-1).display_time,next:a.data.next_cursor,sample:it.slice(0,3).map(x=>x.content_text.slice(0,80))}}catch(e){out.wscn={err:String(e)}}
try{const a=await j('https://flash-api.jin10.com/get_flash_list?channel=-8200&vip=1',{'x-app-id':'bVBF4FyRTn5NJF5n','x-version':'1.0.0',referer:'https://www.jin10.com/'});const it=a.data;out.jin10={n:it.length,first:it[0].time,last:it.at(-1).time,sample:it.slice(0,3).map(x=>JSON.stringify(x.data).slice(0,120))}}catch(e){out.jin10={err:String(e)}}
try{const a=await j('https://zhibo.sina.com.cn/api/zhibo/feed?page=5&page_size=100&zhibo_id=152&tag_id=0&dire=f&dpc=1');const it=a.result.data.feed.list;out.sina5={n:it.length,first:it[0].create_time,last:it.at(-1).create_time}}catch(e){out.sina5={err:String(e)}}
fs.writeFileSync('probe/result.json',JSON.stringify(out,null,1));
