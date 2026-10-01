import { createServer } from 'node:http';
import { pathToFileURL } from 'node:url';

export function createMetadataServer({key, channelId, fetchImpl=fetch, now=Date.now, maxLookups=120}={}) {
  const origins=new Set(['https://nickdiramio.com','https://www.nickdiramio.com','https://3171c3-a9.myshopify.com']);
  const cache=new Map(), pending=new Map();
  let hour=-1, lookups=0;
  async function lookup(id) {
    const previous=cache.get(id);
    if(previous && previous.expires>now()) return previous.value;
    if(pending.has(id)) return pending.get(id);
    const currentHour=Math.floor(now()/3600000);
    if(hour!==currentHour){hour=currentHour;lookups=0;}
    if(lookups>=maxLookups || pending.size>=10) throw Object.assign(new Error('rate_limited'),{status:429});
    lookups++;
    const task=(async()=>{
      const url=new URL('https://www.googleapis.com/youtube/v3/videos');
      url.search=new URLSearchParams({part:'snippet,status',id,key,fields:'items(id,snippet(title,publishedAt,channelId),status(privacyStatus,embeddable))'}).toString();
      const response=await fetchImpl(url,{signal:AbortSignal.timeout(8000)});
      if(!response.ok) throw new Error('upstream_unavailable');
      const data=await response.json();const video=data.items?.[0];
      const valid=video?.id===id && video.snippet?.channelId===channelId && video.status?.privacyStatus==='public' && video.status?.embeddable!==false && typeof video.snippet?.title==='string' && Number.isFinite(Date.parse(video.snippet?.publishedAt));
      const value=valid?{videoId:id,title:video.snippet.title,publishedAt:new Date(video.snippet.publishedAt).toISOString()}:null;
      if(cache.size>=1000) cache.delete(cache.keys().next().value);
      cache.set(id,{value,expires:now()+(value?86400000:600000)});
      return value;
    })();
    pending.set(id,task);
    try{return await task;}finally{pending.delete(id);}
  }
  return createServer(async(req,res)=>{
    res.setHeader('Content-Type','application/json; charset=utf-8');
    res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('Vary','Origin');
    const origin=req.headers.origin;
    const send=(status,body)=>{res.statusCode=status;res.end(JSON.stringify(body));};
    if(origin && !origins.has(origin)) return send(403,{error:'origin_not_allowed'});
    if(origin) res.setHeader('Access-Control-Allow-Origin',origin);
    if(req.method==='OPTIONS'){res.setHeader('Access-Control-Allow-Methods','GET, OPTIONS');res.statusCode=204;return res.end();}
    if(req.method!=='GET') return send(405,{error:'method_not_allowed'});
    const url=new URL(req.url,'http://localhost');
    if(url.pathname==='/health') return send(200,{ok:Boolean(key && channelId)});
    if(url.pathname!=='/video-metadata') return send(404,{error:'not_found'});
    const id=url.searchParams.get('id');
    if(!/^[A-Za-z0-9_-]{11}$/.test(id||'')) return send(400,{error:'invalid_video_id'});
    if(!key || !channelId) return send(503,{error:'service_not_configured'});
    try{
      const value=await lookup(id);
      if(!value){res.setHeader('Cache-Control','public, max-age=300');return send(404,{error:'video_unavailable'});}
      res.setHeader('Cache-Control','public, max-age=300');return send(200,value);
    }catch(error){res.setHeader('Cache-Control','no-store');if(error.status===429){res.setHeader('Retry-After','3600');return send(429,{error:'rate_limited'});}return send(502,{error:'metadata_unavailable'});}
  });
}
if(process.argv[1] && import.meta.url===pathToFileURL(process.argv[1]).href){
  const server=createMetadataServer({key:process.env.YOUTUBE_API_KEY,channelId:process.env.YOUTUBE_CHANNEL_ID});
  server.listen(Number(process.env.PORT)||3000,'0.0.0.0',()=>console.log(JSON.stringify({event:'metadata_server_started'})));
}
