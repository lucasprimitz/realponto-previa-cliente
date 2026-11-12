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

Os preços, adicionais, campanha e faixas são mantidos em `customer-service/pricing.json` deste projeto. A página aplica essa tabela e o PHP calcula a estimativa usando o mesmo arquivo validado. A API pública de leitura `/api/pricing.php` fornece os parâmetros ao sistema interno.

Uma alteração aprovada no JSON deve ser validada e publicada pelo processo existente de hospedagem. Depois disso, o sistema interno recebe os valores ao consultar novamente a tabela, sem cópia entre repositórios ou GitHub App. Publicar primeiro a adaptação deste projeto e depois a do sistema interno. Consulte o [roteiro da tabela compartilhada](docs/SINCRONIZACAO-PRECOS.md).

## Organização

- `customer-preview/`: página em quatro etapas, com envio demonstrativo por padrão e integração com a API no pacote funcional.
- `contacts-panel/`: login, consulta, encaminhamento e observação curta das solicitações.
- `customer-service/`: serviço PHP, fila de e-mail, regras exportadas, configuração de exemplo e testes.
- `customer-service/pricing.json`: única fonte editável dos parâmetros comerciais.
- `dist/quote.mjs` e `dist/pricing-catalog.mjs`: fórmula, validação e consulta da tabela compartilhada.
- `dist/assets/`: logo usado pela página.
- `scripts/`: preparação dos pacotes, exportação de preços e atualização da prévia estática.
- `docs/`: instalação, configuração e sincronização.
- `tests/`: verificações dos cálculos, pacotes e atualização.

## Verificação local

Com Node.js 24 ou superior, executar `npm test`. Os testes que dependem de links simbólicos Linux ficam identificados como ignorados no Windows.

Para o módulo PHP, instalar as dependências com Composer dentro de `customer-service/`, usando o arquivo de lock. Com PHP no PATH, executar `npm run test:contacts`. Os testes usam dados fictícios e não enviam e-mails reais. As extensões necessárias e a conferência SMTP estão no roteiro PHP.

Para abrir a prévia local: `node customer-preview/server.mjs`. O endereço padrão é `http://127.0.0.1:8937/`, disponível somente no próprio computador.

## Configuração do servidor

A hospedagem funcional precisa manter HTTPS, PHP, pasta privada persistente, senha, chave de criptografia e envio por SMTP. A consulta compartilhada de preços usa somente dados públicos e dispensa uma credencial entre os projetos.

Publicar somente a pasta `public/` do pacote funcional. Preservar a configuração privada, chave e dados entre versões. Não enviar senhas, tokens, chave, banco, sessões, contatos reais ou credenciais SMTP ao GitHub. O código não inclui segredos de produção.

A separação e a preparação da sincronização foram autorizadas pelo responsável. Novas alterações e publicações seguem o fluxo de revisão e autorização combinado com Lucas.
