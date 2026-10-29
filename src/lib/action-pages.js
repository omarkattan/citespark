import {lookup} from 'node:dns/promises';
import {isIP} from 'node:net';
import {request} from 'node:https';
import {Readable} from 'node:stream';

const normalHost=value=>String(value).toLowerCase().replace(/^www\./,'');
export function ownPageUrl(value,domain,base=`https://${domain}/`) {
  try {
    if(typeof value!=='string'||!value.trim())return null;
    const u=new URL(value,base);
    if(u.protocol!=='https:' || u.username || u.password || u.port || normalHost(u.hostname)!==normalHost(domain))return null;
    if(isIP(u.hostname) || !u.hostname.includes('.') || /\.(local|localhost|internal|test|invalid)$/.test(u.hostname))return null;
    if(/\.(pdf|png|jpe?g|gif|svg|webp|zip|css|js|xml)$/i.test(u.pathname) || /\/(cart|checkout|account|login|logout|admin)(\/|$)/i.test(u.pathname))return null;
    u.hash='';u.search='';return u.href;
  }catch{return null;}
}
export function publicAddress(address) {
  if(isIP(address)===4){const [a,b]=address.split('.').map(Number);return !(a===0||a===10||a===127||a>=224||a===169&&b===254||a===172&&b>=16&&b<=31||a===192&&[0,168].includes(b)||a===100&&b>=64&&b<=127||a===198&&[18,19,51].includes(b)||a===203&&b===0);}
  // Exclude mapped, local, multicast, documentation and transition ranges.
  return isIP(address)===6 && /^2[0-9a-f]{3}:/i.test(address) && !/^(2001:(db8|0):|2002:)/i.test(address);
}
const decode=text=>String(text).replace(/&(?:amp|lt|gt|quot|apos|nbsp);|&#(x[0-9a-f]+|\d+);/gi,(m,n)=>{
  if(n){const code=n[0].toLowerCase()==='x'?parseInt(n.slice(1),16):Number(n);return code>0&&code<=0x10ffff?String.fromCodePoint(code):' ';}
  return ({'&amp;':'&','&lt;':'<','&gt;':'>','&quot;':'"','&apos;':"'",'&nbsp;':' '})[m.toLowerCase()]||m;
});
export const plainText=html=>decode(String(html).replace(/<(script|style|noscript|svg)\b[^>]*>[\s\S]*?<\/\1>/gi,' ').replace(/<[^>]*>/g,' ')).replace(/\s+/g,' ').trim();
export function pageFromHtml(html,url,domain) {
  const links=[];
  for(const match of html.matchAll(/<a\b[^>]*href\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi)) {
    const href=ownPageUrl(decode(match[1]),domain,url);
    if(href&&!links.some(x=>x.url===href))links.push({url:href,label:plainText(match[2]).slice(0,180)});
    if(links.length>=250)break;
  }
  const title=plainText(html.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i)?.[1]||'');
  const content=html.replace(/<(nav|header|footer)\b[^>]*>[\s\S]*?<\/\1>/gi,' ');
  return {url,title,text:plainText(content).slice(0,14000),links,read_at:new Date().toISOString()};
}
const stops=new Set('what which how when where why who the a an and or for of to in on with does do is are can i my your best most should much many more uk uae business brand products product'.split(' '));
export function words(text) {return [...new Set(String(text).toLowerCase().normalize('NFKC').replace(/\p{M}/gu,'').match(/[\p{L}\p{N}]{3,}/gu)||[])].filter(w=>!stops.has(w));}
export function pageMatch(question,page) {
  let path=new URL(page.url).pathname;try{path=decodeURIComponent(path);}catch{}
  const terms=words(question);const label=(page.title||page.label||'')+' '+path;
  const top=words(label),body=words(page.text||'');
  return terms.reduce((sum,w)=>sum+(top.includes(w)?5:body.includes(w)?1:0),0);
}
// Pin the checked DNS answers to the connection. A second resolver lookup must
// not turn a public-domain read into a request to a private address.
function pinnedFetch(url,{signal,headers,addresses}) {
  return new Promise((resolve,reject)=>{
    const req=request(url,{method:'GET',signal,headers,lookup:(_host,options,callback)=>{
      const matching=addresses.filter(a=>!options.family||a.family===options.family);
      if(!matching.length)return callback(new Error('No public address for this address family'));
      if(options.all)callback(null,matching);else callback(null,matching[0].address,matching[0].family);
    }},res=>{
      const h=new Headers();for(const [key,value] of Object.entries(res.headers))if(value)h.set(key,Array.isArray(value)?value.join(', '):value);
      resolve({status:res.statusCode,ok:res.statusCode>=200&&res.statusCode<300,headers:h,body:Readable.toWeb(res)});
    });req.on('error',reject);req.end();
  });
}
function withAbort(promise,signal){return new Promise((resolve,reject)=>{
  const abort=()=>reject(new Error('Page read timed out'));
  if(signal.aborted)return abort();signal.addEventListener('abort',abort,{once:true});
  promise.then(resolve,reject).finally(()=>signal.removeEventListener('abort',abort));
});}
export async function readOwnPage(url,domain,{fetchImpl=pinnedFetch,lookupImpl=lookup}={}) {
  let current=ownPageUrl(url,domain);if(!current)return null;
  const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),9000);
  try {
    for(let redirects=0;redirects<3;redirects++){
      const addresses=await withAbort(lookupImpl(new URL(current).hostname,{all:true}),controller.signal);
      if(!addresses.length || addresses.some(a=>!publicAddress(a.address)))return null;
      const res=await fetchImpl(current,{redirect:'manual',addresses,signal:controller.signal,headers:{'User-Agent':'CitedBot/1.0 (+https://cited.ae/bot)',Accept:'text/html'}});
      if([301,302,303,307,308].includes(res.status)){await res.body?.cancel();current=ownPageUrl(res.headers.get('location'),domain,current);if(!current)return null;continue;}
      if(!res.ok || !/text\/html/i.test(res.headers.get('content-type')||'') || Number(res.headers.get('content-length'))>1500000){await res.body?.cancel();return null;}
      const reader=res.body.getReader();let size=0,html='';const decoder=new TextDecoder();
      while(true){const {done,value}=await reader.read();if(done)break;size+=value.byteLength;if(size>1500000){await reader.cancel();return null;}html+=decoder.decode(value,{stream:true});}
      const page=pageFromHtml(html+decoder.decode(),current,domain);
      return page.text.length>=100?page:null;
    }
  }catch{return null;}finally{clearTimeout(timer);}
  return null;
}
export async function readActionPages(domain,questions,{readPage=readOwnPage}={}) {
  const home=await readPage(`https://${domain}/`,domain);if(!home)return [];
  const choices=[];
  // Give each question a relevant page before filling the small read budget.
  const ranked=questions.map(q=>home.links.filter(l=>l.url!==home.url).map(l=>({...l,score:pageMatch(q,l)})).filter(l=>l.score>0).sort((a,b)=>b.score-a.score));
  for(let round=0;round<3&&choices.length<3;round++)for(const links of ranked){const link=links[round];if(link&&!choices.includes(link.url)&&choices.length<3)choices.push(link.url);}
  const pages=await Promise.all(choices.map(url=>readPage(url,domain)));
  return [home,...pages.filter(Boolean)].map((page,i)=>({...page,id:`page-${i+1}`}));
}
