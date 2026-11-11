"""Build Realponto's private Brazilian state lookup from a DB-IP City Lite CSV.gz."""
import argparse
import csv
import gzip
import hashlib
import ipaddress
import os
from pathlib import Path
import sqlite3
import tempfile
import unicodedata

STATES = (
    "Acre", "Alagoas", "Amapá", "Amazonas", "Bahia", "Ceará", "Distrito Federal",
    "Espírito Santo", "Goiás", "Maranhão", "Mato Grosso", "Mato Grosso do Sul",
    "Minas Gerais", "Pará", "Paraíba", "Paraná", "Pernambuco", "Piauí",
    "Rio de Janeiro", "Rio Grande do Norte", "Rio Grande do Sul", "Rondônia",
    "Roraima", "Santa Catarina", "São Paulo", "Sergipe", "Tocantins",
)


def normalize(text):
    return unicodedata.normalize("NFKD", text).encode("ascii", "ignore").decode().strip().casefold()


STATE_NAMES = {normalize(state): state for state in STATES}
STATE_NAMES["federal district"] = "Distrito Federal"


def read_ranges(filename):
    with gzip.open(filename, "rt", encoding="utf-8", newline="") as source:
        for row in csv.reader(source):
            if row[3] != "BR":
                continue
            first = ipaddress.ip_address(row[0])
            last = ipaddress.ip_address(row[1])
            if first.version != last.version or int(first) > int(last):
                raise ValueError("Faixa de endereços inválida na base de origem.")
            if not (first.is_global and last.is_global):
                continue
            state = STATE_NAMES.get(normalize(row[4]).removeprefix("state of "))
            region = f"{state}, Brasil" if state else "Brasil"
            yield first.version, first.packed, last.packed, region


def compact(ranges):
    pending = None
    for family, first, last, region in ranges:
        if pending is not None:
            old_family, old_first, old_last, old_region = pending
            if family == old_family:
                if first <= old_last:
                    raise ValueError("As faixas da fonte precisam ser ordenadas e disjuntas.")
                if region == old_region and int.from_bytes(first, "big") == int.from_bytes(old_last, "big") + 1:
                    pending = family, old_first, last, region
                    continue
            yield pending
        pending = family, first, last, region
    if pending is not None:
        yield pending


def build(source, output, expected_sha1):
    # The publisher advertises the checksum of the expanded CSV.
    with gzip.open(source, "rb") as stream:
        digest = hashlib.sha1()
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(block)
    if digest.hexdigest() != expected_sha1.lower():
        raise ValueError(f"SHA1 do CSV divergente: {digest.hexdigest()}")
    with tempfile.NamedTemporaryFile(dir=output.parent, suffix=".db", delete=False) as temp:
        temporary = Path(temp.name)
    try:
        db = sqlite3.connect(temporary)
        try:
            db.execute("""CREATE TABLE ranges (family INTEGER NOT NULL, first BLOB NOT NULL,
                       last BLOB NOT NULL, region TEXT NOT NULL, PRIMARY KEY(family,first)) WITHOUT ROWID""")
            db.executemany("INSERT INTO ranges VALUES (?,?,?,?)", compact(read_ranges(source)))
            db.commit()
            count = db.execute("SELECT COUNT(*), COUNT(DISTINCT family), COUNT(DISTINCT region) FROM ranges").fetchone()
            if count[1] != 2 or count[2] < len(STATES):
                raise ValueError(f"Cobertura inesperada: {count}")
            db.execute("VACUUM")
        finally:
            db.close()
        os.replace(temporary, output)
        print(f"{count[0]} faixas, {count[2]} regiões, {output.stat().st_size} bytes.")
    finally:
        temporary.unlink(missing_ok=True)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("source", type=Path, help="CSV.gz oficial")
    parser.add_argument("output", type=Path, help="customer-service/geo/br-regions.db")
    parser.add_argument("--sha1", required=True, help="SHA1 publicado do CSV descompactado")
    args = parser.parse_args()
    build(args.source, args.output, args.sha1)
