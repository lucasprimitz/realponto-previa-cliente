# Realponto — Página do Cliente

Repositório privado da página do cliente, do recebimento de propostas em PHP e do painel de contatos protegido por senha. A branch de trabalho e entrega deste projeto é `main`.

O simulador interno continua no repositório `lucasprimitz/realponto-jornada`. Este projeto não contém sua interface nem seu histórico. A TI pode receber acesso apenas a `lucasprimitz/realponto-previa-cliente` para instalar a página no site da empresa.

## O que instalar

| Objetivo | Roteiro |
| --- | --- |
| Página funcional no site, recebimento e painel protegido | [Solicitações PHP — TI](docs/SOLICITACOES-PHP-TI.md) |
| Manter preços e campanha alinhados ao sistema interno | [Sincronização de preços](docs/SINCRONIZACAO-PRECOS.md) |
| Prévia demonstrativa para aprovação na rede interna | [Instalação da prévia](docs/PREVIA-CLIENTE-TI.md) |
| Atualizar automaticamente somente a prévia estática | [Automação da prévia](docs/ATUALIZACAO-AUTOMATICA-PREVIA.md) |

Para o site da empresa, usar o pacote funcional gerado por `scripts/package-customer-service.mjs`. Copiar apenas os arquivos visuais ou instalar a rotina da prévia não ativa o recebimento de formulários.

## Preços com uma única origem

As regras são mantidas em `dist/quote.mjs` da branch `main` do simulador interno. A automação de origem transfere para este repositório somente o módulo de cálculo, o JSON de preços do PHP e um registro da versão de origem. O acesso ao repositório interno não precisa ser concedido à TI.

A sincronização automática exige configuração da credencial `PREVIA_SYNC_TOKEN` no repositório de origem pelo responsável. A entrega do código não comprova sua ativação. Depois de ativada, uma alteração de preços publicada na origem gera uma atualização aqui. A hospedagem precisa receber uma nova versão completa do pacote para que navegador e PHP usem as mesmas regras. Consulte o roteiro de sincronização antes de ativar ou atualizar.

## Organização

- `customer-preview/`: página em quatro etapas, com envio demonstrativo por padrão e integração com a API no pacote funcional.
- `contacts-panel/`: login, consulta, encaminhamento e observação curta das solicitações.
- `customer-service/`: serviço PHP, fila de e-mail, regras exportadas, configuração de exemplo e testes.
- `dist/quote.mjs`: cópia sincronizada das regras de preços; não editar valores diretamente neste repositório.
- `dist/assets/`: logo usado pela página.
- `scripts/`: preparação dos pacotes, exportação de preços e atualização da prévia estática.
- `docs/`: instalação, configuração e sincronização.
- `tests/`: verificações dos cálculos, pacotes e atualização.

## Verificação local

Com Node.js 24 ou superior, executar `npm test`. Os testes que dependem de links simbólicos Linux ficam identificados como ignorados no Windows.

Para o módulo PHP, instalar as dependências com Composer dentro de `customer-service/`, usando o arquivo de lock. Com PHP no PATH, executar `npm run test:contacts`. Os testes usam dados fictícios e não enviam e-mails reais. As extensões necessárias e a conferência SMTP estão no roteiro PHP.

Para abrir a prévia local: `node customer-preview/server.mjs`. O endereço padrão é `http://127.0.0.1:8937/`, disponível somente no próprio computador.

## Configuração do servidor

A TI ainda precisa definir o endereço HTTPS, configurar PHP, pasta privada persistente, senha, chave de criptografia e envio por SMTP. A credencial da sincronização de preços é diferente das credenciais de hospedagem e e-mail.

Publicar somente a pasta `public/` do pacote funcional. Preservar a configuração privada, chave e dados entre versões. Não enviar senhas, tokens, chave, banco, sessões, contatos reais ou credenciais SMTP ao GitHub. O código não inclui segredos de produção.

A separação e a preparação da sincronização foram autorizadas pelo responsável. Novas alterações e publicações seguem o fluxo de revisão e autorização combinado com Lucas.
