(function(root){
 'use strict';
 const utf8=value=>new TextEncoder().encode(value),bytes=value=>Uint8Array.from(atob(value.replace(/-/g,'+').replace(/_/g,'/')),c=>c.charCodeAt(0));
 function base64(value){let raw='';for(let i=0;i<value.length;i+=8192)raw+=String.fromCharCode(...value.subarray(i,i+8192));return btoa(raw).replace(/=/g,'').replace(/\+/g,'-').replace(/\//g,'_');}
 function parse(code){const [secret,publicKey,...rest]=String(code).split('.');if(rest.length||!/^[A-Za-z0-9_-]{43}$/.test(secret)||!/^[A-Za-z0-9_-]{122}$/.test(publicKey))throw Error('Επικόλλησε ολόκληρο τον κωδικό σύζευξης από τον Server.');return {secret,publicKey};}
 async function routingKey(code){const digest=new Uint8Array(await crypto.subtle.digest('SHA-256',utf8(parse(code).secret)));return [...digest].map(b=>b.toString(16).padStart(2,'0')).join('');}
 async function request(code,value){
  if(!root.crypto?.subtle)throw Error('Χρειάζεται ενημερωμένο Android System WebView ή πρόγραμμα περιήγησης για ασφαλή σύνδεση.');
  const identity=parse(code),server=await crypto.subtle.importKey('spki',bytes(identity.publicKey),{name:'ECDH',namedCurve:'P-256'},false,[]),own=await crypto.subtle.generateKey({name:'ECDH',namedCurve:'P-256'},true,['deriveBits']);
  const shared=new Uint8Array(await crypto.subtle.deriveBits({name:'ECDH',public:server},own.privateKey,256)),prefix=utf8('fleet-direct-v1:'+identity.secret+':'),material=new Uint8Array(prefix.length+shared.length);material.set(prefix);material.set(shared,prefix.length);
  const key=await crypto.subtle.importKey('raw',await crypto.subtle.digest('SHA-256',material),'AES-GCM',false,['encrypt','decrypt']);
  const nonce=[...crypto.getRandomValues(new Uint8Array(16))].map(b=>b.toString(16).padStart(2,'0')).join(''),epk=base64(new Uint8Array(await crypto.subtle.exportKey('spki',own.publicKey))),iv=crypto.getRandomValues(new Uint8Array(12));
  const aad=direction=>utf8('fleet-direct-v1:'+direction+':'+nonce+':'+epk);
  const ciphertext=base64(new Uint8Array(await crypto.subtle.encrypt({name:'AES-GCM',iv,additionalData:aad('request'),tagLength:128},key,utf8(JSON.stringify({...value,sentAt:Date.now()})))));
  return {packet:{v:1,nonce,epk,iv:base64(iv),ciphertext},open:async packet=>{
   if(packet?.v!==1||packet.nonce!==nonce||packet.epk!==epk||!/^[A-Za-z0-9_-]{16}$/.test(packet.iv||''))throw Error('Δεν επιβεβαιώθηκε η ασφαλής απόκριση του Server.');
   try{return JSON.parse(new TextDecoder().decode(await crypto.subtle.decrypt({name:'AES-GCM',iv:bytes(packet.iv),additionalData:aad('response'),tagLength:128},key,bytes(packet.ciphertext))));}catch{throw Error('Δεν επιβεβαιώθηκε η ταυτότητα του Server. Επανάλαβε τη σύζευξη από το κινητό Server.');}
  }};
 }
 root.FleetDirectCrypto=Object.freeze({parse,routingKey,request});
}(globalThis));
