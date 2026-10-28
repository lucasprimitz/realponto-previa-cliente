#!/usr/bin/env python3
"""Publica só a prévia estática por FTPS explícito, sem remoções remotas.

Python 3.10+; biblioteca padrão. Primeiro use DEPLOY_MODE=verificar.
Não publica .htaccess, marcador de destino, configurações, backups ou credenciais.
O manifesto é auxiliar; arquivos não gerenciados permanecem na hospedagem.
Revisão r2: temporários ASCII sem ponto inicial, histórico não oculto,
progresso confirmado por arquivo e resposta FTP detalhada com segredos filtrados.
Não remove arquivos remotos nem tenta escrever diretamente sobre o arquivo final.
O histórico contém somente metadados de arquivos públicos; não contém credenciais.
"""
from __future__ import annotations

import ftplib
import hashlib
import io
import json
import os
import posixpath
import re
import ssl
import sys
import uuid
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path, PurePosixPath
from typing import Any

SCRIPT_VERSION = '2026-10-28-previa-r1'
STATE_NAME = 'realponto-previa-deploy-v1.json'
MARKER_NAME = 'realponto-previa-alvo.txt'
MARKER_BYTES = b'REALPONTO_PREVIA_CLIENTE_DESTINO_V1\n'
STATE_LIMIT = 4 * 1024 * 1024
SITE_ID = 'realponto-previa-cliente'
PAGES = {
    'index.html', 'preview.css', 'app.mjs', 'customer-model.mjs',
    'customer-request.mjs', 'quote.mjs',
}
TREE_TYPES = {
    'assets': {'.jpg', '.jpeg', '.png', '.webp', '.avif', '.gif', '.svg', '.ico'},
}
REQUIRED = tuple(sorted(PAGES)) + ('assets/realponto-30-anos.png',)



class DeployError(RuntimeError):
    """Erro controlado, sem exibir credenciais."""


def safe_detail(value: object) -> str:
    """Filtra credenciais e caracteres de controle antes de exibir respostas FTP."""
    message = str(value)
    secrets = [os.environ.get(key, '') for key in (
        'HOSTGATOR_FTP_PASSWORD', 'HOSTGATOR_FTP_USER', 'HOSTGATOR_FTP_HOST',
    )]
    for secret in sorted((v for v in secrets if v), key=len, reverse=True):
        message = message.replace(secret, '[oculto]')
    message = re.sub(r'(?i)(?:ftp|ftps)://[^\s]+', '[endereço FTP oculto]', message)
    message = re.sub(r'/home[0-9]*/[^/\s]+', '/home/[conta]', message)
    message = re.sub(r'[\x00-\x1f\x7f-\x9f]+', ' ', message)
    return message.strip()[:1800]


def operation_error(stage: str, path: str, error: BaseException) -> DeployError:
    detail = safe_detail(error)
    label = safe_detail(path) or '(conexão)'
    return DeployError(
        f'{stage} | arquivo/caminho: {label} | resposta: {detail or type(error).__name__}. '
        'Nenhuma limpeza remota ou alteração automática de permissões foi executada.'
    )


def ftp_call(stage: str, path: str, action, *args, **kwargs):
    """Mantém a operação e o arquivo no erro sem habilitar debug de credenciais."""
    try:
        return action(*args, **kwargs)
    except ssl.SSLCertVerificationError:
        raise
    except ftplib.all_errors as exc:
        raise operation_error(stage, path, exc) from exc


@dataclass(frozen=True)
class Asset:
    relative: str
    source: Path
    size: int
    digest: str


class StrictFTP_TLS(ftplib.FTP_TLS):
    """Protege também o canal de dados e reutiliza a sessão TLS do controle."""
    def ntransfercmd(self, cmd: str, rest: str | None = None):
        connection, size = ftplib.FTP.ntransfercmd(self, cmd, rest)
        if self._prot_p:
            try:
                connection = self.context.wrap_socket(
                    connection, server_hostname=self.host, session=self.sock.session
                )
            except Exception:
                connection.close()
                raise
        return connection, size


def permitted(relative: str) -> bool:
    path = PurePosixPath(relative)
    if not relative or relative != path.as_posix() or path.is_absolute() or any(part.startswith('.') for part in path.parts):
        return False
    if any(ord(char) < 32 or ord(char) == 127 for char in relative):
        return False
    if '\\' in relative:
        return False
    if len(path.parts) == 1:
        return relative in PAGES
    return path.parts[0] in TREE_TYPES and path.suffix.lower() in TREE_TYPES[path.parts[0]]


def collect(root: Path) -> list[Asset]:
    if root.is_symlink():
        raise DeployError('A pasta de origem não pode ser um link simbólico.')
    root = root.resolve(strict=True)
    for required in REQUIRED:
        path = root / required
        if not path.is_file() or path.is_symlink():
            raise DeployError(f'Falta {required}. Confira PREVIA_LOCAL_DIR e a versão do repositório.')
    selected: list[Asset] = []
    for current_dir, dirnames, filenames in os.walk(root, followlinks=False):
        directory = Path(current_dir)
        # Na raiz só percorre as pastas públicas explicitamente permitidas.
        dirnames[:] = sorted(
            name for name in dirnames
            if not name.startswith('.')
            and not (directory / name).is_symlink()
            and (directory != root or name in TREE_TYPES)
        )
        for name in sorted(filenames):
            file = directory / name
            relative = file.relative_to(root).as_posix()
            if not permitted(relative):
                continue
            if file.is_symlink() or not file.is_file():
                raise DeployError(f'Arquivo não regular: {relative}.')
            if not file.resolve().is_relative_to(root):
                raise DeployError(f'Arquivo fora da raiz: {relative}.')
            with file.open('rb') as handle:
                prefix = handle.read(180)
                if prefix.startswith(b'version https://git-lfs.github.com/spec/v1'):
                    raise DeployError(f'{relative} é um ponteiro Git LFS, não o arquivo. Pare e ajuste o checkout.')
                handle.seek(0)
                digest = hashlib.sha256()
                for part in iter(lambda: handle.read(1024 * 1024), b''):
                    digest.update(part)
            selected.append(Asset(relative, file, file.stat().st_size, digest.hexdigest()))
    homepage = (root / 'index.html').read_text(encoding='utf-8')
    if not re.search(r'''id=["']customer-form["']''', homepage) or './app.mjs' not in homepage:
        raise DeployError('O index.html local não foi reconhecido como a prévia do cliente. Não use a pasta do site institucional.')
    # Recursos antes dos HTMLs; página inicial por último. Não é troca atômica do site inteiro.
    selected.sort(key=lambda asset: (
        2 if asset.relative == 'index.html' else 1 if asset.relative.endswith('.html') else 0,
        asset.relative,
    ))
    return selected


def env_required(name: str) -> str:
    value = os.environ.get(name, '')
    if not value or not value.strip():
        raise DeployError(f'Configure {name} no GitHub antes de continuar.')
    return value


def connection_config() -> tuple[str, int, str, str, str]:
    host = env_required('HOSTGATOR_FTP_HOST').strip()
    user = env_required('HOSTGATOR_FTP_USER')
    password = env_required('HOSTGATOR_FTP_PASSWORD')
    remote = env_required('PREVIA_FTP_DIR').strip()
    if '://' in host or '/' in host or any(c.isspace() for c in host):
        raise DeployError('HOSTGATOR_FTP_HOST deve conter apenas nome do servidor ou IP, sem protocolo ou caminho.')
    if any(c in user + password for c in '\r\n'):
        raise DeployError('Uma credencial contém quebra de linha. Corrija o Secret.')
    if any(ord(c) < 32 for c in remote) or '\\' in remote or '..' in PurePosixPath(remote).parts:
        raise DeployError('PREVIA_FTP_DIR inválido.')
    # Conta restrita à pasta previa-cliente: / é a raiz da APLICAÇÃO, não do site.
    if not remote.startswith('/'):
        raise DeployError('PREVIA_FTP_DIR deve começar com /. Use / na conta restrita à prévia.')
    if remote.startswith(('/home/', '/home1/')):
        raise DeployError('Use o caminho exibido pelo cliente FTP, não /home1/usuario/.')
    try:
        port = int(os.environ.get('HOSTGATOR_FTP_PORT', '21'))
    except ValueError as exc:
        raise DeployError('Porta FTP inválida.') from exc
    if not 1 <= port <= 65535:
        raise DeployError('Porta FTP fora do intervalo válido.')
    return host, port, user, password, remote


def fetch_limited(ftp: StrictFTP_TLS, name: str, limit: int) -> bytes:
    output = bytearray()
    def receive(block: bytes) -> None:
        output.extend(block)
        if len(output) > limit:
            raise DeployError(f'{name}: resposta maior do que o limite de segurança.')
    ftp.retrbinary('RETR ' + name, receive)
    return bytes(output)


def verify_destination(ftp: StrictFTP_TLS) -> None:
    """Exige inicialização manual da subpasta antes de qualquer escrita remota."""
    try:
        marker = fetch_limited(ftp, MARKER_NAME, 256)
    except ftplib.all_errors as exc:
        raise operation_error(
            'RETR: confirmar marcador exclusivo da prévia; nenhum envio iniciado', MARKER_NAME, exc
        ) from exc
    if marker.replace(b'\r\n', b'\n') != MARKER_BYTES:
        raise DeployError('Marcador de destino divergente. Pare: não use a raiz do site institucional.')
    try:
        config = fetch_limited(ftp, '.htaccess', 128 * 1024)
    except ftplib.all_errors as exc:
        raise operation_error('RETR: conferir configuração inicial da prévia', '.htaccess', exc) from exc
    if b'# REALPONTO PREVIA CPANEL v1' not in config:
        raise DeployError('Falta a configuração inicial identificada da prévia no destino. Instale-a manualmente no cPanel.')
    # A presença do arquivo NÃO comprova que o Apache aplicou autenticação/HTTPS.
    # Confirme as respostas 403/401 no navegador antes de liberar o acesso.
    try:
        data = fetch_limited(ftp, 'index.html', 2 * 1024 * 1024)
    except ftplib.error_perm as exc:
        if str(exc).startswith('550'):
            print('Destino preparado para a primeira publicação da prévia.', flush=True)
            return
        raise operation_error('RETR: conferir página existente da prévia', 'index.html', exc) from exc
    if not (b'id="customer-form"' in data or b"id='customer-form'" in data) or b'./app.mjs' not in data:
        raise DeployError('O index.html remoto não é o da prévia. Nenhum arquivo será substituído neste destino.')


def read_state(ftp: StrictFTP_TLS) -> dict[str, dict[str, Any]]:
    try:
        raw = fetch_limited(ftp, STATE_NAME, STATE_LIMIT)
    except ftplib.error_perm as exc:
        if str(exc).startswith(('550', '553')):
            print('Sem histórico acessível da prévia: todos os arquivos permitidos serão candidatos ao envio.', flush=True)
            return {}
        raise operation_error('RETR: ler histórico exclusivo da prévia', STATE_NAME, exc) from exc
    try:
        state = json.loads(raw)
        if not isinstance(state, dict) or state.get('site') != SITE_ID or state.get('schema') != 1:
            raise ValueError('Formato incompatível')
        items = state['files']
        if not isinstance(items, dict):
            raise ValueError('Lista inválida')
        result = {}
        for key, value in items.items():
            if (isinstance(key, str) and permitted(key) and isinstance(value, dict)
                    and isinstance(value.get('size'), int) and value['size'] >= 0
                    and isinstance(value.get('sha256'), str)
                    and re.fullmatch(r'[a-f0-9]{64}', value['sha256'])):
                result[key] = value
        return result
    except (ValueError, TypeError, KeyError):
        print('Histórico inválido: será ignorado, sem excluir arquivos do servidor.', flush=True)
        return {}


def needs_upload(ftp: StrictFTP_TLS, asset: Asset, previous: dict[str, Any], force: bool) -> bool:
    if force or previous.get('sha256') != asset.digest or previous.get('size') != asset.size:
        return True
    try:
        ftp.voidcmd('TYPE I')
        return ftp.size(asset.relative) != asset.size
    except ftplib.error_perm:
        return True


def ensure_parent(ftp: StrictFTP_TLS, relative: str, made: set[str]) -> None:
    parent = posixpath.dirname(relative)
    if not parent:
        return
    current = ''
    for part in parent.split('/'):
        current = posixpath.join(current, part)
        if current in made:
            continue
        try:
            ftp.mkd(current)
        except ftplib.error_perm as mkdir_error:
            # Se já existe, confirma acesso sem presumir que todo erro é benigno.
            old = ftp_call('PWD: consultar diretório atual', current, ftp.pwd)
            try:
                ftp.cwd(current)
            except ftplib.all_errors as cwd_error:
                detail = RuntimeError(
                    f'MKD: {safe_detail(mkdir_error)}; CWD: {safe_detail(cwd_error)}'
                )
                raise operation_error('MKD/CWD: preparar pasta de destino', current, detail) from cwd_error
            else:
                ftp_call('CWD: retornar ao diretório de publicação', old, ftp.cwd, old)
        except ftplib.all_errors as exc:
            raise operation_error('MKD: preparar pasta de destino', current, exc) from exc
        made.add(current)


def temporary_name(name: str, token: str) -> str:
    """Temporário curto e ASCII na mesma pasta do destino, sem ponto inicial."""
    if not (permitted(name) or name == STATE_NAME):
        raise DeployError(f'Destino de escrita não permitido: {safe_detail(name)}.')
    if not re.fullmatch(r'[a-f0-9]{16,32}', token):
        raise DeployError('Identificador de envio inválido.')
    parent = posixpath.dirname(name)
    key = hashlib.sha256(name.encode('utf-8')).hexdigest()[:16]
    return posixpath.join(parent, f'rp-previa-upload-{token}-{key}.tmp')


def upload_atomic(ftp: StrictFTP_TLS, name: str, data, size: int, token: str) -> None:
    temporary = temporary_name(name, token)
    ftp_call(
        'STOR: gravar temporário', f'{name} (temporário: {temporary})',
        ftp.storbinary, 'STOR ' + temporary, data, blocksize=256 * 1024,
    )
    ftp_call('TYPE I: conferir envio binário', name, ftp.voidcmd, 'TYPE I')
    actual_size = ftp_call('SIZE: conferir tamanho do temporário', temporary, ftp.size, temporary)
    if actual_size != size:
        raise DeployError(
            f'Tamanho divergente em {safe_detail(name)}: esperado {size}, recebido {actual_size}. '
            'O arquivo definitivo não foi trocado; o temporário foi preservado para diagnóstico.'
        )
    # Se RNTO for recusado, não apaga o original e não usa STOR direto como fallback.
    response = ftp_call('RNFR: selecionar temporário', temporary, ftp.sendcmd, 'RNFR ' + temporary)
    if not response.startswith('350'):
        raise DeployError(f'Resposta inesperada ao renomear {safe_detail(name)}: {safe_detail(response)}.')
    ftp_call('RNTO: substituir arquivo definitivo', name, ftp.voidcmd, 'RNTO ' + name)


def deploy(ftp: StrictFTP_TLS, assets: list[Asset], publish: bool, force: bool) -> tuple[int, int]:
    verify_destination(ftp)
    previous = read_state(ftp)
    pending = [asset for asset in assets if needs_upload(ftp, asset, previous.get(asset.relative, {}), force)]
    removed = set(previous) - {asset.relative for asset in assets}
    total = sum(asset.size for asset in pending)
    print(f'Permitidos: {len(assets)}; pendentes: {len(pending)}; volume: {total / (1024 ** 2):.2f} MiB.', flush=True)
    if removed:
        print(f'{len(removed)} arquivo(s) antes gerenciado(s) não estão mais no repositório: serão PRESERVADOS no servidor.', flush=True)
    if not publish:
        for asset in pending:
            print('PREVER ' + asset.relative, flush=True)
        print('VERIFICAÇÃO concluída: nenhum arquivo ou diretório remoto foi criado, alterado ou apagado.', flush=True)
        print('A verificação é somente de leitura: não testa escrita nem substituição de arquivos.', flush=True)
        return len(pending), 0
    made: set[str] = set()
    token = uuid.uuid4().hex[:16]
    completed = 0
    try:
        for index, asset in enumerate(pending, 1):
            print(f'[{index}/{len(pending)}] INICIANDO {asset.relative}', flush=True)
            ensure_parent(ftp, asset.relative, made)
            with asset.source.open('rb') as handle:
                upload_atomic(ftp, asset.relative, handle, asset.size, token)
            completed += 1
            print(f'[{index}/{len(pending)}] OK {asset.relative} ({asset.size} bytes)', flush=True)
    except Exception:
        print(
            f'ENVIO INTERROMPIDO: {completed} de {len(pending)} arquivo(s) confirmados nesta execução. '
            'Os confirmados já podem estar atualizados; não há reversão automática. '
            'Nenhum arquivo foi removido por limpeza remota.', flush=True,
        )
        raise
    state = {
        'schema': 1, 'site': SITE_ID,
        'commit': os.environ.get('DEPLOY_COMMIT', ''),
        'updatedAt': datetime.now(timezone.utc).isoformat(),
        'files': {asset.relative: {'sha256': asset.digest, 'size': asset.size} for asset in assets},
    }
    body = (json.dumps(state, ensure_ascii=False, indent=2) + '\n').encode('utf-8')
    print('HISTÓRICO: gravando metadados dos arquivos públicos (sem credenciais).', flush=True)
    try:
        upload_atomic(ftp, STATE_NAME, io.BytesIO(body), len(body), token)
    except Exception:
        print(
            f'Os {completed} arquivo(s) pendentes foram confirmados, mas o histórico não foi confirmado. '
            'A execução ficará com erro e o próximo envio poderá repetir arquivos.', flush=True,
        )
        raise
    print(f'PUBLICAÇÃO concluída: {completed} arquivo(s) enviados. Nenhum arquivo remoto foi excluído.', flush=True)
    return len(pending), completed


def main() -> int:
    if hasattr(sys.stdout, 'reconfigure'):
        sys.stdout.reconfigure(line_buffering=True)
    print(f'Publicador RealPonto Prévia {SCRIPT_VERSION}', flush=True)
    mode = os.environ.get('DEPLOY_MODE', 'verificar')
    if mode not in {'verificar', 'publicar', 'local'}:
        raise DeployError('DEPLOY_MODE inválido.')
    root = Path(os.environ.get('PREVIA_LOCAL_DIR', 'public'))
    assets = collect(root)
    print(f'{len(assets)} arquivos da prévia selecionados. .htaccess, marcador e site institucional não participam do envio.')
    if mode == 'local':
        print('Conferência local concluída, sem conexão com servidor.')
        return 0
    host, port, user, password, remote = connection_config()
    context = ssl.create_default_context()
    context.minimum_version = ssl.TLSVersion.TLSv1_2
    ftp = StrictFTP_TLS(context=context, timeout=60)
    try:
        ftp_call('CONNECT: conectar ao servidor', '', ftp.connect, host, port)
        # AUTH TLS acontece ANTES do envio da senha. Nenhum fallback para FTP simples.
        ftp_call('AUTH TLS: proteger a conexão', '', ftp.auth)
        ftp_call('LOGIN: autenticar conta FTP', '', ftp.login, user, password)
        ftp_call('PROT P: proteger a transferência', '', ftp.prot_p)
        ftp.set_pasv(True)
        ftp_call('CWD: acessar destino configurado', remote, ftp.cwd, remote)
        print('Conexão FTPS com certificado validado. Diretório remoto:', safe_detail(ftp_call('PWD: conferir destino', remote, ftp.pwd)), flush=True)
        deploy(ftp, assets, mode == 'publicar', os.environ.get('FORCE_UPLOAD', '').lower() == 'true')
        return 0
    finally:
        try:
            ftp.quit()
        except Exception:
            ftp.close()


if __name__ == '__main__':
    try:
        sys.exit(main())
    except ssl.SSLCertVerificationError:
        print('ERRO: certificado FTPS não validado. Use o nome oficial que consta no certificado e confirme o servidor com a HostGator. Não desative TLS nem a verificação.', file=sys.stderr)
        sys.exit(1)
    except ftplib.error_perm as error:
        code = str(error)[:3]
        print(f'ERRO FTP {code}: {safe_detail(error)}. Nenhuma limpeza remota será executada.', file=sys.stderr, flush=True)
        sys.exit(1)
    except (DeployError, OSError, EOFError, ssl.SSLError, ftplib.Error) as error:
        # O detalhe mantém a resposta FTP, mas filtra credenciais e caracteres de controle.
        message = safe_detail(error)
        print('ERRO: ' + message, file=sys.stderr, flush=True)
        sys.exit(1)
