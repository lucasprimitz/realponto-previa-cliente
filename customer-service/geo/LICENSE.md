# Origem dos dados regionais

`br-regions.db` contém as faixas públicas de IPv4 e IPv6 brasileiras derivadas da edição de novembro de 2026 do [DB-IP IP to City Lite](https://db-ip.com/db/download/ip-to-city-lite), publicada pela DB-IP sob a [licença Creative Commons Attribution 4.0 International](https://creativecommons.org/licenses/by/4.0/).

A Realponto selecionou as faixas brasileiras, traduziu os nomes dos estados, descartou cidades e coordenadas e agrupou faixas vizinhas com a mesma região. Onde a fonte informa somente o país, a tabela exibe Brasil. A estimativa se refere à rede da conexão. A atribuição à DB-IP deve acompanhar a exibição dos resultados.

O arquivo de origem é [dbip-city-lite-2026-11.csv.gz](https://download.db-ip.com/free/dbip-city-lite-2026-11.csv.gz). O SHA1 publicado do CSV descompactado é `254ef60b261cb4fb613362058b388a480d2a6b92`.

Para atualizar, baixe uma edição oficial, use o SHA1 publicado para o CSV daquela edição, confira os testes de geolocalização e atualize esta identificação.

```sh
python scripts/build-access-regions.py dbip-city-lite-AAAA-MM.csv.gz customer-service/geo/br-regions.db --sha1 SHA1_DO_CSV
```
