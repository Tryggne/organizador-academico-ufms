# Organizador Acadêmico UFMS

Painel local para acompanhar matérias, módulos, atividades, prazos e notas lidos no AVA UFMS. Os dados são consultados com Playwright e ficam no computador de cada estudante.

## Requisitos

- Windows 10 ou 11
- Node.js 20 ou mais recente
- Acesso ao AVA UFMS

## Instalação e abertura

1. Baixe e extraia este projeto.
2. Dê dois cliques em `1_instalar_dependencias_e_Chromium.vbs`. A instalação roda em segundo plano. Se falhar, consulte `instalacao.log`.
3. Dê dois cliques em `2_abrir_organizador.vbs`. O painel abrirá no navegador.
4. Clique em **Buscar dados do AVA**. Se a sessão tiver expirado, uma janela do navegador será aberta para o login.

Não abra `painel_academico.html` diretamente para atualizar os dados. O HTML precisa do servidor local iniciado pelo arquivo VBS.

## Atualizar e organizar

Use **Atualizar dados do AVA** no painel. Durante a leitura, os dados antigos ficam ocultos; ao terminar, aparece o novo retrato.

Na página de uma matéria, abra um módulo e use **Criar pasta**. Os caminhos são organizados por semestre, matéria e módulo:

- atividade em preparação: `Atividades/Semestre_AAAA_N/Nome_da_Materia/Modulo_N`;
- etapa manual pendente: `Atividades/A_FAZER/Semestre_AAAA_N/Nome_da_Materia/Modulo_N`;
- atividade que o estudante confirmou como enviada: `Atividades/FEITOS/Semestre_AAAA_N/Nome_da_Materia/Modulo_N`.

O painel lê o status no AVA. A existência de um arquivo local não confirma o envio. “Conferir envio” significa que o script não confirmou o status; prazo e nota não identificados também não significam que estejam ausentes no AVA.

## Notas

O painel calcula a média final como `(média dos checkouts × 0,58) + (prova presencial × 0,42)` e usa 6,0 como média mínima. A prova optativa, quando concluída e com nota acima do menor checkout, substitui essa menor nota; ela não é somada como uma avaliação extra. O plano de ensino pode definir quais avaliações são substituíveis.

Quando há notas pendentes, a situação projetada considera os valores que ainda faltam. Essa projeção não é uma aprovação oficial: confira o resultado no SISCAD e no AVA.

## Privacidade e arquivos locais

Este repositório começa sem cursos, notas, atividades ou retratos de estudante. Cada pessoa lê os dados da própria conta.

Durante o uso, o programa guarda os retratos do AVA em uma pasta `Organizador_Academico_AAAA_N` ao lado desta pasta do projeto. Os arquivos de atividade ficam em `Atividades`, também ao lado do projeto. A sessão local do Playwright fica no perfil do usuário do Windows; ela não é enviada ao repositório. Os logs podem registrar detalhes do processo e estão ignorados pelo Git.

Não inclua no GitHub retratos do AVA, arquivos de atividade, perfil do navegador, credenciais ou logs. O arquivo `.gitignore` bloqueia os padrões locais mais comuns.

## Outro semestre

Para selecionar um semestre diferente, abra o terminal nesta pasta e execute:

```text
2_abrir_organizador.vbs --semester 2027.1
```

O programa cria um retrato separado para esse semestre. Depois da primeira leitura, confira no AVA se todos os cursos, módulos e avaliações foram identificados.

## Leitura do AVA

A consulta é somente de leitura. O organizador não envia trabalhos, não substitui arquivos e não altera notas. Antes de qualquer envio, confira a atividade no AVA e faça a submissão manualmente.

## Licença

Este projeto é distribuído sob a licença MIT. Consulte o arquivo `LICENSE`.
