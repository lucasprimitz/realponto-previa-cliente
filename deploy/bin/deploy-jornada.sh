#!/usr/bin/env bash
# RealPonto Jornada - implantação funcional segura em hospedagem HostGator.
# Executar pela conta cPanel, NUNCA root. Não toca public_html/index.html.
# Não atualiza/expõe config.php, banco, sessões, .htaccess ou api/_bootstrap.php.
set -Eeuo pipefail
umask 077

BASE="$HOME/realponto-cliente"
APP="$BASE/app"
PUBLIC="$HOME/public_html/jornada"
DEPLOY="$BASE/deploy"
ARCHIVES="$DEPLOY/incoming"
RELEASES="$DEPLOY/releases"
BACKUPS="$DEPLOY/backups"
STATE="$DEPLOY/active-commit.txt"
PHP_BIN="${JORNADA_PHP_BIN:-/opt/cpanel/ea-php83/root/usr/bin/php}"
WEB="https://jornada.realponto.com.br"

say() { printf '[JORNADA] %s\n' "$*"; }
fail() { say "BLOQUEADO: $*" >&2; exit 1; }
valid_id() { [[ "$1" =~ ^[a-f0-9]{40}$ ]]; }
valid_backup() { [[ "$1" =~ ^[a-f0-9]{40}-[0-9]{8}T[0-9]{6}Z$ ]]; }
[[ "$HOME" == /home*/* ]] || fail 'HOME inesperada.'
[[ -f "$BASE/config.php" && -f "$PUBLIC/api/_bootstrap.php" && -f "$PUBLIC/.htaccess" ]] || fail 'A instalação funcional existente está incompleta.'
[[ -x "$PHP_BIN" ]] || fail 'PHP 8.3 da conta indisponível.'
command -v tar >/dev/null && command -v sha256sum >/dev/null && command -v flock >/dev/null || fail 'Dependências de shell indisponíveis.'
mkdir -p "$ARCHIVES" "$RELEASES" "$BACKUPS"
chmod 700 "$DEPLOY" "$ARCHIVES" "$RELEASES" "$BACKUPS" 2>/dev/null || true

# Um deploy por vez; não mexe no bloqueio da fila de e-mail.
exec 9>"$DEPLOY/deploy.lock"
flock -n 9 || fail 'Outro deploy está em andamento.'

atomic_copy() {
  local src="$1" dst="$2" tmp
  [[ -f "$src" && ! -L "$src" ]] || return 1
  mkdir -p "$(dirname "$dst")"
  tmp="${dst}.rp-upload-$$"
  cp -p -- "$src" "$tmp"
  chmod 644 "$tmp"
  mv -f -- "$tmp" "$dst"
}

BACKUP=''
restore_backup() {
  local dir="$1" file rel dst
  [[ -f "$dir/backup-ok.txt" ]] || fail 'Backup não foi concluído; rollback manual necessário.'
  say 'Restaurando arquivos anteriores; config.php e data/ ficam intocados.'
  for part in private public; do
    while IFS= read -r -d '' file; do
      rel="${file#"$dir/$part/"}"
      if [[ "$part" == private ]]; then dst="$APP/$rel"; else dst="$PUBLIC/$rel"; fi
      atomic_copy "$file" "$dst"
    done < <(find "$dir/$part" -type f -print0)
  done
  if [[ -f "$dir/added-files.txt" ]]; then
    while IFS= read -r line; do
      case "$line" in
        private/*) rel="${line#private/}"; dst="$APP/$rel" ;;
        public/*) rel="${line#public/}"; dst="$PUBLIC/$rel" ;;
        *) fail 'Caminho de rollback inesperado.' ;;
      esac
      if [[ "$rel" == /* || "$rel" == *'..'* || "$rel" == *\\* || -z "$rel" ]]; then fail 'Caminho inválido de rollback.'; fi
      rm -f -- "$dst"
    done < "$dir/added-files.txt"
  fi
  if [[ -s "$dir/previous-release.txt" ]]; then
    cp -p -- "$dir/previous-release.txt" "$STATE"
  else
    rm -f "$STATE"
  fi
  say 'Rollback dos arquivos concluído. Banco e configurações não foram revertidos.'
}
if [[ "${1:-}" == '--rollback' ]]; then
  valid_backup "${2:-}" || fail 'Informe o identificador completo do backup.'
  [[ -d "$BACKUPS/$2" ]] || fail 'Backup não encontrado.'
  restore_backup "$BACKUPS/$2"
  exit 0
fi

SHA="${1:-}"
EXPECTED_DIGEST="${2:-}"
valid_id "$SHA" || fail 'SHA do commit inválido.'
[[ "$EXPECTED_DIGEST" =~ ^[a-f0-9]{64}$ ]] || fail 'SHA256 do pacote inválido.'
ARCHIVE="$ARCHIVES/jornada-$SHA.tar.gz"
STAGE="$RELEASES/$SHA"
[[ -f "$ARCHIVE" ]] || fail 'Pacote não encontrado no diretório de entrada.'
printf '%s  %s\n' "$EXPECTED_DIGEST" "$ARCHIVE" | sha256sum -c --status || fail 'Hash SHA256 do pacote diferente do CI.'
if [[ -f "$STATE" && "$(cat "$STATE")" == "$SHA" ]]; then
  say "Commit $SHA já consta como ativo. Nenhuma alteração realizada."
  exit 0
fi
[[ ! -e "$STAGE" ]] || fail 'Pacote deste commit já foi preparado; revise a execução anterior.'
# Não aceitar caminhos fora do conjunto público e privado previsto.
while IFS= read -r member; do
  case "$member" in
    ./|./public|./public/|./private|./private/|./private/app|./private/app/|./MANIFESTO-JORNADA.json|./SHA256SUMS|./public/*|./private/app/*) ;;
    *) fail "Caminho inesperado no pacote: $member" ;;
  esac
  [[ "$member" != *'/../'* && "$member" != '../'* && "$member" != /* ]] || fail 'Travessia de diretório detectada.'
done < <(tar -tzf "$ARCHIVE")
mkdir -p "$STAGE"
tar -xzf "$ARCHIVE" -C "$STAGE" --no-same-owner --no-same-permissions
find "$STAGE" -type l | grep -q . && fail 'O pacote não pode conter links simbólicos.'
[[ -f "$STAGE/SHA256SUMS" && -f "$STAGE/MANIFESTO-JORNADA.json" ]] || fail 'Manifesto ausente.'
(cd "$STAGE" && sha256sum --check --status SHA256SUMS) || fail 'Hashes internos do pacote não conferem.'
grep -Fq "\"release\": \"$SHA\"" "$STAGE/MANIFESTO-JORNADA.json" || fail 'Manifesto não identifica o commit pedido.'
for f in "$STAGE/public/index.html" "$STAGE/public/api/requests.php" "$STAGE/public/request-transport.mjs" \
  "$STAGE/private/app/src/Store.php" "$STAGE/private/app/bin/check.php" "$STAGE/private/app/vendor/autoload.php"; do
  [[ -f "$f" ]] || fail "Arquivo obrigatório ausente: ${f#"$STAGE/"}"
done
for forbidden in "$STAGE/public/.htaccess" "$STAGE/public/api/_bootstrap.php" "$STAGE/private/config.php" "$STAGE/private/data"; do
  [[ ! -e "$forbidden" ]] || fail 'Pacote tenta modificar um arquivo protegido.'
done
if grep -Fq 'RETURNING counter' "$STAGE/private/app/src/Store.php"; then fail 'Store.php depende de SQLite >=3.35, incompatível com esta conta.'; fi
while IFS= read -r -d '' f; do "$PHP_BIN" -l "$f" >/dev/null || fail "PHP inválido: $f"; done < <(find "$STAGE/private/app" "$STAGE/public/api" -type f -name '*.php' -print0)
# Carrega a configuração persistente da conta usando o código NOVO, antes de substituir.
say 'Verificando PHP, SQLite e configuração existente com o código novo.'
CONTACTS_CONFIG_FILE="$BASE/config.php" "$PHP_BIN" "$STAGE/private/app/bin/check.php" || fail 'Verificação PHP/SQLite da nova versão falhou.'
# Evita substituir código enquanto o worker de e-mails mantém seus arquivos carregados.
MAIL_DIR="$("$PHP_BIN" -r '$c=require $argv[1]; echo rtrim($c["dataDirectory"],"/\\");' "$BASE/config.php")"
[[ -d "$MAIL_DIR" ]] || fail 'Diretório privado da fila não encontrado.'
exec 8>>"$MAIL_DIR/mail-worker.lock"
flock -w 30 8 || fail 'Worker SMTP ocupado; implantação cancelada sem alterações.'

ID="$SHA-$(date -u +%Y%m%dT%H%M%SZ)"
BACKUP="$BACKUPS/$ID"
mkdir -p "$BACKUP/private" "$BACKUP/public"
[[ ! -e "$BACKUP/backup-ok.txt" ]] || fail 'Backup já existe.'
: > "$BACKUP/added-files.txt"
if [[ -f "$STATE" ]]; then cp -p "$STATE" "$BACKUP/previous-release.txt"; fi

backup_file() {
  local part="$1" file="$2" rel dest save
  if [[ "$part" == private ]]; then rel="${file#"$STAGE/private/app/"}"; else rel="${file#"$STAGE/public/"}"; fi
  [[ "$rel" != /* && "$rel" != *'..'* && "$rel" != *\\* && -n "$rel" ]] || fail 'Caminho relativo inesperado.'
  if [[ "$part" == private ]]; then dest="$APP/$rel"; else dest="$PUBLIC/$rel"; fi
  save="$BACKUP/$part/$rel"
  if [[ -e "$dest" ]]; then
    [[ -f "$dest" && ! -L "$dest" ]] || fail 'Arquivo existente não é regular.'
    mkdir -p "$(dirname "$save")"
    cp -p -- "$dest" "$save"
  else
    printf '%s/%s\n' "$part" "$rel" >> "$BACKUP/added-files.txt"
  fi
}
for part in private public; do
  while IFS= read -r -d '' file; do backup_file "$part" "$file"; done < <(find "$STAGE/$part" -type f -print0)
done
cp -p -- "$BASE/config.php" "$BACKUP/config.php.private-backup"
chmod 600 "$BACKUP/config.php.private-backup"
# SQLite recebe snapshot consistente; NUNCA será restaurado automaticamente.
CONTACTS_CONFIG_FILE="$BASE/config.php" "$PHP_BIN" -r '
$c=require getenv("CONTACTS_CONFIG_FILE");
$f=rtrim($c["dataDirectory"],"/\\")."/contacts.sqlite";
if(!is_file($f)) {fwrite(STDERR,"Banco principal não existe.\n");exit(1);}
$db=new PDO("sqlite:".$f,null,null,[PDO::ATTR_ERRMODE=>PDO::ERRMODE_EXCEPTION]);
$db->exec("VACUUM INTO ".$db->quote($argv[1]));
echo "Snapshot consistente do SQLite criado.\n";
' "$BACKUP/contacts.sqlite" || fail 'Não foi possível preservar um snapshot consistente do SQLite.'
chmod 600 "$BACKUP/contacts.sqlite"
printf 'Backup completo para rollback dos arquivos. Banco e config são somente cópias de segurança.\n' > "$BACKUP/backup-ok.txt"

# EXIT (não apenas ERR) também cobre falhas explícitas com exit 1.
DEPLOY_ACTIVE=1
auto_rollback() {
  local status=$?
  trap - EXIT
  if [[ "$status" -ne 0 && "$DEPLOY_ACTIVE" == 1 && -f "$BACKUP/backup-ok.txt" ]]; then
    say 'Falha durante deploy ou verificação: iniciando rollback automático dos arquivos.' >&2
    restore_backup "$BACKUP" || say 'Rollback automático precisa de intervenção manual.' >&2
  fi
  exit "$status"
}
trap auto_rollback EXIT

# Implantação por arquivo com rename local: não trunca arquivos publicados.
# O HTML principal é o último a ser trocado. A raiz do site institucional não é tocada.
while IFS= read -r -d '' file; do
  atomic_copy "$file" "$APP/${file#"$STAGE/private/app/"}"
done < <(find "$STAGE/private" -type f -print0)
while IFS= read -r -d '' file; do
  [[ "$file" == "$STAGE/public/index.html" ]] && continue
  atomic_copy "$file" "$PUBLIC/${file#"$STAGE/public/"}"
done < <(find "$STAGE/public" -type f -print0)
atomic_copy "$STAGE/public/index.html" "$PUBLIC/index.html"

CONTACTS_CONFIG_FILE="$BASE/config.php" "$PHP_BIN" "$APP/bin/check.php" >/dev/null
# Validar de fato a resposta HTTPS e os endpoints públicos; nada de -k.
curl -fsS --max-time 20 -o /dev/null "$WEB/"
curl -fsS --max-time 20 "$WEB/api/session.php" | "$PHP_BIN" -r '
$j=json_decode(stream_get_contents(STDIN),true);
if (!is_array($j) || ($j["ok"]??null)!==true) exit(1);
' 
code="$(curl -sS --max-time 20 -o /dev/null -w '%{http_code}' "$WEB/api/requests.php")"
[[ "$code" == 401 ]] || fail 'Endpoint de contatos não negou acesso sem autenticação.'
printf '%s\n' "$SHA" > "$STATE"
chmod 600 "$STATE"
DEPLOY_ACTIVE=0
trap - EXIT
say "PUBLICAÇÃO OK: commit $SHA. Site principal não alterado."
say "Backup para reversão manual: $ID"
