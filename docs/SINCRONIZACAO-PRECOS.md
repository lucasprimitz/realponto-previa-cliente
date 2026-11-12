# Tabela de preços compartilhada

`customer-service/pricing.json`, neste projeto (`realponto-previa-cliente`), é a única tabela editável de preços, adicionais, campanha e faixas de horários/funcionários. O site do cliente e o sistema interno consultam os mesmos dados publicados. A fórmula continua no código e as opções de cada sistema permanecem independentes.

## Como atualizar os preços

1. Editar somente `customer-service/pricing.json`. Valores monetários usam centavos: `90000` representa R$ 900,00. Os campos terminados em `Percent` são percentuais inteiros. Ao mudar a data da campanha, manter `deadlineISO` e `deadlineLabel` correspondentes e o fuso `America/Sao_Paulo`.
2. Executar `node scripts/check-pricing-sync.mjs`, `npm test` e `npm run test:contacts` (Node 24, PHP com SQLite/sodium e dependências Composer). Os testes verificam tabelas inválidas, equivalência dos cálculos JS/PHP, recebimento e empacotamento; não é preciso editar números de referência nos testes após uma mudança comercial.
3. Revisar e enviar a alteração para a `main` deste projeto, seguindo o processo da empresa.
4. Publicar o pacote funcional completo pelo workflow **Atualizar Jornada funcional na HostGator**. Com `JORNADA_AUTO_DEPLOY=true`, o push pode publicar automaticamente conforme as regras do ambiente `jornada-producao`. Caso contrário, usar a execução manual `modo=publicar`.
5. Conferir `https://jornada.realponto.com.br/api/pricing.php` e os preços no site. O sistema interno busca a nova tabela ao abrir/recarregar a página ou usar seu botão de atualização, sem uma nova publicação do sistema interno a cada alteração de preços.

Não editar os números de contingência de `dist/quote.mjs` para atualizar preços. Esse módulo contém a fórmula e uma referência inicial para o sistema interno; a página do cliente aplica o JSON canônico. O script `export-contact-pricing.mjs DESTINO` apenas cria uma cópia validada do JSON e recusa sobrescrever a fonte.

## Leitura pública

`GET /api/pricing.php` devolve `{schemaVersion:1, version, catalog}`. `version` é o SHA256 dos bytes do arquivo canônico instalado. `catalog` inclui somente `pricing`, `campaign`, `schedules` e `employees`. O endpoint aceita GET/HEAD, libera leitura CORS e não abre sessão nem carrega banco, senha ou configuração SMTP. As outras APIs continuam com suas proteções de origem e autenticação.

O PHP usa o mesmo arquivo privado validado para calcular a estimativa. No modo conectado, a tela confirma o catálogo na API antes de liberar o formulário e novamente antes de enviar. Uma mudança de versão durante o preenchimento mostra os novos valores e pede que o cliente confira antes de reenviar. O servidor rejeita uma versão enviada que já não corresponda à instalada. Falha na consulta não apresenta os valores de contingência como preços confirmados nem confirma o recebimento.

Na prévia demonstrativa, os pacotes incluem uma cópia pública sanitizada `public/pricing.json`, importada como JSON pelo navegador. Isso permite demonstração sem API. Essa prévia é um snapshot: precisa ser republicada para refletir mudanças. Os módulos e o JSON recebem a identificação da versão em seus imports para evitar misturar arquivos de versões anteriores no cache.

## Migração e instalação

1. Publicar primeiro a nova versão funcional do cliente, incluindo `src/Pricing.php`, `public/api/pricing.php`, `public/pricing-catalog.mjs` e `public/pricing.json`, junto dos demais arquivos do pacote.
2. Garantir que a configuração web permita `/api/pricing.php`, `/pricing.json` e `/pricing-catalog.mjs`, servindo JSON como `application/json` e módulos como JavaScript. O modelo Nginx foi atualizado. Se existir whitelist em `.htaccess` na HostGator, a TI deve permitir esses arquivos; o deploy preserva o `.htaccess` existente. A prévia e o cliente precisam de CSP `connect-src 'self'` para importar o JSON local.
3. Atualizar também o instalador privado `deploy/bin/deploy-jornada.sh` no servidor pelo procedimento existente da TI. A nova versão verifica API/hash, um único cabeçalho CORS, ausência de sessão, snapshot público e tipos MIME e faz rollback dos arquivos se a verificação falhar.
4. Confirmar uma consulta pública sem cookies, inclusive com `Origin: http://192.168.90.7:8082`. Publicar então a adaptação do sistema interno em `realponto-jornada`.
5. O workflow antigo que copiava preços do interno para este repositório deve estar removido/desativado antes das próximas alterações. `pricing-sync.json` foi retirado; o histórico dos preços é o Git deste projeto e o hash retornado pela API. Nenhum GitHub App, Client ID, chave privada de App ou token entre repositórios é necessário para a leitura compartilhada.

O pacote funcional mantém banco, sessões, configuração privada, chave e fila de e-mail existentes. Alterações na fórmula PHP/JavaScript ou nas condições de pagamento ainda são mudanças de código e precisam dos testes correspondentes; o JSON centraliza os parâmetros presentes nele.
