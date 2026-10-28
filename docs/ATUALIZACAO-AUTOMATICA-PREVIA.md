# Atualização automática da prévia — roteiro para a TI

Este complemento é para a prévia **já instalada** em `http://192.168.90.7:8082/previa-cliente/`, com arquivos em `/var/www/realponto-previa/current/public/`. A instalação e a ativação abaixo ficam a cargo da TI. Preparar estes arquivos localmente ou enviá-los ao GitHub não ativa a rotina no servidor.

| Ambiente | Repositório / branch | Publicação |
| --- | --- | --- |
| Sistema interno | `lucasprimitz/realponto-jornada` / `main` | Manter a automação e os caminhos existentes |
| Prévia do cliente | `lucasprimitz/realponto-previa-cliente` / `main` | `/var/www/realponto-previa/current/public/` |

O serviço consulta apenas `main` de `lucasprimitz/realponto-previa-cliente`, aproximadamente a cada minuto. Quando encontra uma versão nova, prepara e testa o pacote em uma pasta separada, publica uma nova versão e confere os arquivos pelo endereço HTTP. Se a conferência falhar, restaura o link da versão anterior. As versões anteriores ficam preservadas. Uma execução em andamento não é sobreposta por outra.

As alterações continuam sendo preparadas e revisadas localmente. **Somente depois da autorização do Lucas são enviadas ao GitHub.** Após esse envio, a rotina ativada pela TI pode publicá-las sem uma segunda operação manual. As alterações de preços partem do repositório do simulador interno. Depois que a [sincronização de preços](SINCRONIZACAO-PRECOS.md) estiver configurada, essas alterações chegam ao novo repositório e podem ser publicadas por esta rotina. A sincronização entre repositórios e a publicação no servidor são etapas distintas.

## Migração de uma automação já instalada

Se o timer antigo já estiver ativo, pause-o antes de alterar o repositório:

```bash
sudo systemctl disable --now realponto-previa-update.timer
sudo systemctl stop realponto-previa-update.service
```

Preserve uma cópia do script e do arquivo `/etc/realponto-previa.env` atuais. Instale a versão deste repositório de `scripts/update-customer-preview.mjs` em `/usr/local/lib/realponto-previa/`, mantendo os caminhos de publicação já confirmados. Atualize `PREVIEW_REPOSITORY` para `git@github.com:lucasprimitz/realponto-previa-cliente.git`; a branch `main` é fixada pelo novo script. Configure acesso de leitura somente ao novo repositório, conforme a seção 3, e siga a conferência da seção 4 antes de reativar o timer. O código do atualizador instalado no servidor não é atualizado automaticamente pelo GitHub.

Não recrie o usuário nem sobrescreva caminhos personalizados de uma instalação existente. Preserve as versões e os dados auxiliares já instalados. O novo script faz a busca pelo endereço configurado; não é necessário apagar o cache Git para mudar de repositório.

## 1. Requisitos e conferência inicial

Usar Ubuntu ou Debian com systemd, Git, OpenSSH, `flock` (pacote `util-linux`) e **Node.js 24 ou superior**. O Node é necessário para gerar e testar os arquivos; a página continua sendo servida pelo Apache ou Nginx já instalado. Não precisa abrir outra porta, instalar dependências npm ou alterar o serviço web.

Confira `/usr/bin/node --version`, `/usr/bin/git --version` e `/usr/bin/flock --version`. Se o Node estiver em outro caminho, a TI deve ajustar `ExecStart` no arquivo do serviço. Instale o runtime pelo procedimento de administração adotado pela empresa; não use um runtime pessoal dependente de login interativo.

Antes de começar, confirme que `/var/www/realponto-previa` e `releases` são diretórios reais, exclusivos da prévia, e que `current` é um link para uma versão dentro de `releases`, com subpasta `public`. Preserve a configuração atual do servidor web e anote o resultado de:

```bash
readlink /var/www/realponto-previa/current
curl -I http://192.168.90.7:8082/previa-cliente/
```

Pare e adapte a instalação se a estrutura for diferente. Não use o checkout, o usuário de publicação ou a pasta do atualizador do sistema interno para esta rotina.

## 2. Preparar um usuário e pastas exclusivos

Os comandos seguintes pressupõem que o usuário `realponto-previa` ainda não existe. Se existir, confira sua finalidade antes de reutilizá-lo. Execute a partir de uma cópia aprovada da branch `main` de `lucasprimitz/realponto-previa-cliente`, na raiz que contém `scripts/`, `docs/` e `customer-preview/`.

```bash
set -eu
sudo useradd --system --user-group --create-home \
  --home-dir /var/lib/realponto-previa \
  --shell /usr/sbin/nologin realponto-previa

sudo test -d /var/www/realponto-previa/releases
sudo test ! -L /var/www/realponto-previa
sudo test ! -L /var/www/realponto-previa/releases
sudo test -L /var/www/realponto-previa/current
sudo test -d /var/www/realponto-previa/current/public

sudo install -d -m 0700 -o realponto-previa -g realponto-previa /var/lib/realponto-previa
sudo chown realponto-previa:realponto-previa /var/www/realponto-previa /var/www/realponto-previa/releases
sudo chmod 0755 /var/www/realponto-previa /var/www/realponto-previa/releases

sudo install -d -m 0755 -o root -g root /usr/local/lib/realponto-previa
sudo install -m 0644 -o root -g root scripts/update-customer-preview.mjs \
  /usr/local/lib/realponto-previa/update-customer-preview.mjs
sudo install -m 0644 -o root -g root customer-preview/hosting/realponto-previa.env.example \
  /etc/realponto-previa.env
sudo install -m 0644 -o root -g root customer-preview/hosting/realponto-previa-update.service \
  /etc/systemd/system/realponto-previa-update.service
sudo install -m 0644 -o root -g root customer-preview/hosting/realponto-previa-update.timer \
  /etc/systemd/system/realponto-previa-update.timer
```

A mudança de proprietário acima afeta somente as duas pastas da prévia, sem alterar recursivamente versões antigas. O usuário do servidor web continua precisando apenas de leitura. O código do atualizador e suas configurações permanecem sob administração da TI e **não se atualizam sozinhos** a partir do GitHub.

## 3. Dar acesso de leitura ao GitHub

A TI deve configurar acesso **somente de leitura ao novo repositório privado** `lucasprimitz/realponto-previa-cliente` para o usuário `realponto-previa`, com chave em `/var/lib/realponto-previa/.ssh/`, permissões apropriadas e o host do GitHub validado em `known_hosts`. Use uma identidade dedicada a este repositório. Não é necessário conceder à TI ou a este serviço acesso ao repositório do sistema interno; a automação principal mantém sua própria configuração. Não coloque chaves, tokens ou senhas nos arquivos do projeto, no ambiente de exemplo ou em mensagens.

O arquivo `/etc/realponto-previa.env` contém os caminhos confirmados e a URL SSH do repositório. O modo não interativo e a verificação do host permanecem habilitados. Configure a identidade SSH do novo usuário antes de testar:

```bash
sudo -u realponto-previa -H /usr/bin/git \
  -c core.sshCommand='/usr/bin/ssh -oBatchMode=yes -oStrictHostKeyChecking=yes -oConnectTimeout=15' \
  ls-remote --exit-code git@github.com:lucasprimitz/realponto-previa-cliente.git refs/heads/main
```

O resultado deve mostrar um commit e `refs/heads/main`, sem pedir senha. Referências para a TI: [chaves de implantação de leitura](https://docs.github.com/en/authentication/connecting-to-github-with-ssh/managing-deploy-keys) e [impressões digitais SSH do GitHub](https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/githubs-ssh-key-fingerprints).

## 4. Testar uma execução antes de ativar o agendamento

Na cópia de trabalho da branch, fora das pastas publicadas, execute os testes abaixo como usuário comum. Eles usam repositório Git temporário e servidor HTTP local; não alteram o site instalado nem o GitHub. No Linux, os cenários de publicação, recuperação e isolamento de branches não acompanhadas devem passar sem serem ignorados.

```bash
node --test tests/quote.test.mjs \
  customer-preview/customer-model.test.mjs \
  customer-preview/customer-request.test.mjs \
  tests/customer-preview-package.test.mjs \
  tests/customer-preview-update.test.mjs
```

Se os testes passarem, valide as unidades e execute a primeira atualização:

```bash
sudo systemd-analyze verify /etc/systemd/system/realponto-previa-update.service \
  /etc/systemd/system/realponto-previa-update.timer
sudo systemctl daemon-reload
sudo systemctl start realponto-previa-update.service
sudo journalctl -u realponto-previa-update.service -n 60 --no-pager
```

A primeira execução instala uma versão identificada pelo commit, mesmo se a versão manual tiver o mesmo visual. O serviço fixa esse commit antes da preparação, executa os testes e gera o pacote de oito arquivos públicos. Os arquivos auxiliares e o registro da publicação ficam fora de `public/`.

Confirme o sucesso nos registros, abra a prévia e o sistema principal e confira os dois endereços. Execute `sudo systemctl start realponto-previa-update.service` novamente: sem commit novo, não deve criar outra versão. Se ocorrer erro de acesso ao GitHub, permissões, teste ou conferência HTTP, corrija-o antes de habilitar o timer.

```bash
sudo systemctl enable --now realponto-previa-update.timer
systemctl list-timers realponto-previa-update.timer
```

O agendamento tenta iniciar uma verificação por minuto, respeitando execuções em andamento. O tempo para a atualização aparecer também inclui os testes e a conferência. Quem já estiver com a página aberta deve recarregá-la para ver a versão nova; o formulário não será reiniciado à força.

## 5. Acompanhar, pausar e voltar a uma versão anterior

```bash
# Ver as últimas execuções
sudo journalctl -u realponto-previa-update.service -n 60 --no-pager

# Solicitar uma execução manual com a mesma proteção contra concorrência
sudo systemctl start realponto-previa-update.service

# Pausar antes de qualquer manutenção ou reversão manual
sudo systemctl disable --now realponto-previa-update.timer
sudo systemctl stop realponto-previa-update.service
```

Para uma reversão manual, mantenha o timer parado, identifique a versão desejada dentro de `/var/www/realponto-previa/releases/` e confirme que ela contém `public/`. Cada publicação automática registra o commit e o alvo anterior em `preview-deployment.json`, fora da raiz pública. Escolha a versão conscientemente, sem apagar as outras.

```bash
# Substitua pelo nome de uma versão existente, conferida pela TI.
set -eu
preview_version='NOME_DA_VERSAO_EXISTENTE'
case "$preview_version" in
  ''|*[!A-Za-z0-9_-]*) printf '%s\n' 'Nome de versão inválido'; exit 1 ;;
esac
sudo test -d "/var/www/realponto-previa/releases/$preview_version/public"
sudo ln -s "releases/$preview_version" /var/www/realponto-previa/.rollback-manual
sudo mv -Tf /var/www/realponto-previa/.rollback-manual /var/www/realponto-previa/current
```

Confira a página depois da reversão. Só reative o timer quando a versão desejada também estiver publicada em `main` do novo repositório; caso contrário, a próxima consulta poderá reinstalar o commit mais recente da branch. A rotina não apaga versões antigas automaticamente; a TI pode revisar o espaço em disco e definir retenção, preservando `current` e a versão de retorno.

O formulário continua sendo uma prévia demonstrativa, sem enviar contatos, e-mails ou cobranças. Esta automação cuida apenas da atualização dos arquivos da página. A instalação funcional de contatos segue o roteiro [Solicitações PHP — TI](SOLICITACOES-PHP-TI.md), em uma entrega separada.

Referências de implementação: [timers do systemd](https://www.freedesktop.org/software/systemd/man/latest/systemd.timer.html) e [busca de referências específicas no Git](https://git-scm.com/docs/git-fetch).
