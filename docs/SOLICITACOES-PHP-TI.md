# Recebimento de propostas e área protegida — TI

Código separado no repositório privado `lucasprimitz/realponto-previa-cliente`, branch `main`, para instalação pela TI no site da empresa. Este módulo ainda não foi instalado nem ativado no servidor. A prévia estática continua demonstrativa. O pacote PHP é uma entrega separada, com ativação explícita.

## Funcionamento

O cliente preenche o formulário. O PHP valida os dados e recalcula a estimativa com as regras compartilhadas do simulador. Uma solicitação registrada recebe um protocolo e aparece no painel `contatos/`, após autenticação por senha. O painel permite marcar **Encaminhado**, registrar **Responsável / observação** com até 160 caracteres e filtrar pendentes ou encaminhados.

A cópia por e-mail é processada por uma fila independente. O destinatário pode ser definido depois, exclusivamente na configuração privada do servidor. Sem SMTP configurado, os registros permanecem no painel com essa situação indicada. Ao ativar o envio, o processador também envia as cópias que estavam aguardando configuração. A TI deve conferir o destinatário antes de ativar, pois essa caixa receberá os dados de contato, CPF/CNPJ informado, configuração, pagamento e estimativa.

O formulário não cobra, não aprova propostas e não envia confirmação automática para o e-mail do cliente. O envio por e-mail é uma cópia para a caixa definida pela TI. O status “enviado” indica aceitação pelo serviço de e-mail; entrega na caixa de entrada deve ser confirmada no teste da TI.

## Proteção e limites

- O navegador recebe a lista somente após validação de senha no servidor. Ocultar a tela ou o botão não é o mecanismo de proteção.
- A senha fica como hash privado, e as sessões têm cookies HttpOnly, SameSite e Secure em produção, com expiração por inatividade e prazo máximo. Alterar o hash invalida os acessos anteriores.
- Os dados da solicitação e a observação ficam criptografados no banco com libsodium. A chave fica fora da pasta pública e fora do Git. Metadados como protocolo, data, encaminhamento e situação do e-mail permanecem disponíveis ao serviço para organização.
- Banco, sessões, chave e configuração devem ficar fora de qualquer raiz pública, alias ou pasta de release. A criptografia não substitui os controles de acesso ao servidor e ao backup.
- O acesso real exige HTTPS, inclusive para o painel usado pela equipe. O endereço interno HTTP atual não deve receber senhas ou contatos reais deste módulo. HTTP só é aceito em localhost para testes locais explícitos.
- Quem estiver autenticado poderá visualizar os contatos na tela e nas ferramentas do navegador. A proteção impede acesso sem autorização; não impede que uma pessoa autorizada copie o que visualiza.
- Cada alteração no painel verifica a versão do registro para evitar que duas pessoas sobrescrevam o encaminhamento uma da outra. O acesso inicial usa uma senha compartilhada; não há identificação individual de autores.

## Definições que a TI deve concluir

1. Endereço HTTPS e local da página: diretório no site ou subdomínio. Formulário, API e painel devem estar na mesma origem. Não há liberação de CORS para outro domínio.
2. PHP em versão suportada pela hospedagem, no mínimo 8.2, com PDO SQLite, sodium, OpenSSL e sessões; Composer para instalar a dependência de e-mail. Os testes locais usaram PHP 8.5.12.
3. Pasta privada persistente e política de backup/retenção. Esta implementação usa SQLite em disco local; se a hospedagem exigir MySQL ou armazenamento compartilhado, adaptar e testar antes da ativação.
4. Senha de acesso, chave de criptografia e seus procedimentos de recuperação, gerados/guardados pela TI. Não encaminhar esses segredos no chat ou no GitHub.
5. Servidor SMTP com TLS, porta, autenticação, remetente autorizado e destinatário. A configuração inicial não depende de definir o destinatário agora.

## Preparar o pacote

Obtenha uma cópia da branch `main` do repositório `lucasprimitz/realponto-previa-cliente`. Confira o resultado dos testes e, quando disponível, o registro `pricing-sync.json` para identificar a versão das regras recebida do sistema interno. Com Node 24 ou superior:

```sh
node scripts/export-contact-pricing.mjs
node scripts/generate-contact-pricing-fixtures.mjs
php customer-service/tests/test.php
node customer-service/tests/http.mjs /CAMINHO/DO/PHP
node scripts/package-customer-service.mjs /CAMINHO/NOVO/realponto-contatos-VERSAO VERSAO
```

O destino precisa ser uma pasta nova. O pacote contém `public/`, fontes do servidor, regras de preço, dependência declarada e este roteiro. Os valores do frontend e do PHP são gerados da mesma versão de `dist/quote.mjs`. Regenerar o pacote completo após alterações aprovadas nos valores ou prazos; não editar apenas o JSON do servidor. A [sincronização de preços](SINCRONIZACAO-PRECOS.md) atualiza os arquivos deste repositório quando configurada na origem. Ela não altera sozinha os arquivos da hospedagem: a TI precisa publicar a nova versão completa, com frontend e PHP juntos.

O empacotador não inclui senha, chave, banco, sessões, dados de teste nem `vendor/`. Na pasta do pacote, executar:

```sh
composer install --no-dev --no-interaction --no-plugins --no-scripts --prefer-dist --optimize-autoloader
```

Publicar **somente `public/`** como raiz web. As pastas `src/`, `bin/`, o Composer e `pricing.json` ficam fora da raiz web. O arquivo `config/nginx.conf.example` é um modelo para a TI adaptar ao domínio, certificado e PHP-FPM instalados; não é uma configuração pronta para substituir o site existente. Em Apache, aplicar os mesmos limites de publicação, HTTPS, tipos MIME (`text/javascript` para `.mjs`), bloqueio de listagem de pastas e cabeçalhos de segurança.

## Configuração privada

Copiar `config.example.php` para, por exemplo, `/etc/realponto-contatos/config.php`, fora da pasta publicada. Configurar `CONTACTS_CONFIG_FILE` com esse caminho no ambiente do PHP-FPM/Apache e do processador de e-mail. Se usar PHP-FPM com limpeza de ambiente, definir a variável no pool ou como parâmetro FastCGI confiável, não como parâmetro enviado pelo usuário.

Preencher:

| Campo | Configuração |
| --- | --- |
| `origin` | Origem HTTPS exata, sem caminho e sem barra final, por exemplo `https://jornada.SEUDOMINIO` |
| `cookiePath` | Caminho que inclui a API; `/` funciona para implantação na raiz ou subdiretório |
| `dataDirectory` | Pasta privada persistente, por exemplo `/var/lib/realponto-contatos` |
| `encryptionKey` | Base64 de 32 bytes aleatórios, gerados com `random_bytes`; guardar backup seguro |
| `passwordHash` | Hash de uma senha forte usando `password_hash`, gerado no servidor por entrada protegida |
| `submissionsEnabled` | Manter `false` até concluir a instalação e ativar somente para o teste final controlado |
| `developmentLoopback` | `false` em produção |
| `mail.enabled` | `false` até configurar e testar SMTP e destinatário |
| `mail.host`, `port`, `encryption` | Servidor autorizado, normalmente porta 587 com `tls` ou 465 com `ssl`; verificação TLS permanece ativa |
| `mail.authentication`, `username`, `password` | Dados do serviço de e-mail, nunca do navegador |
| `mail.from`, `recipient` | Remetente autorizado e caixa de destino definida pela TI |

O serviço PHP precisa ler a configuração e escrever somente na pasta privada de dados/sessões. Código e configuração não devem ser graváveis pelo processo web. No Linux, restringir a pasta privada a 0700 e a configuração a 0640 ou mais restritiva, com proprietário/grupo adequados. Não trocar a chave a cada atualização: isso impediria abrir os registros existentes. Guardar banco e chave em backups protegidos, com restauração testada; para SQLite ativo, usar backup consistente que considere WAL, não copiar apenas o arquivo principal enquanto há gravações.

Conferir a configuração com o mesmo usuário do serviço:

```sh
CONTACTS_CONFIG_FILE=/etc/realponto-contatos/config.php php /CAMINHO/DO/PACOTE/bin/check.php
```

A variável opcional `CONTACTS_SUBMISSIONS_ENABLED=1` sobrescreve a opção de recebimento. Só a definir conscientemente; não é necessária se `submissionsEnabled` já estiver configurado.

## Processamento do e-mail

Executar `bin/worker.php` pelo mesmo usuário com acesso aos dados, a cada minuto usando cron ou timer gerenciado pela TI. Exemplo de comando:

```sh
CONTACTS_CONFIG_FILE=/etc/realponto-contatos/config.php php /CAMINHO/ESTAVEL/DO/PACOTE/bin/worker.php
```

O processador impede duas execuções simultâneas sobre a mesma pasta de dados, tenta novamente em falhas transitórias e interrompe após cinco tentativas, deixando a falha visível no painel. Depois de corrigir a causa, a TI pode reagendar as falhas:

```sh
CONTACTS_CONFIG_FILE=/etc/realponto-contatos/config.php php /CAMINHO/ESTAVEL/DO/PACOTE/bin/worker.php --retry-failed
```

Se um processo for interrompido após o SMTP aceitar a mensagem e antes de registrar o sucesso, uma cópia poderá ser reenviada. O protocolo identifica a mesma solicitação; não é criado outro contato. A fila não possui garantia de entrega única por e-mail.

## Entrada pelo sistema interno

O cabeçalho e o botão do sistema interno pertencem ao repositório original e não estão incluídos neste projeto separado. Depois de definir a hospedagem, informar ao responsável pelo sistema interno o endereço HTTPS do painel `contatos/`, para que ele configure o atalho **Solicitações**. A TI pode instalar e testar o painel diretamente por esse endereço sem receber acesso ao código do simulador interno. O formulário do cliente não expõe os contatos; a tela de login pode ser acessível, mas todas as leituras e alterações de dados exigem sessão autenticada no PHP.

O painel e a API precisam de `Cache-Control: no-store`, `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer` e proteção contra enquadramento (`frame-ancestors 'none'` / `X-Frame-Options: DENY`). O HTML funcional usa `connect-src 'self'`. Não reutilizar a configuração estática da prévia com `connect-src 'none'`, pois ela bloqueia o envio.

## Conferência antes de liberar

Usar dados fictícios e uma caixa de teste autorizada pela TI. Ativar o recebimento apenas no ambiente controlado para esta conferência:

1. Enviar uma solicitação; confirmar o protocolo, CPF/CNPJ opcional e pagamento escolhido no painel.
2. Antes de entrar, tentar a API de listagem e atualização: devem negar acesso sem devolver dados. Verificar que nenhum contato, senha, chave ou arquivo de banco aparece nos arquivos públicos.
3. Entrar com senha, salvar encaminhamento/observação, atualizar a página e confirmar a persistência. Sair e confirmar que a lista volta a exigir senha.
4. Conferir preços e prazo da campanha no servidor. Campos de valor enviados manualmente pelo navegador não podem substituir o cálculo do servidor.
5. Repetir o mesmo envio após simular falha de conexão: deve manter o mesmo protocolo durante a mesma tentativa da aba. Uma nova aba/novo preenchimento é uma nova solicitação.
6. Configurar a caixa de teste e executar a fila. Confirmar recebimento e resposta ao cliente pelo endereço correto. Simular falha de SMTP e confirmar que o contato continua no painel.
7. Confirmar TLS, cookies, expiração da sessão, bloqueio de excesso de tentativas, permissões, backup e caminhos privados. A TI deve monitorar volume e aplicar os limites do proxy conforme a rede; o serviço usa o endereço remoto fornecido pelo servidor, não confia automaticamente em `X-Forwarded-For` do navegador.

Depois desses testes e da autorização do responsável, liberar os acessos reais e configurar a rotina de e-mail.

## Atualizações futuras

O atualizador da prévia estática continua sendo uma entrega independente. Ele não instala PHP, cria banco, ativa e-mail ou publica este painel. Para o módulo funcional, gerar uma nova versão do pacote e manter a mesma configuração privada e pasta persistente. Executar as verificações antes de apontar o servidor para a nova versão. A separação das fontes em um repositório próprio foi autorizada pelo responsável. A ativação no servidor depende da instalação e das definições da TI; guardar o código no GitHub não ativa o módulo.

Referências: [sessões PHP](https://www.php.net/session.security.management), [hash de senhas](https://www.php.net/manual/en/function.password-hash.php), [criptografia autenticada do Sodium](https://www.php.net/sodium-crypto-secretbox), [PHPMailer](https://github.com/PHPMailer/PHPMailer).
