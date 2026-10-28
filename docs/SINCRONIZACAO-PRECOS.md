# Sincronização de preços — origem interna e página do cliente

## Responsabilidades

| Parte | Repositório | Branch |
| --- | --- | --- |
| Origem das regras de preços e da campanha | `lucasprimitz/realponto-jornada` | `main` |
| Página do cliente e serviço PHP | `lucasprimitz/realponto-previa-cliente` | `main` |

A TI pode receber acesso somente ao segundo repositório. As regras são mantidas em `dist/quote.mjs` da origem. Não alterar os preços diretamente na cópia da página do cliente nem no JSON do PHP.

O fluxo é: alteração aprovada na origem → sincronização no GitHub → validação do projeto do cliente → publicação de uma nova versão completa na hospedagem pela TI.

## O que a automação transfere

O workflow **Sincronizar Preços da Página do Cliente**, em `.github/workflows/sincronizar-precos.yml` do repositório de origem, atualiza somente:

- `dist/quote.mjs`: módulo de cálculo consumido pela página.
- `customer-service/pricing.json`: parâmetros para o cálculo validado pelo PHP.
- `pricing-sync.json`: identificação do repositório, commit de origem e integridade das regras sincronizadas.

A transferência preserva a página, o painel e os demais arquivos do destino. Não copia o simulador interno, seu histórico, senhas, dados de clientes ou configuração do servidor. A autorização de gravação é do repositório de destino; a limitação aos três arquivos é feita pelo script da automação.

## Ativação pelo responsável do repositório de origem

A automação foi preparada, mas só poderá operar após a configuração da credencial. O token automático do GitHub Actions não tem acesso a outro repositório privado.

1. Na conta que administra os projetos, criar um **fine-grained personal access token**, selecionando somente `lucasprimitz/realponto-previa-cliente` como repositório permitido.
2. Conceder apenas a permissão de repositório **Contents: Read and write**, além dos metadados básicos exigidos pelo GitHub. Definir uma validade e um responsável pela renovação. Não conceder acesso ao repositório interno nessa credencial.
3. Em **Settings → Secrets and variables → Actions** do repositório **de origem** `lucasprimitz/realponto-jornada`, salvar o token como segredo de repositório com o nome exato `PREVIA_SYNC_TOKEN`.
4. Não salvar esse token no repositório do cliente, na hospedagem, em arquivo de código ou em mensagens. Ele é usado somente pelo workflow da origem. Não é necessário entregá-lo à TI que instala a página.
5. Em **Actions** da origem, abrir **Sincronizar Preços da Página do Cliente** e executar **Run workflow** na branch `main`.

Não existe uma variável adicional de habilitação. Se o segredo estiver ausente, vencido ou sem permissão, a execução deve falhar com orientação; essa falha não representa uma sincronização concluída. O responsável deve acompanhar as falhas de Actions e renovar a credencial antes do vencimento.

Referências: [tokens com acesso restrito](https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/managing-your-personal-access-tokens), [segredos do GitHub Actions](https://docs.github.com/en/actions/security-for-github-actions/security-guides/using-secrets-in-github-actions) e [limite do token automático por repositório](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/making-authenticated-api-requests-with-a-github-app-in-a-github-actions-workflow).

## Conferir um ciclo sem mudar o preço real

Depois da configuração, executar manualmente o workflow e conferir seu resultado. Verificar a identificação da origem e o hash em `pricing-sync.json` no destino. A execução deve confirmar a atualização necessária ou informar que as regras já estão iguais, sem precisar alterar um preço apenas para testar.

Executar novamente com a mesma versão confirma o comportamento sem alteração: não deve criar commits de preços repetidos. Se houve alteração simultânea no destino ou outra falha, conferir o estado atual antes de executar novamente; não forçar a substituição do histórico.

O projeto do cliente valida os arquivos recebidos. Seu workflow `.github/workflows/validar-cliente.yml` prepara um artefato com o pacote PHP quando os testes passam. A TI deve conferir o commit e o resultado da execução antes de instalar esse pacote. O teste da automação no GitHub não comprova que a página já foi atualizada no servidor.

## Fazer o valor chegar ao site

**Página funcional em PHP:** a TI deve instalar uma nova versão completa usando o [roteiro de solicitações](SOLICITACOES-PHP-TI.md). O pacote reúne o cálculo do navegador e o JSON do servidor a partir da mesma versão. Não copiar somente `quote.mjs` ou somente `pricing.json`: isso pode deixar a simulação diferente da estimativa registrada. Preservar banco, chave, senha, configuração privada e fila de e-mail entre as versões.

O endereço definitivo e a forma de publicação da hospedagem ainda precisam ser definidos. O projeto não presume acesso ao servidor nem altera automaticamente o site da empresa apenas porque recebeu um commit. A TI poderá integrar a instalação do pacote validado ao seu próprio processo de publicação.

**Prévia estática de aprovação:** após a TI instalar a nova versão do [atualizador da prévia](ATUALIZACAO-AUTOMATICA-PREVIA.md), ele consulta `main` do repositório do cliente aproximadamente a cada minuto e publica os arquivos estáticos. A prévia permanece demonstrativa, sem recebimento de contatos. Essa rotina não instala nem atualiza o serviço PHP.

## Mudanças futuras

Preços, percentuais, limites de pacotes e prazo da campanha devem ser alterados na origem, dentro do fluxo de revisão e autorização definido pelo responsável. Depois da publicação na origem, acompanhar sincronização, testes e implantação. Uma falha mantém a última versão publicada; não afirmar que os valores estão sincronizados sem conferir as etapas.

Mudanças nas formas de pagamento, textos, sistemas disponíveis ou estrutura do cálculo podem exigir ajustes coordenados no frontend e no PHP, além da transferência de parâmetros. Essas alterações devem ser implementadas e testadas como funcionalidade, não tratadas como uma simples troca de preços.
