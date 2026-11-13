/* Static recovery shell only. API, mode discovery and downloads always require network. */
const CACHE='fleet-direct-shell-__FLEET_VERSION__';
const SHELL=__FLEET_SHELL__;
self.addEventListener('install',event=>event.waitUntil((async()=>{
  const cache=await caches.open(CACHE);await cache.addAll(SHELL);await self.skipWaiting();
})()));
self.addEventListener('activate',event=>event.waitUntil((async()=>{
  for(const name of await caches.keys())if(name.startsWith('fleet-direct-shell-')&&name!==CACHE)await caches.delete(name);
  await self.clients.claim();
})()));
self.addEventListener('fetch',event=>{
  const request=event.request,url=new URL(request.url);
  if(request.method!=='GET'||url.origin!==self.location.origin||url.pathname.startsWith('/api/')||url.pathname.startsWith('/download/')||url.pathname==='/fleet-mode.json')return;
  event.respondWith((async()=>{
    const cache=await caches.open(CACHE),key=url.pathname;
    try{
      const response=await fetch(request);if(response.ok&&response.type!=='opaque'){await cache.put(key,response.clone());return response;}
      const saved=await cache.match(key);if(saved)return saved;return response;
    }catch(error){
      const saved=await cache.match(key);if(saved)return saved;
      if(request.mode==='navigate'){const shell=await cache.match(url.pathname==='/fleet.html'?'/fleet.html':'/portal.html');if(shell)return shell;}
      throw error;
    }
  })());
});
