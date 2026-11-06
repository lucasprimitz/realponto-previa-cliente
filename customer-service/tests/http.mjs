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
async function checkActivity(customer, admin, original, reportYear) {
  const ids = {browserId:randomUUID(), simulationId:randomUUID()};
  const initial = {...ids, revision:1, step:1, estimateViewed:false, configuration:{}, paymentMethod:null};
  const save = (data, options={}) => customer.call('activity.php', {method:'POST', data, ...options});
  const list = async (page=1) => {
    const result = await admin.call('activity.php?page='+page);
    check(result.status,200,'Atividade disponível para o painel autenticado');
    return result.body;
  };
  async function saved(data) {
    const response = await save(data);
    check(response.status >= 200 && response.status < 300,true,'Evento aceito na etapa '+data.step);
  }
  function privateList(body, identifiers) {
    const json = JSON.stringify(body);
    for (const id of identifiers) check(json.includes(id),false,'Identificador de rastreamento não sai no painel');
    assert.doesNotMatch(json,/"(?:browserId|simulationId|contact|name|company|taxId|cpf|cnpj|email|phone|ip|userAgent)"|Teste HTTP|Empresa Exemplo|teste@example\.invalid|11999999999/i);
    checks++;
  }
  check((await customer.call('activity.php')).status,401,'Leitura de atividade exige senha');
  check((await save(initial,{omitCsrf:true})).status,403,'Registro de atividade exige CSRF');
  check((await save(initial,{omitOrigin:true})).status,403,'Registro de atividade exige origem');
  check((await save(initial,{headers:{Origin:'https://evil.example.invalid'}})).status,403,'Atividade rejeita origem externa');
  for (const invalid of [
    {browserId:'nome-do-cliente'}, {simulationId:'00000000-0000-1000-8000-000000000000'},
    {revision:0}, {revision:1.5}, {revision:Number.MAX_SAFE_INTEGER+1}, {step:0}, {step:5},
    {estimateViewed:'sim'}, {contact:request.contact}, {cpf:'12345678900'}, {extra:'campo livre'},
    {configuration:{system:'iponto',name:'Teste HTTP'}}, {configuration:{schedules:999999}},
    {paymentMethod:'método inválido'}, {estimate:{totalCents:1}}, {displayedTotalCents:54321},
  ]) {
    check((await save({...initial,...invalid})).status,422,'Dados inválidos ou pessoais rejeitados na coleta');
  }
  check((await list()).items.length,0,'Eventos rejeitados e pedidos antigos não geram atividade');
  await saved(initial);
  const access = await list();
  check(access.summary.browsers,1,'Abertura registra um navegador');
  check(access.items.length,1,'Abertura visível sem preenchimento');
  check(access.items[0].started,false,'Abertura isolada ainda não iniciou configuração');
  check(access.items[0].estimate,null,'Abertura ainda sem estimativa');
  check(access.items[0].requestId,null,'Abertura ainda sem solicitação');
  check(Number.isFinite(Date.parse(access.items[0].lastActivityAt)),true,'Horário de atividade válido');

  const viewed = {...initial,revision:3,step:4,estimateViewed:true,configuration:request.configuration,paymentMethod:'pix'};
  await saved(viewed);
  const shown = (await list()).items[0];
  check(shown.started,true,'Configuração preenchida indica simulação iniciada');
  check(shown.configuration,request.configuration,'Painel recebe as opções configuradas');
  check(shown.paymentMethod,'pix','Painel recebe a forma de pagamento escolhida');
  const estimate = shown.estimate;
  check(estimate.status,'priced','Servidor precifica configuração que foi visualizada');
  check(estimate.totalCents,original.request.estimate.totalCents,'Estimativa corresponde ao preço calculado pelo servidor');
  const back = {...initial,revision:4,step:2,configuration:{system:'iponto',employees:null}};
  await saved(back);
  // Retransmissões podem receber confirmação ou conflito. Nenhuma pode retroceder o estado.
  for (const revision of [3,4]) {
    const retry = await save({...viewed,revision,configuration:{...request.configuration,schedules:'consultar'}});
    check([200,201,202,204,409].includes(retry.status),true,'Retransmissão de revisão já processada');
  }
  const revisited = (await list()).items[0];
  check(revisited.step,2,'Revisões antigas e repetidas não alteram etapa atual');
  check(revisited.maxStep,4,'Retorno preserva etapa máxima');
  check(revisited.estimateViewed,true,'Retorno preserva visualização anterior');
  check(revisited.estimate,estimate,'Retorno e retransmissão preservam o preço realmente visualizado');
  check(revisited.configuration.employees ?? null,null,'Seleção desfeita substitui valor anterior');

  const second = {...initial,simulationId:randomUUID(),revision:1,step:2,configuration:{system:'iponto',bankHours:null}};
  await saved(second);
  const drafts = await list();
  check(drafts.items.length,2,'Duas simulações distintas no mesmo navegador');
  check(drafts.summary.browsers,1,'Navegador contado uma única vez');
  check(drafts.summary.started,2,'Duas simulações iniciadas');
  check(drafts.summary.viewed,1,'Somente uma estimativa visualizada');
  check(drafts.summary.submitted,0,'Rascunhos não contam como solicitação');
  check((await list(2)).items.length,0,'Segunda página sem atividades adicionais');
  privateList(drafts,[ids.browserId,ids.simulationId,second.simulationId]);
  const changedCatalog = {...viewed, simulationId:second.simulationId, revision:2, displayedTotalCents:estimate.totalCents + 100};
  await saved(changedCatalog);
  const captured = (await list()).items.find(row => row.estimate?.matchesCatalog === false);
  check(captured?.estimate.totalCents, changedCatalog.displayedTotalCents, 'Atividade preserva a quantia exibida antes de uma alteração de tabela');
  check((await save({...changedCatalog,displayedTotalCents:'valor livre'})).status,422,'Valor histórico só aceita centavos inteiros');
  await saved({...viewed,simulationId:second.simulationId,revision:3,displayedTotalCents:null,configuration:{...request.configuration,employees:'consultar'}});
  const consultation = (await list()).items.find(row=>row.configuration.employees==='consultar');
  check(consultation?.estimate?.status,'consultation','Pacote sob consulta sinalizado no painel');
  check(consultation.estimate.totalCents,null,'Pacote sob consulta não recebe valor inventado');
  const report = (await admin.call('reports.php?year='+reportYear)).body;
  check(report.total.count,1,'Rascunhos não afetam quantidade no relatório');
  check(report.total.totalCents,original.request.estimate.pixCents,'Rascunhos não afetam valor no relatório');

  const key = randomUUID();
  const submit = (activity, idempotencyKey) => customer.call('requests.php',{
    method:'POST',data:{...request,activity},headers:{'Idempotency-Key':idempotencyKey},
  });
  const created = await submit(ids,key);
  check(created.status,201,'Solicitação vinculada ao rascunho existente');
  const repeated = await submit(ids,key);
  check(repeated.status,200,'Repetição do envio vinculado é idempotente');
  check(repeated.body.id,created.body.id,'Envio repetido mantém o protocolo');
  const retried = await submit(ids,randomUUID());
  check(retried.status,200,'Mesmo rascunho com nova chave de envio é idempotente');
  check(retried.body.id,created.body.id,'Nova tentativa mantém o protocolo do rascunho');
  const linked = await list();
  check(linked.items.length,2,'Envio não duplica o rascunho');
  check(linked.summary.submitted,1,'Repetição não duplica a contagem de envios');
  check(linked.items.filter(row=>row.requestId===created.body.id).length,1,'Somente o rascunho enviado recebe o protocolo');

  const late = {browserId:randomUUID(),simulationId:randomUUID()};
  const firstSubmission = await submit(late,randomUUID());
  check(firstSubmission.status,201,'Solicitação pode chegar antes do primeiro evento');
  const awaitingEvent = (await list()).items.find(row=>row.requestId===firstSubmission.body.id);
  check(awaitingEvent?.estimateViewed,false,'Somente o evento de visualização confirma que houve consulta ao orçamento');
  await saved({...viewed,...late});
  await saved({...back,...late});
  const finalList = await list();
  check(finalList.items.length,3,'Evento tardio reaproveita a atividade do envio');
  check(finalList.summary.browsers,2,'Segundo navegador contado uma vez');
  check(finalList.summary.submitted,2,'Dois envios contabilizados');
  check(finalList.items.filter(row=>row.requestId===firstSubmission.body.id).length,1,'Evento tardio conserva vínculo ao protocolo correto');
  const lateRow = finalList.items.find(row=>row.requestId===firstSubmission.body.id);
  check(lateRow.estimateViewed,true,'Orçamento exibido antes do envio pode chegar ao servidor depois');
  check(lateRow.estimate,estimate,'Evento tardio recupera o orçamento exibido');
  check(lateRow.step,4,'Evento atrasado não altera a etapa final do envio');
  check(lateRow.configuration,request.configuration,'Evento atrasado não altera a configuração efetivamente enviada');
  check((await admin.call('reports.php?year='+reportYear)).body.total.count,3,'Relatório contém um protocolo por envio concluído');
  privateList(finalList,[ids.browserId,ids.simulationId,second.simulationId,late.browserId,late.simulationId]);
  return initial;
}

const returningVisitor = {browserId:randomUUID(), simulationId:randomUUID()};

async function seedLegacyActivity() {
  // Start the isolated HTTP suite with the schema used before monthly activity was recorded.
  await fs.mkdir(configuration.dataDirectory, {mode:0o700});
  const script = `
    $config = require $argv[1];
    $db = new PDO('sqlite:' . $config['dataDirectory'] . '/contacts.sqlite');
    $db->exec('PRAGMA foreign_keys=OFF'); // The request table is created by Store when HTTP starts.
    $db->exec("CREATE TABLE simulation_activity (
        draft_key TEXT PRIMARY KEY, browser_key TEXT NOT NULL, first_seen TEXT NOT NULL, last_seen TEXT NOT NULL,
        revision INTEGER NOT NULL DEFAULT 0, step INTEGER NOT NULL DEFAULT 1, max_step INTEGER NOT NULL DEFAULT 1,
        started INTEGER NOT NULL DEFAULT 0, choices TEXT NOT NULL DEFAULT '{}', payment TEXT, quote TEXT,
        quote_revision INTEGER NOT NULL DEFAULT 0, request_id TEXT UNIQUE REFERENCES requests(id)
    )");
    $key = base64_decode($config['encryptionKey']);
    $browser = hash_hmac('sha256', 'activity-browser:' . $argv[2], $key);
    $draft = hash_hmac('sha256', 'activity-draft:' . $argv[2] . ':' . $argv[3], $key);
    $insert = $db->prepare('INSERT INTO simulation_activity
        (draft_key, browser_key, first_seen, last_seen, revision, step, max_step, started, choices)
        VALUES (?, ?, ?, ?, 1, ?, ?, ?, ?)');
    $db->beginTransaction();
    for ($i = 0; $i < 25; $i++) {
        $instant = sprintf('2020-08-10T12:%02d:00Z', $i);
        $insert->execute(['draft-fixture-' . $i, $browser, $instant, $instant, 1, 1, 0, '{}']);
    }
    $before = '2020-09-01T02:59:59Z';
    $after = '2020-09-01T03:00:00Z';
    $insert->execute([$draft, $browser, $before, $before, 2, 2, 1, json_encode(['system' => 'rhid'])]);
    $insert->execute(['draft-fixture-sept', $browser, $after, $after, 1, 1, 0, '{}']);
    $db->commit();
  `;
  const seeded = spawnSync(php, ['-r', script, configPath, returningVisitor.browserId, returningVisitor.simulationId],
    {encoding:'utf8', windowsHide:true});
  assert.equal(seeded.status, 0, seeded.stderr);
}

async function checkMonthlyActivity(customer, admin) {
  const listing = async (month, page=1) => {
    const {status, body} = await admin.call('activity.php?' + new URLSearchParams({month, page}));
    check(status,200,'Consulta mensal autenticada');
    check(body.month,month,'Resposta identifica o mês solicitado');
    return body;
  };
  const initial = (await admin.call('activity.php')).body;
  const parts = new Intl.DateTimeFormat('en-US',{year:'numeric',month:'2-digit',timeZone:'America/Sao_Paulo'}).formatToParts(new Date());
  const current = parts.find(part=>part.type === 'year').value + '-' + parts.find(part=>part.type === 'month').value;
  check(initial.month,current,'Consulta sem filtro usa o mês corrente em São Paulo');
  check(initial.currentMonth,current,'Painel recebe o limite superior do seletor');
  check(initial.firstMonth,'2020-08','O primeiro mês vem do histórico migrado');
  check((await listing(current)).total,initial.total,'Mês explícito e padrão equivalentes');
  for (const query of ['month=2020-00','month=2020-13','month=2020-8','month=2020-08-01','month[]=2020-08']) {
    check((await admin.call('activity.php?'+query)).status,422,'Formato de mês inválido rejeitado');
  }
  check((await customer.call('activity.php?month=2020-08')).status,401,'Histórico mensal restrito à equipe');
  const august = await listing('2020-08');
  check(august.total,26,'O mês inclui somente seus próprios registros, mesmo após 90 dias');
  check(august.totalPages,2,'Paginação considera somente o mês selecionado');
  check(august.items.length,25,'Primeira página histórica limitada a 25 simulações');
  check(august.summary,{browsers:1,started:1,viewed:0,submitted:0},'Indicadores mensais deduplicam o navegador');
  check(august.items[0].lastActivityAt,'2020-09-01T02:59:59Z','23h59m59 em São Paulo pertence a agosto');
  const pageTwo = await listing('2020-08',2);
  check(pageTwo.items.length,1,'Último registro disponível na segunda página');
  check(pageTwo.summary,august.summary,'Totais mensais independentes da página');
  check(new Set([...august.items,...pageTwo.items].map(item=>item.lastActivityAt)).size,26,'Paginação sem sobreposição');
  const september = await listing('2020-09');
  check(september.total,1,'Mês seguinte começa exatamente à meia-noite em São Paulo');
  check(september.items[0].lastActivityAt,'2020-09-01T03:00:00Z','UTC convertido para o mês local correto');
  const empty = await listing('2020-10');
  check(empty.items,[],'Mês intermediário sem registros pode ser consultado');
  check(empty.summary,{browsers:0,started:0,viewed:0,submitted:0},'Mês vazio apresenta totais zerados');

  const continued = {...returningVisitor, revision:2, step:4, estimateViewed:true,
    configuration:request.configuration, paymentMethod:'pix'};
  for (let retry = 0; retry < 2; retry++) {
    const saved = await customer.call('activity.php',{method:'POST',data:continued});
    check(saved.status,200,'Atividade de um rascunho retomado aceita');
  }
  const resumed = await listing(current);
  check(resumed.total,initial.total+1,'O rascunho retomado conta uma só vez no novo mês');
  check(resumed.summary.browsers,initial.summary.browsers+1,'Navegador retomado conta apenas uma vez no mês');
  check(resumed.summary.viewed,initial.summary.viewed+1,'Orçamento visto no mês da retomada');
  const sent = await customer.call('requests.php',{method:'POST',data:{...request,activity:returningVisitor},headers:{'Idempotency-Key':randomUUID()}});
  check(sent.status,201,'Rascunho iniciado em outro mês pode virar solicitação');
  const submitted = await listing(current);
  check(submitted.total,resumed.total,'Envio mantém o rascunho do mês da retomada');
  check(submitted.summary.submitted,initial.summary.submitted+1,'Protocolo contabilizado no mês do envio');
  check(submitted.items.filter(item=>item.requestId===sent.body.id).length,1,'Protocolo consta uma vez no mês correspondente');
  const unchanged = await listing('2020-08');
  check(unchanged.items,august.items,'Retomadas e envios posteriores preservam escolhas e etapa do mês original');
  check(unchanged.summary,august.summary,'Retomada não altera as contagens dos meses anteriores');
}

const request={schemaVersion:1,createdAt:'1900-01-01',contact:{name:'Teste HTTP',company:'Empresa Exemplo',email:'teste@example.invalid',phone:'11999999999',taxId:null},configuration:{system:'iponto',schedules:10,employees:40,bankHours:true,workScale:false},payment:{method:'pix',label:'fake'},estimate:{totalCents:1},consent:true};
try {
  await seedLegacyActivity();
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
  const sampleActivity = await checkActivity(customer,admin,item,reportYear);
  await checkMonthlyActivity(customer,admin);
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
  check((await customer.call('activity.php',{method:'POST',data:sampleActivity})).status,503,'Coleta desativada com o recebimento');
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
