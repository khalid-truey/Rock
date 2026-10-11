import {readFile,writeFile,mkdir,access} from 'node:fs/promises';
import {randomBytes} from 'node:crypto';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {validatePairing,hashToken} from './shared-laya.mjs';

const repo=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..');
const data=path.resolve(process.env.ROCK_DATA_DIR || path.join(repo,'.rock-data'));
const mode=process.argv[2];
await mkdir(data,{recursive:true});
const save=(file,value)=>writeFile(path.join(data,file),JSON.stringify(value,null,2)+'\n',{mode:0o600});
if(mode==='Host') {
  const layaData=path.resolve(process.argv[3] || data);
  const certificatePem=await readFile(path.join(data,'host-certificate.pem'),'utf8');
  const hostFile=path.join(data,'host.json');
  try {await access(hostFile);} catch(error) {
    if(error.code!=='ENOENT')throw error;
    const token=randomBytes(32).toString('hex');
    await save('host-devices.json',[{name:'host-pc',tokenHash:hashToken(token)}]);
    await writeFile(path.join(data,'host-control-token'),randomBytes(32).toString('hex'),{mode:0o600});
    await save('host.json',{
      port:43129,sidecarPort:43127,device:'auto',
      python:path.join(layaData,'laya/runtime/Scripts/python.exe'),model:path.join(layaData,'laya/models/typed-decisions'),
      certificatePem:path.join(data,'host-certificate.pem'),pfx:path.join(data,'host-certificate.pfx'),passwordFile:path.join(data,'host-certificate-password'),
    });
    await save('laya-client.json',{url:'https://127.0.0.1:43129',token,certificatePem});
  }
  console.log('Host configured. Laya remains stopped until you open Start Laya.');
} else if(mode==='Client') {
  if(!process.argv[3])throw new Error('Client setup requires a pairing file from the host PC');
  const pairing=validatePairing(JSON.parse(await readFile(path.resolve(process.argv[3]),'utf8')));
  await save('laya-client.json',pairing);
  console.log('Paired with Laya host. No Python or model installation is needed.');
} else throw new Error('Mode must be Host or Client');

const configFile=path.join(repo,'pok-ai.toml');
let config;
try {
  config=await readFile(configFile,'utf8');
  // Keep the original once, then migrate only Rock-owned settings.
  await writeFile(path.join(data,'pok-ai.before-shared-laya.toml'),config,{flag:'wx'}).catch(error=>{if(error.code!=='EEXIST')throw error;});
}catch(error){if(error.code!=='ENOENT')throw error;config=await readFile(path.join(repo,'rock.example.toml'),'utf8');}
config=config.replaceAll('@DATA_DIR@',JSON.stringify(data.replaceAll('\\','/')).slice(1,-1));
function setSectionField(section,key,value) {
  const escaped=section.replaceAll('.','\\.');
  const re=new RegExp(`(\\[${escaped}\\]\\s*\\n)([\\s\\S]*?)(?=\\n\\[|$)`);
  if(!re.test(config))throw new Error(`Missing [${section}] in pok-ai.toml`);
  config=config.replace(re,(_all,header,body)=>{
    const field=new RegExp(`^${key}\\s*=.*$`,'m');
    return header+(field.test(body)?body.replace(field,`${key} = ${value}`):`${key} = ${value}\n${body}`);
  });
}
setSectionField('decision_router.laya','endpoint','"http://127.0.0.1:43126/v1/systemone"');
setSectionField('decision_router','timeout_ms','30000');
await writeFile(configFile,config);
const integration=path.join(repo,'integrations/codex');
const launcher=path.join(integration,'runtime.mjs');
await writeFile(path.join(integration,'mcp.local.json'),JSON.stringify({mcpServers:{rock:{command:process.execPath,args:[launcher,'mcp']}}},null,2)+'\n');
await writeFile(path.join(integration,'codex.local.toml'),`[mcp_servers.rock]\ncommand = ${JSON.stringify(process.execPath)}\nargs = [${JSON.stringify(launcher)}, "mcp"]\nstartup_timeout_sec = 30\ntool_timeout_sec = 240\n`);
