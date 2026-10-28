# Página do cliente — prévia e versão funcional

Este diretório integra o repositório privado `lucasprimitz/realponto-previa-cliente`, branch `main`. O simulador interno permanece em outro repositório. Alterações devem ser revisadas antes da publicação, conforme o fluxo autorizado por Lucas.

## Abrir a prévia local

Com Node.js disponível, executar `node customer-preview/server.mjs` a partir da raiz do projeto. A prévia fica em `http://127.0.0.1:8937/` e aceita acesso somente pelo próprio computador. Pode-se informar outra porta como argumento. Esse servidor local não deve ser usado em produção.

## Funcionalidades

- Formulário em quatro etapas: sistema, quantidades, rotina e proposta. A navegação pelas etapas já liberadas preserva o preenchimento e revalida os campos antes do envio.
- Sistemas Secullum Offline, Secullum RH, RHID e iPonto. Os dois Secullum usam o adicional vigente sem detalhá-lo na interface do cliente.
- Investimento exibido somente ao avançar da etapa 3 para a etapa 4. Resumo da configuração aberto por padrão e escopo do serviço visível.
- Inativação dos horários antigos incluída para Secullum RH, RHID e iPonto; item oculto para Secullum Offline.
- Pagamento em cards: Pix com 5% de desconto adicional; boleto em 6 parcelas sob consulta; cartão de crédito em 10 parcelas sem juros. As parcelas são arredondadas somente para apresentação.
- CPF/CNPJ opcional e preferência de pagamento obrigatória, enviados junto aos contatos, escopo, consentimento e estimativa.
- Quantidades acima dos pacotes geram consulta personalizada, sem inventar preço.
- Layout responsivo, navegação por teclado e informações para leitores de tela.

## Preços sincronizados

A página importa `../dist/quote.mjs`. Esse arquivo é uma cópia sincronizada das regras mantidas no repositório do simulador interno. As atualizações de preços partem da origem e geram também `customer-service/pricing.json`, usado pelo PHP. Não editar preços diretamente aqui. A sincronização depende da credencial configurada na origem; não é ativada só por copiar o projeto. Veja [Sincronização de preços](../docs/SINCRONIZACAO-PRECOS.md).

## Prévia estática e envio funcional

A prévia estática pede dados fictícios e não transmite nem guarda contatos. O pacote estático de aprovação e seu atualizador mantêm esse comportamento.

O pacote PHP, gerado por `scripts/package-customer-service.mjs`, ativa a integração da página com a API na mesma origem. O serviço valida os dados, recalcula a estimativa pela data do servidor e registra um protocolo. Os valores recebidos do navegador não são aceitos como autoridade. O painel `contatos/` exige senha validada pelo PHP e permite marcar encaminhamento, escrever uma observação de até 160 caracteres e filtrar os registros.

A cópia por e-mail usa uma fila independente; falhas no e-mail não apagam a solicitação. Destinatário e SMTP podem ser definidos depois na configuração privada da TI. Não há cobrança ou aprovação automática de proposta.

O documento recebe conferência de formato, sem consulta cadastral ou validação de dígitos verificadores. São aceitos CPF, CNPJ numérico e CNPJ alfanumérico. O registro protegido e a cópia por e-mail incluem o documento informado e a preferência de pagamento.

## Entrega para a TI

A hospedagem PHP foi confirmada; o endereço definitivo, versões, acesso técnico e dados de e-mail precisam ser definidos. Para instalar a página funcional no site da empresa, seguir [Solicitações PHP — TI](../docs/SOLICITACOES-PHP-TI.md), com HTTPS e arquivos privados fora da raiz web.

A prévia de aprovação já utiliza `/var/www/realponto-previa` e `http://192.168.90.7:8082/previa-cliente/`. Seu [roteiro manual](../docs/PREVIA-CLIENTE-TI.md) e sua [automação opcional](../docs/ATUALIZACAO-AUTOMATICA-PREVIA.md) permanecem separados da instalação PHP. Após a migração pela TI, o atualizador da prévia consulta `main` deste novo repositório. Ele não instala PHP nem publica o painel.

Gerar uma pasta nova com `node scripts/package-customer-preview.mjs CAMINHO_ABSOLUTO_NOVO IDENTIFICADOR_DA_VERSAO`. Esse pacote é uma fotografia estática da versão selecionada. Para conferir exatamente esse pacote, executar `node scripts/preview-customer-package.mjs CAMINHO_ABSOLUTO_DO_PACOTE 8938` e acessar `http://127.0.0.1:8938/previa-cliente/`.

## Conferência

Executar `npm test` na raiz. O pacote funcional também exige os testes PHP descritos no roteiro da TI. Publicar uma nova versão completa após receber preços sincronizados, para atualizar juntos o cálculo do navegador e o cálculo do servidor.
