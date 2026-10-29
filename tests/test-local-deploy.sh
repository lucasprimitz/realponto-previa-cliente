#!/usr/bin/env bash
# Teste com simuladores para cPanel e curl; não tenta conectar à HostGator real.
set -euo pipefail
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SOURCE="${1:?payload criado pelo build-jornada-deploy.mjs}"
RELEASE='778fb7bc77092046712e92213560e4ae93f4dbd6'
FAKE_HOME="$(mktemp -d /home1/jornadateste-XXXXXX)"
trap 'rm -rf "$FAKE_HOME"' EXIT
mkdir -p "$FAKE_HOME/realponto-cliente/app/src" "$FAKE_HOME/realponto-cliente/app/bin" "$FAKE_HOME/realponto-cliente/data" "$FAKE_HOME/public_html/jornada/api" "$FAKE_HOME/fakebin" \
  "$FAKE_HOME/realponto-cliente/deploy/bin" "$FAKE_HOME/realponto-cliente/deploy/incoming"
cat > "$FAKE_HOME/fakebin/php-simulado" <<'SH'
#!/usr/bin/env bash
if [[ "${1:-}" == '-l' ]]; then exec /usr/bin/php "$@"; fi
if [[ "${1:-}" == '-r' ]]; then
  if [[ "$2" == *'VACUUM INTO'* ]]; then printf 'snapshot-simulado\n' > "${@: -1}"; exit 0; fi
  if [[ "$2" == *'dataDirectory'* ]]; then printf '%s/realponto-cliente/data' "$HOME"; exit 0; fi
  cat >/dev/null; exit 0
fi
if [[ "${1:-}" == *'/bin/check.php' ]]; then echo 'CHECK OK (simulado)'; exit 0; fi
exit 0
SH
cat > "$FAKE_HOME/fakebin/curl" <<'SH'
#!/usr/bin/env bash
if [[ " $* " == *'/api/requests.php'* ]]; then
  if [[ "${MOCK_CURL_BAD:-}" == 1 ]]; then printf '503'; else printf '401'; fi
elif [[ " $* " == *'/api/session.php'* ]]; then
  printf '{"ok":true}'
else
  exit 0
fi
SH
chmod +x "$FAKE_HOME/fakebin/php-simulado" "$FAKE_HOME/fakebin/curl"
# Simular arquivos já existentes, incluindo conteúdo que PRECISA permanecer.
printf 'antigo-app\n' > "$FAKE_HOME/realponto-cliente/app/src/Store.php"
printf 'antigo-html\n' > "$FAKE_HOME/public_html/jornada/index.html"
printf 'ACME EXISTENTE\n' > "$FAKE_HOME/public_html/jornada/.htaccess"
printf '<?php // adapter existente\n' > "$FAKE_HOME/public_html/jornada/api/_bootstrap.php"
printf 'BANCO ORIGINAL\n' > "$FAKE_HOME/realponto-cliente/data/contacts.sqlite"
cat > "$FAKE_HOME/realponto-cliente/config.php" <<EOF
<?php return ['dataDirectory' => '$FAKE_HOME/realponto-cliente/data', 'encryptionKey' => 'SEGREDO-FAKE'];
EOF
cp "$REPO/deploy/bin/deploy-jornada.sh" "$FAKE_HOME/realponto-cliente/deploy/bin/deploy-jornada.sh"
tar -C "$SOURCE" -czf "$FAKE_HOME/realponto-cliente/deploy/incoming/jornada-$RELEASE.tar.gz" .
HASH="$(sha256sum "$FAKE_HOME/realponto-cliente/deploy/incoming/jornada-$RELEASE.tar.gz" | cut -d' ' -f1)"
export HOME="$FAKE_HOME"
export JORNADA_PHP_BIN="$FAKE_HOME/fakebin/php-simulado"
export PATH="$FAKE_HOME/fakebin:$PATH"

# Simular indisponibilidade HTTP após o update e conferir restauração automática.
export MOCK_CURL_BAD=1
if bash "$REPO/deploy/bin/deploy-jornada.sh" "$RELEASE" "$HASH"; then
  echo 'ERRO: deploy deveria ter falhado no endpoint 503'; exit 1
fi
[[ "$(cat "$FAKE_HOME/public_html/jornada/index.html")" == 'antigo-html' ]]
[[ "$(cat "$FAKE_HOME/realponto-cliente/app/src/Store.php")" == 'antigo-app' ]]
[[ "$(cat "$FAKE_HOME/public_html/jornada/.htaccess")" == 'ACME EXISTENTE' ]]
[[ "$(cat "$FAKE_HOME/realponto-cliente/data/contacts.sqlite")" == 'BANCO ORIGINAL' ]]
[[ ! -e "$FAKE_HOME/realponto-cliente/deploy/active-commit.txt" ]]
# Em caso de falha, o estágio é preservado para diagnóstico; removê-lo apenas no fixture.
rm -rf "$FAKE_HOME/realponto-cliente/deploy/releases/$RELEASE"
export MOCK_CURL_BAD=0
bash "$REPO/deploy/bin/deploy-jornada.sh" "$RELEASE" "$HASH"
[[ "$(cat "$FAKE_HOME/realponto-cliente/deploy/active-commit.txt")" == "$RELEASE" ]]
grep -Fq 'SELECT counter FROM rate_limits' "$FAKE_HOME/realponto-cliente/app/src/Store.php"
[[ "$(cat "$FAKE_HOME/public_html/jornada/.htaccess")" == 'ACME EXISTENTE' ]]
[[ "$(cat "$FAKE_HOME/realponto-cliente/data/contacts.sqlite")" == 'BANCO ORIGINAL' ]]
[[ -f "$FAKE_HOME/realponto-cliente/config.php" ]]
BACKUP="$(find "$FAKE_HOME/realponto-cliente/deploy/backups" -mindepth 1 -maxdepth 1 -type d | sort | tail -1)"
# rollback do primeiro backup (não do teste interrompido) para arquivos antigos
FIRST_BACKUP="$(find "$FAKE_HOME/realponto-cliente/deploy/backups" -mindepth 1 -maxdepth 1 -type d | sort | head -1)"
bash "$REPO/deploy/bin/deploy-jornada.sh" --rollback "$(basename "$FIRST_BACKUP")"
[[ "$(cat "$FAKE_HOME/public_html/jornada/index.html")" == 'antigo-html' ]]
[[ "$(cat "$FAKE_HOME/realponto-cliente/app/src/Store.php")" == 'antigo-app' ]]
[[ "$(cat "$FAKE_HOME/public_html/jornada/.htaccess")" == 'ACME EXISTENTE' ]]
[[ "$(cat "$FAKE_HOME/realponto-cliente/data/contacts.sqlite")" == 'BANCO ORIGINAL' ]]
[[ ! -e "$FAKE_HOME/realponto-cliente/deploy/active-commit.txt" ]]
echo 'PASS: proteção de arquivos, fallback HTTP, recuperação e rollback manual.'
