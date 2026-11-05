import fs from 'node:fs';
import path from 'node:path';
import {createRequire} from 'node:module';
import {pathToFileURL} from 'node:url';
import {createHash} from 'node:crypto';
const require=createRequire(new URL('../cloudflare-worker/package.json',import.meta.url));
const esbuild=await import(pathToFileURL(require.resolve('esbuild')).href);
const babel=await import(pathToFileURL(require.resolve('@babel/core')).href);
const preset=await import(pathToFileURL(require.resolve('@babel/preset-env')).href);
const built=await esbuild.build({entryPoints:['server-runtime/entry.js'],bundle:true,write:false,format:'iife',platform:'browser',target:'esnext',metafile:true,legalComments:'inline'});
const result=await babel.transformAsync(built.outputFiles[0].text,{babelrc:false,configFile:false,comments:false,compact:true,presets:[[preset.default,{targets:{ie:'11'},modules:false,useBuiltIns:false}]]});
const output=path.resolve('.build/business-runtime');fs.mkdirSync(output,{recursive:true});
const sourceHash=createHash('sha256');for(const input of Object.keys(built.metafile.inputs).sort()){sourceHash.update(input+'\n');sourceHash.update(fs.readFileSync(input));}
const code='/* Fleet bundled business handlers. Bundled code only; no runtime downloads. */\n'+result.code+'\n';
fs.writeFileSync(path.join(output,'runtime.js'),code);
fs.writeFileSync(path.join(output,'manifest.json'),JSON.stringify({schema:1,sourceSha256:sourceHash.digest('hex'),bundleSha256:createHash('sha256').update(code).digest('hex'),rhinoVersion:'1.9.1',bytes:Buffer.byteLength(code)},null,2)+'\n');
console.log('Prepared shared business handlers for the native interpreter ('+Buffer.byteLength(code)+' bytes).');
