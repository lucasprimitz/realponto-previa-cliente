import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import {randomBytes, randomUUID} from 'node:crypto';
import {spawn, spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

const service = fileURLToPath(new URL('../', import.meta.url));
const php = process.env.PHP_BINARY || process.argv[2] || 'php';
const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'realponto-contacts-http-'));
const password = `test-only-${randomBytes(24).toString('hex')}`;
const hash = spawnSync(php, ['-r', 'echo password_hash(trim(stream_get_contents(STDIN)), PASSWORD_DEFAULT);'], {input: password, encoding: 'utf8', windowsHide: true});
assert.equal(hash.status, 0, hash.stderr);
const reserve = net.createServer(); await new Promise(resolve => reserve.listen(0, '127.0.0.1', resolve));
const port = reserve.address().port; await new Promise(resolve => reserve.close(resolve));
const origin = `http://127.0.0.1:${port}`;
const configuration = {origin, cookiePath:'/', dataDirectory:path.join(temporary, 'private'), encryptionKey:randomBytes(32).toString('base64'), passwordHash:hash.stdout, submissionsEnabled:true, developmentLoopback:true, mail:{enabled:false}};
const configPath = path.join(temporary, 'config.php');
async function writeConfig(value = configuration) { await fs.writeFile(configPath, `<?php return json_decode(base64_decode('${Buffer.from(JSON.stringify(value)).toString('base64')}'),true,32,JSON_THROW_ON_ERROR);`, {mode:0o600}); }
await writeConfig();
const testEnvironment = {...process.env, CONTACTS_CONFIG_FILE:configPath}; delete testEnvironment.CONTACTS_SUBMISSIONS_ENABLED;
const server = spawn(php, ['-d', 'opcache.enable=0', '-d', 'opcache.enable_cli=0', '-S', `127.0.0.1:${port}`, '-t', path.join(service, 'public')], {env:testEnvironment, stdio:['ignore','pipe','pipe'], windowsHide:true});
let logs=''; server.on('error', error=>{logs += error.message;}); server.stderr.on('data', data=>{logs=(logs+data.toString()).slice(-4000);}); server.stdout.on('data', ()=>{});
let checks=0;
function check(actual, expected, label) { assert.deepEqual(actual, expected, label); checks++; }
class Client {
  cookie=''; csrf='';
  async call(endpoint, {method='GET', data, headers={}, raw, omitOrigin=false, omitCsrf=false}={}) {
    const requestHeaders={Cookie:this.cookie,...(method==='POST'?{'Content-Type':'application/json',...(!omitOrigin?{Origin:origin}:{}),...(!omitCsrf?{'X-CSRF-Token':this.csrf}:{})}:{}),...headers};
    const response=await fetch(`${origin}/api/${endpoint}`,{method,headers:requestHeaders,body:method==='POST'?(raw??JSON.stringify(data??{})):undefined,redirect:'manual'});
    for (const cookie of response.headers.getSetCookie()) if(cookie.startsWith('RP_CONTACTS_SESSION=')) this.cookie=cookie.split(';')[0];
    const body=await response.json(); if(body.csrfToken) this.csrf=body.csrfToken;
    return {status:response.status,body,headers:response.headers};
  }
}
const request={schemaVersion:1,createdAt:'1900-01-01',contact:{name:'Teste HTTP',company:'Empresa Exemplo',email:'teste@example.invalid',phone:'11999999999',taxId:null},configuration:{system:'iponto',schedules:10,employees:40,bankHours:true,workScale:false},payment:{method:'pix',label:'fake'},estimate:{totalCents:1},consent:true};
try {
  let ready=false; const readinessDeadline=Date.now()+60000; while(Date.now()<readinessDeadline && server.exitCode===null){try{await fetch(`${origin}/api/session.php`,{signal:AbortSignal.timeout(1000)});ready=true;break;}catch{await new Promise(resolve=>setTimeout(resolve,50));}}
  assert.ok(ready,`PHP startup timed out or exited (${server.exitCode}): ${logs}`);
  const customer=new Client(), admin=new Client(), stranger=new Client();
  let result=await customer.call('session.php'); check(result.status,200,'Sessão pública'); check(result.body.authenticated,false,'Sessão começa sem login');
  assert.match(result.headers.get('set-cookie'),/HttpOnly/i); assert.match(result.headers.get('set-cookie'),/SameSite=Strict/i); checks+=2;
  check((await stranger.call('requests.php')).status,401,'Lista sem senha bloqueada');
  check((await stranger.call('reports.php?year=2026')).status,401,'Relatório sem senha bloqueado');
  check((await stranger.call('request-update.php',{method:'POST',data:{}})).status,401,'Escrita sem senha bloqueada');
  check((await customer.call('requests.php',{method:'POST',data:request,omitCsrf:true})).status,403,'CSRF ausente');
  check((await customer.call('requests.php',{method:'POST',data:request,omitOrigin:true})).status,403,'Origem ausente');
  check((await customer.call('requests.php',{method:'POST',data:request,headers:{Origin:'https://evil.example.invalid'}})).status,403,'Origem externa bloqueada');
  check((await customer.call('requests.php',{method:'POST',data:request,headers:{'Content-Type':'text/plain'}})).status,415,'Tipo de conteúdo rejeitado');
  check((await customer.call('requests.php',{method:'POST',raw:JSON.stringify({payload:'a'.repeat(17000)})})).status,413,'Corpo limitado');
  const key=randomUUID(); const created=await customer.call('requests.php',{method:'POST',data:request,headers:{'Idempotency-Key':key}});
  check(created.status,201,'Recebimento persistido'); check(created.body.mailStatus,'disabled','SMTP não configurado não perde contato');
  assert.equal('request' in created.body,false); assert.equal('contact' in created.body,false); checks+=2;
  result=await customer.call('requests.php',{method:'POST',data:{...request,createdAt:'2030-01-01'},headers:{'Idempotency-Key':key}});
  check(result.status,200,'Repetição não duplica'); check(result.body.id,created.body.id,'Mesmo protocolo');
  check((await customer.call('requests.php',{method:'POST',data:{...request,contact:{...request.contact,name:'Outro Nome'}},headers:{'Idempotency-Key':key}})).status,409,'Chave não aceita dados diferentes');
  check((await customer.call('requests.php',{method:'POST',data:{...request,configuration:{...request.configuration,system:'forged'}},headers:{'Idempotency-Key':randomUUID()}})).status,422,'Sistema inválido rejeitado no servidor');
  await admin.call('session.php'); const oldCookie=admin.cookie,oldCsrf=admin.csrf;
  result=await admin.call('login.php',{method:'POST',data:{password}}); check(result.status,200,'Login válido'); check(result.body.authenticated,true,'Autenticação confirmada');
  assert.notEqual(admin.cookie,oldCookie); assert.notEqual(admin.csrf,oldCsrf); checks+=2;
  result=await admin.call('requests.php'); check(result.body.total,1,'Somente um registro');
  const item=result.body.items[0]; check(item.request.contact.name,'Teste HTTP','Contato preservado'); assert.notEqual(item.request.estimate.totalCents,1); checks++;
  check(result.headers.get('cache-control'),'no-store, private','Sem cache de dados pessoais');
  const reportYear = new Intl.DateTimeFormat('en-US',{timeZone:'America/Sao_Paulo',year:'numeric'}).format(new Date(item.receivedAt));
  const reportResponse = await admin.call('reports.php?year='+reportYear);
  check(reportResponse.status,200,'Relatório autenticado');
  check(reportResponse.body.total.count,1,'Relatório inclui solicitação recebida');
  check(reportResponse.body.total.totalCents,item.request.estimate.pixCents,'Relatório usa valor histórico do pagamento escolhido');
  check(reportResponse.body.months.length,12,'Relatório inclui doze meses');
  check(reportResponse.headers.get('cache-control'),'no-store, private','Relatório não deve ser armazenado em cache');
  assert.doesNotMatch(JSON.stringify(reportResponse.body),/Teste HTTP|Empresa Exemplo|teste@example.invalid|11999999999|RP-/); checks++;
  for(const invalidYear of ['abc','1999','2101','2026.5','2026&year[]=2027']) check((await admin.call('reports.php?year='+invalidYear)).status,422,'Ano inválido rejeitado');
  check((await admin.call('reports.php',{method:'POST',data:{year:Number(reportYear)}})).status,405,'Relatório somente leitura');
  check((await admin.call('request-update.php',{method:'POST',data:{id:item.id,handled:true,note:'Ana',version:1},headers:{'X-CSRF-Token':oldCsrf}})).status,403,'Token anterior revogado');
  result=await admin.call('request-update.php',{method:'POST',data:{id:item.id,handled:true,note:'Ana',version:1}}); check(result.status,200,'Acompanhamento salvo'); check(result.body.item.version,2,'Versão avança');
  check((await admin.call('request-update.php',{method:'POST',data:{id:item.id,handled:false,note:'',version:1}})).status,409,'Alteração concorrente não sobrescreve');
  check((await admin.call('requests.php?status=pending')).body.total,0,'Filtro pendentes'); check((await admin.call('requests.php?status=handled')).body.total,1,'Filtro encaminhados');

  const archivePayload = {id:item.id,version:2,archived:true};
  check((await stranger.call('request-archive.php',{method:'POST',data:archivePayload})).status,401,'Inativação exige senha');
  check((await admin.call('request-archive.php')).status,405,'Inativação não aceita GET');
  check((await admin.call('request-archive.php',{method:'POST',data:archivePayload,omitCsrf:true})).status,403,'Inativação exige CSRF');
  check((await admin.call('request-archive.php',{method:'POST',data:archivePayload,omitOrigin:true})).status,403,'Inativação exige origem');
  check((await admin.call('request-archive.php',{method:'POST',data:archivePayload,headers:{Origin:'https://evil.example.invalid'}})).status,403,'Origem externa não pode inativar');
  check((await admin.call('request-archive.php',{method:'POST',data:{...archivePayload,archived:'true'}})).status,422,'Estado inativo precisa ser booleano');
  check((await admin.call('request-archive.php',{method:'POST',data:{...archivePayload,version:'2'}})).status,422,'Versão deve ser inteira');
  check((await admin.call('request-archive.php',{method:'POST',data:{...archivePayload,version:1}})).status,409,'Inativação concorrente não sobrescreve');
  result=await admin.call('request-archive.php',{method:'POST',data:archivePayload});
  check(result.status,200,'Inativação persistida'); check(result.body.item.archived,true,'Estado inativo retornado'); check(result.body.item.version,3,'Inativação avança versão');
  check(result.body.item.request,item.request,'Contato, configuração e valores preservados'); check(result.body.item.note,'Ana','Observação preservada'); check(result.body.item.mailStatus,'disabled','Inativação não altera entrega de e-mail');
  check(result.headers.get('cache-control'),'no-store, private','Inativação não deve armazenar dados em cache');
  check((await admin.call('requests.php?status=all')).body.total,0,'Inativa sai da lista ativa');
  check((await admin.call('requests.php?status=handled')).body.total,0,'Inativa sai dos encaminhados ativos');
  result=await admin.call('requests.php?status=archived'); check(result.body.total,1,'Inativos acessíveis pelo filtro'); check(result.body.items[0].id,item.id,'Filtro retorna mesmo protocolo');
  result=await admin.call('reports.php?year='+reportYear); check(result.body.total.count,0,'Inativa sai da contagem anual'); check(result.body.total.totalCents,0,'Inativa sai do valor anual');
  check((await admin.call('request-update.php',{method:'POST',data:{id:item.id,handled:false,note:'',version:3}})).status,409,'Inativo não pode ser editado antes de restaurar');
  check((await admin.call('request-archive.php',{method:'POST',data:{id:item.id,archived:false,version:2}})).status,409,'Restauração exige versão atual');
  result=await admin.call('request-archive.php',{method:'POST',data:{id:item.id,archived:false,version:3}});
  check(result.status,200,'Restauração persistida'); check(result.body.item.archived,false,'Restauração reativa solicitação'); check(result.body.item.archivedAt,null,'Data de inativação limpa ao restaurar'); check(result.body.item.version,4,'Restauração avança versão');
  check((await admin.call('requests.php?status=archived')).body.total,0,'Restauração sai dos inativos'); check((await admin.call('requests.php?status=handled')).body.total,1,'Restauração mantém encaminhamento anterior');
  result=await admin.call('reports.php?year='+reportYear); check(result.body.total.count,1,'Restauração recompõe contagem'); check(result.body.total.totalCents,item.request.estimate.pixCents,'Restauração recompõe valor histórico');
  check((await admin.call('logout.php',{method:'POST',data:{}})).body.authenticated,false,'Logout aceita objeto vazio');
  check((await admin.call('requests.php')).status,401,'Logout revoga leitura');
  check((await admin.call('reports.php')).status,401,'Logout revoga relatório');
  await admin.call('login.php',{method:'POST',data:{password}});
  const sessionId=admin.cookie.split('=')[1]; const sessionPath=path.join(configuration.dataDirectory,'sessions',`sess_${sessionId}`);
  await fs.writeFile(sessionPath,(await fs.readFile(sessionPath,'utf8')).replace(/lastActivity\|i:\d+;/,'lastActivity|i:0;'));
  check((await admin.call('session.php')).body.authenticated,false,'Sessão expira por inatividade'); check((await admin.call('requests.php')).status,401,'Sessão expirada bloqueia dados');
  for(let i=0;i<3;i++) await admin.call('login.php',{method:'POST',data:{password:'wrong'}});
  check((await admin.call('login.php',{method:'POST',data:{password:'wrong'}})).status,429,'Tentativas de senha limitadas');
  await writeConfig({...configuration,submissionsEnabled:false}); check((await customer.call('requests.php',{method:'POST',data:request,headers:{'Idempotency-Key':randomUUID()}})).status,503,'Recebimento desativável');
  await writeConfig({...configuration,origin:`https://127.0.0.1:${port}`,developmentLoopback:false});
  check((await customer.call('session.php',{headers:{'X-Forwarded-Proto':'https'}})).status,403,'HTTPS não pode ser falsificado por cabeçalho');
  await writeConfig();
  for(const target of ['/config.example.php','/config.php','/src/Config.php','/contacts.sqlite','/pricing.json']) check((await fetch(origin+target)).status,404,'Arquivo privado fora da publicação');
  console.log(`OK: ${checks} verificações HTTP reais; armazenamento, login, CSRF, origem, expiração, logout e limites. Nenhum e-mail real enviado.`);
} finally {
  server.kill(); await new Promise(resolve=>{if(server.exitCode!==null)resolve();else server.once('exit',resolve);});
  const resolved=path.resolve(temporary),prefix=path.resolve(os.tmpdir())+path.sep;
  if(!resolved.startsWith(prefix)||!path.basename(resolved).startsWith('realponto-contacts-http-')) throw Error('Diretório de teste inesperado.');
  await fs.rm(resolved,{recursive:true,force:true});
}
