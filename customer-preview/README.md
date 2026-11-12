# Página do cliente — prévia e versão funcional

Este diretório integra o repositório privado `lucasprimitz/realponto-previa-cliente`, branch `main`. O simulador interno permanece em outro repositório. Alterações devem ser revisadas antes da publicação, conforme o fluxo autorizado por Lucas.

## Abrir a prévia local

Com Node.js disponível, executar `node customer-preview/server.mjs` a partir da raiz do projeto. A prévia fica em `http://127.0.0.1:8937/` e aceita acesso somente pelo próprio computador. Pode-se informar outra porta como argumento. Esse servidor local não deve ser usado em produção.

## Funcionalidades

- Formulário em quatro etapas: sistema, quantidades, rotina e proposta. A navegação pelas etapas já liberadas preserva o preenchimento e revalida os campos antes do envio.
- Sistemas Secullum Offline, Secullum RH, RHID e iPonto. Os dois Secullum usam o adicional vigente sem detalhá-lo na interface do cliente.
- Investimento exibido somente ao avançar da etapa 3 para a etapa 4. Resumo da configuração aberto por padrão e escopo do serviço visível.
- Inativação dos horários antigos incluída para Secullum RH, RHID e iPonto; item oculto para Secullum Offline.
- Os cards mostram Pix com 5% de desconto adicional, boleto em até 6 parcelas sob consulta e cartão de crédito em até 10 parcelas sem juros. Os valores ilustram o prazo máximo de cada opção e são arredondados somente para apresentação.
- CPF/CNPJ opcional e preferência de pagamento obrigatória, enviados junto aos contatos, escopo, consentimento e estimativa.
- Quantidades acima dos pacotes geram consulta personalizada, sem inventar preço.
- Layout responsivo, navegação por teclado e informações para leitores de tela.

## Preços sincronizados

A página importa a fórmula de `../dist/quote.mjs` e aplica os parâmetros de `customer-service/pricing.json`, única tabela editável. No modo conectado, confirma a tabela na API antes de simular e enviar; a prévia demonstrativa usa o snapshot JSON local do pacote. O sistema interno consulta a tabela publicada pela mesma API, sem credencial entre repositórios. Veja [Tabela de preços compartilhada](../docs/SINCRONIZACAO-PRECOS.md).

## Prévia estática e envio funcional

A prévia estática pede dados fictícios e não transmite nem guarda contatos. O pacote estático de aprovação e seu atualizador mantêm esse comportamento.

Na versão funcional, a página registra a visita, as escolhas, a etapa atual e a exibição da estimativa ou da consulta personalizada na etapa 4. Abas e recargas do mesmo navegador compartilham o rascunho. Dados de contato só entram na solicitação enviada. Após 90 dias de inatividade no navegador, a próxima visita inicia novos identificadores. Se o navegador bloquear esse armazenamento, o formulário continua recebendo propostas.

O painel Atividade do simulador preserva o histórico por mês desde o primeiro registro disponível, no fuso de São Paulo. O filtro abre no mês atual. O quadro de celular e computador conta uma vez cada navegador identificado em uma dessas categorias que acessou o simulador no mês, inclusive quem só visitou a página. Retornos do mesmo navegador no mês contam como um único acesso. O total geral de navegadores também inclui tablets e dispositivos de tipo desconhecido.

A lista mostra visitas e simulações em aberto, com as escolhas registradas, o dispositivo e a região aproximada da última atividade. Depois do envio, a equipe acompanha a proposta na aba Solicitações.

No mesmo filtro de mês, o calendário conta os navegadores distintos com atividade em cada dia. Em Métricas, os dias de maior movimento usam essa mesma contagem. O movimento por horário soma os navegadores ativos em cada faixa de uma hora ao longo dos dias do mês, pelo horário de Brasília. Um navegador que retorna em outro dia entra na contagem daquele dia. Os meses anteriores ao início da medição detalhada, assim como o mês em que ela foi ativada, podem ter cobertura parcial. Para esses períodos, o painel recupera apenas os horários presentes nos registros anteriores.

A aba **Atividade do simulador** abre no calendário. Em **Acessos por dia**, o botão no canto superior direito gira o card para mostrar o gráfico de barras verticais. Cada barra representa os navegadores distintos de um dia. O mesmo botão volta ao calendário. No mês em andamento, o gráfico vai até a data da consulta. Dias sem histórico suficiente aparecem com um traço.

A região aproximada usa a base brasileira por estado empacotada em `customer-service/geo/`. A consulta é local e o painel guarda somente a região encontrada e a categoria do dispositivo. Acessos fora da cobertura, em rede local ou através de um proxy de origem incerta aparecem com região indisponível. Se a hospedagem usa proxy, a TI pode habilitar `activityRemoteAddrVerified` depois de validar que o servidor já restaurou o IP do visitante em `REMOTE_ADDR` apenas a partir de proxies confiáveis.

O pacote PHP, gerado por `scripts/package-customer-service.mjs`, ativa a integração da página com a API na mesma origem. O serviço valida os dados, recalcula a estimativa pela data do servidor e registra um protocolo. Os valores recebidos do navegador não são aceitos como autoridade. O painel `contatos/` exige senha validada pelo PHP e permite marcar encaminhamento, escrever uma observação de até 160 caracteres e filtrar os registros.

A cópia por e-mail usa uma fila independente; falhas no e-mail não apagam a solicitação. Destinatário e SMTP podem ser definidos depois na configuração privada da TI. Não há cobrança ou aprovação automática de proposta.

O documento recebe conferência de formato, sem consulta cadastral ou validação de dígitos verificadores. São aceitos CPF, CNPJ numérico e CNPJ alfanumérico. O registro protegido e a cópia por e-mail incluem o documento informado e a preferência de pagamento.

## Entrega para a TI

A hospedagem PHP foi confirmada; o endereço definitivo, versões, acesso técnico e dados de e-mail precisam ser definidos. Para instalar a página funcional no site da empresa, seguir [Solicitações PHP — TI](../docs/SOLICITACOES-PHP-TI.md), com HTTPS e arquivos privados fora da raiz web.

A prévia de aprovação já utiliza `/var/www/realponto-previa` e `http://192.168.90.7:8082/previa-cliente/`. Seu [roteiro manual](../docs/PREVIA-CLIENTE-TI.md) e sua [automação opcional](../docs/ATUALIZACAO-AUTOMATICA-PREVIA.md) permanecem separados da instalação PHP. Após a migração pela TI, o atualizador da prévia consulta `main` deste novo repositório. Ele não instala PHP nem publica o painel.

Gerar uma pasta nova com `node scripts/package-customer-preview.mjs CAMINHO_ABSOLUTO_NOVO IDENTIFICADOR_DA_VERSAO`. Esse pacote é uma fotografia estática da versão selecionada. Para conferir exatamente esse pacote, executar `node scripts/preview-customer-package.mjs CAMINHO_ABSOLUTO_DO_PACOTE 8938` e acessar `http://127.0.0.1:8938/previa-cliente/`.

## Conferência

Executar `npm test` na raiz. O pacote funcional também exige os testes PHP descritos no roteiro da TI. Publicar uma nova versão completa após receber preços sincronizados, para atualizar juntos o cálculo do navegador e o cálculo do servidor.
