# Prévia do cliente — instalação pela TI

**Versão:** `2026-10-27-previa-cliente-v1`  
**Endereço previsto:** `http://192.168.90.7:8082/previa-cliente/`

Este pacote está preparado para aprovação interna. A instalação inicial no servidor fica a cargo da TI, conforme o procedimento manual abaixo. Os arquivos da prévia estão em `lucasprimitz/realponto-previa-cliente`, branch `main`. O sistema interno e sua publicação permanecem no repositório original, sem alteração por este procedimento. Para ativar atualizações automáticas independentes após a instalação, siga o roteiro [Atualização Automática da Prévia](ATUALIZACAO-AUTOMATICA-PREVIA.md), disponível na mesma branch. Apenas enviar arquivos ao GitHub não ativa essa rotina. O site não requer outra porta, banco de dados ou processo Node.js permanente: são oito arquivos estáticos, incluindo o logo, dentro de `public/`.

O formulário é demonstrativo: use dados fictícios. Não envia e-mails, não salva contatos e não realiza cobrança. Não há login próprio. O acesso deve permanecer restrito à rede interna/VPN; o módulo de preços faz parte desta prévia e não deve ser publicado como solução definitiva para clientes externos.

## 1. Conferir o ambiente e o pacote

Identifique qual servidor atende à porta 8082 e qual configuração contém o site atual. Use **somente Apache ou Nginx**, conforme instalado. A documentação anterior do projeto é um modelo, não comprovação da configuração em uso.

Extraia o ZIP em uma pasta de trabalho, fora da raiz pública. Entre na pasta que contém `public/`, `config/`, `VERSAO.txt`, `MANIFESTO.json`, `SHA256SUMS` e este `LEIA-ME-TI.md`. Confira:

```bash
sha256sum -c SHA256SUMS
cat VERSAO.txt
```

Todos os arquivos devem passar. Preserve uma cópia da configuração atual do servidor web. Reserve `/var/www/realponto-previa` como diretório real e exclusivo desta prévia, separado do repositório, da pasta `dist` e dos caminhos manipulados pelo atualizador do sistema interno.

## 2. Instalar os arquivos em uma versão separada

Execute na mesma sessão Bash, a partir da pasta extraída. Os comandos interrompem se a versão já existir ou se `current` for uma pasta real. Não reutilize um identificador de versão para outro conteúdo.

```bash
set -eu
preview_root=/var/www/realponto-previa
preview_version=2026-10-27-previa-cliente-v1
preview_release="$preview_root/releases/$preview_version"

sudo install -d -m 0755 "$preview_root/releases"
if sudo test -e "$preview_root/current" && ! sudo test -L "$preview_root/current"; then
  printf '%s\n' 'Pare: current existe e não é um link simbólico.'
  exit 1
fi
sudo mkdir "$preview_release"
sudo cp -a public "$preview_release/public"
sudo chown -R root:root "$preview_release"
sudo find "$preview_release" -type d -exec chmod 0755 {} +
sudo find "$preview_release" -type f -exec chmod 0644 {} +

preview_previous="$(readlink "$preview_root/current" || true)"
printf '%s\n' "$preview_previous" | sudo tee "$preview_root/anterior-$preview_version.txt" >/dev/null
sudo ln -s "releases/$preview_version" "$preview_root/.current-$preview_version"
sudo mv -Tf "$preview_root/.current-$preview_version" "$preview_root/current"
```

O link `current` aponta para a versão; os arquivos públicos ficam em `current/public/`. Apenas essa subpasta deve ser servida. O usuário do servidor web precisa de leitura, não de escrita. Se houver uma instalação anterior, confira o alvo salvo antes da troca. Não modifique o `current` do sistema interno.

## 3. Acrescentar o caminho ao site existente

Use o exemplo correspondente em `config/`:

- **Apache:** `apache-previa-cliente.conf.example`, dentro do `<VirtualHost>` que já atende à porta 8082. O módulo `headers` deve estar habilitado; confira com `sudo apache2ctl -M`. Se necessário, habilite com `sudo a2enmod headers` antes de validar.
- **Nginx:** `nginx-previa-cliente.conf.example`, dentro do bloco `server` que já atende à porta 8082.

Os exemplos começam permitindo somente acesso local. **Acrescente as mesmas faixas IP autorizadas da LAN/VPN já usadas pelo site interno** nos pontos indicados, mantendo a negação dos demais acessos. Não deduza a máscara a partir do endereço `192.168.90.7` e não libere acesso geral. Caso exista proxy, confira também qual IP chega ao servidor web.

Não substitua o arquivo global, a raiz do site, os controles existentes, a porta ou a automação. Os exemplos mapeiam `/previa-cliente/` para `/var/www/realponto-previa/current/public/`, tratam a barra final, o MIME dos módulos `.mjs`, a ausência de cache e o bloqueio de conexões e envio de formulário. Preserve esses ajustes. No Nginx, mantenha `^~` para evitar conflito com regras de módulos do site interno.

Valide e recarregue **apenas o servidor escolhido**, somente se a validação passar:

```bash
# Apache
sudo apache2ctl configtest && sudo systemctl reload apache2
```

```bash
# OU Nginx
sudo nginx -t && sudo systemctl reload nginx
```

Referências: [Alias no Apache](https://httpd.apache.org/docs/2.4/mod/mod_alias.html#alias) e [alias no Nginx](https://nginx.org/en/docs/http/ngx_http_core_module.html#alias).

## 4. Conferir antes de encaminhar para aprovação

De um equipamento autorizado:

```bash
curl -I http://192.168.90.7:8082/previa-cliente
curl -I http://192.168.90.7:8082/previa-cliente/
curl -I http://192.168.90.7:8082/previa-cliente/app.mjs
curl -I http://192.168.90.7:8082/previa-cliente/quote.mjs
curl -I http://192.168.90.7:8082/previa-cliente/assets/realponto-30-anos.png
```

A primeira URL deve redirecionar para a barra final; as demais devem retornar 200. Os módulos devem ter `Content-Type` JavaScript. Confira `Cache-Control: no-store` e a política CSP. Arquivos inexistentes devem retornar 404, sem exibir outro site ou listar pastas. Um equipamento fora das redes autorizadas deve ter acesso negado.

Abra o endereço no navegador: confira logo, quatro etapas, retorno às etapas preenchidas, cálculos, CPF/CNPJ, pagamento e envio demonstrativo com dados fictícios. “Inativação dos horários antigos” deve aparecer para Secullum RH, RHID e iPonto, mas não para Secullum Offline. Confira também as duas abas e os cálculos do sistema interno original. Aguarde um ciclo de atualização automática informado pela TI, de aproximadamente um minuto, e repita a abertura dos dois endereços.

## 5. Atualizar ou desfazer

Este pacote é uma fotografia para aprovação. O módulo de cálculo vem da cópia sincronizada das regras do sistema interno; consulte [Sincronização de preços](SINCRONIZACAO-PRECOS.md). Sem a automação opcional instalada pela TI, gere e confira outro pacote com identificador novo após a aprovação de novas alterações e repita a instalação. Com a automação ativada e migrada, a prévia acompanha somente `main` de `lucasprimitz/realponto-previa-cliente`, conforme o roteiro complementar. Não edite os módulos manualmente no servidor nem adicione a prévia ao atualizador do sistema principal.

**Se a automação da prévia estiver ativa, pare seu timer e serviço antes de instalar ou reverter manualmente uma versão.** Siga as instruções do roteiro complementar para pausar e retomar; caso contrário, uma nova consulta poderá repor a versão mais recente da branch.

Para voltar à versão anterior, confira o alvo guardado em `anterior-2026-10-27-previa-cliente-v1.txt` e execute:

```bash
set -eu
preview_root=/var/www/realponto-previa
preview_previous="$(cat "$preview_root/anterior-2026-10-27-previa-cliente-v1.txt")"
test -n "$preview_previous"
test -d "$preview_root/$preview_previous/public"
sudo ln -s "$preview_previous" "$preview_root/.rollback-previa"
sudo mv -Tf "$preview_root/.rollback-previa" "$preview_root/current"
```

Se não havia versão anterior, remova somente o trecho de configuração adicionado para a prévia, valide e recarregue o servidor escolhido. Preserve os arquivos para inspeção. Não reverta nem remova o sistema interno. Após qualquer reversão, repita as verificações de acesso.
