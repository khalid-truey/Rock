import {generateKeyPairSync,createHash} from 'node:crypto';
import {access,readFile,writeFile} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import {existsSync} from 'node:fs';
const dir=path.dirname(fileURLToPath(import.meta.url));
if(process.platform!=='win32')throw new Error('Rock Chrome native messaging setup requires Windows.');
const packaged=path.resolve(dir,'../../bin/rock-chrome-host.exe');
const executable=existsSync(packaged)?packaged:path.resolve(dir,'../../target/debug/rock-chrome-host.exe');
await access(executable); // Build first; never register a missing native host.
const manifestFile=path.join(dir,'chrome-extension/manifest.json');
const manifest=JSON.parse(await readFile(manifestFile,'utf8'));
if(!manifest.key) {
  const {publicKey}=generateKeyPairSync('rsa',{modulusLength:2048});
  manifest.key=publicKey.export({type:'spki',format:'der'}).toString('base64');
  await writeFile(manifestFile,JSON.stringify(manifest,null,2)+'\n');
}
const hash=createHash('sha256').update(Buffer.from(manifest.key,'base64')).digest('hex').slice(0,32);
const id=[...hash].map(c=>String.fromCharCode(97+parseInt(c,16))).join('');
const host={name:'com.rock.browser',description:'Rock browser control for your existing Chrome profile',
  path:executable,type:'stdio',allowed_origins:[`chrome-extension://${id}/`]};
await writeFile(path.join(dir,'chrome-native-host.json'),JSON.stringify(host,null,2)+'\n');
await writeFile(executable.replace(/\.exe$/i,'.json'),JSON.stringify({node:process.execPath,script:path.join(dir,'native-host.mjs')},null,2)+'\n');
const registered=process.argv.includes('--register');
if(registered)execFileSync('reg.exe',['add','HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts\\com.rock.browser','/ve','/t','REG_SZ','/d',path.join(dir,'chrome-native-host.json'),'/f'],{stdio:'pipe',windowsHide:true});
console.log(JSON.stringify({extension_id:id,extension_directory:path.join(dir,'chrome-extension'),native_manifest:path.join(dir,'chrome-native-host.json'),registered}));
