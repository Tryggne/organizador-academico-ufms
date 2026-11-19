# Organizador Acadêmico UFMS

Painel local para acompanhar matérias, módulos, atividades, prazos e notas lidos no AVA UFMS. Os dados de cada estudante ficam no próprio computador.

## Requisitos

- Windows 10/11 ou macOS
- Node.js 20 ou mais recente
- Acesso ao AVA UFMS

O instalador baixa automaticamente o Chromium usado pelo Playwright. Não é necessário instalar Chrome ou Safari para a leitura do AVA. O painel pode abrir no seu navegador padrão; a janela de login aparece no Chromium separado.

## Instalação no Windows

1. Baixe e extraia este projeto.
2. Abra `1_instalar_dependencias_e_Chromium.vbs`.
3. Depois da instalação, abra `2_abrir_organizador.vbs`.
4. No painel, clique em **Buscar dados do AVA**.

## Instalação no Mac

1. Baixe e extraia este projeto.
2. Abra o Terminal na pasta extraída e rode `chmod +x 1_instalar_dependencias_e_Chromium.command 2_abrir_organizador.command`.
3. Abra `1_instalar_dependencias_e_Chromium.command`. A janela do Terminal mostra a instalação das dependências e do Chromium.
4. Depois, abra `2_abrir_organizador.command` e clique em **Buscar dados do AVA**.

Se o macOS impedir a primeira abertura, clique no arquivo com o botão direito, escolha **Abrir** e confirme. Os arquivos `.command` iniciam o servidor local e abrem o painel no navegador. Não abra `painel_academico.html` diretamente para atualizar os dados.

## Login e atualização

Na primeira leitura, o navegador automatizado abre para você entrar no AVA. A sessão fica salva em um perfil local do Playwright: no Windows, em `%LOCALAPPDATA%/ms-playwright/ava-ufms-organizer`; no Mac, em `~/Library/Application Support/ava-ufms-organizer`.

Se a janela de login não aparecer, confira se ela ficou atrás do painel ou em outra área de trabalho. Se a leitura falhar, a mensagem de erro aparece no painel. No Mac, confira também a instalação do Chromium no Terminal; no Windows, abra `instalacao.log` na pasta do projeto. Em caso de falha no download, rode o instalador novamente.

Nas atualizações seguintes, o Playwright reutiliza essa sessão e consulta o AVA em segundo plano. Se a sessão expirar, uma janela do navegador aparece para você entrar novamente. Use **Atualizar dados do AVA** no painel; durante a consulta, ele esconde os dados antigos e mostra o retrato novo quando terminar.

## Pastas e atividades

Na página de uma matéria, abra um módulo e use **Criar pasta**. O programa cria a pasta e abre o Explorador de Arquivos no Windows ou o Finder no Mac:

- atividade em preparação: `Atividades/Semestre_AAAA_N/Nome_da_Materia/Modulo_N`;
- etapa manual pendente: `Atividades/A_FAZER/Semestre_AAAA_N/Nome_da_Materia/Modulo_N`;
- atividade confirmada como enviada pelo estudante: `Atividades/FEITOS/Semestre_AAAA_N/Nome_da_Materia/Modulo_N`.

O painel lê o status no AVA. A existência de um arquivo local não confirma o envio. “Conferir envio” significa que o script não confirmou o status; prazo e nota não identificados também não significam que estejam ausentes no AVA.

## Notas

O painel calcula a média final como `(média dos checkouts × 0,58) + (prova presencial × 0,42)` e usa 6,0 como média mínima. A prova optativa, quando concluída e com nota acima do menor checkout, substitui essa menor nota; ela não é somada como avaliação extra. O plano de ensino pode definir quais avaliações são substituíveis.

Quando há notas pendentes, a situação projetada considera os valores que ainda faltam. Essa projeção não é aprovação oficial: confira o resultado no SISCAD e no AVA.

## Privacidade

O repositório não contém cursos, notas, atividades, credenciais ou retratos de estudante. Cada pessoa consulta a própria conta. Os retratos ficam em `Organizador_Academico_AAAA_N` ao lado da pasta do projeto; as atividades ficam em `Atividades`, também ao lado do projeto. O organizador não envia trabalhos nem altera notas. Não compartilhe retratos, arquivos de atividade, perfil do navegador ou logs.

## Outro semestre

Para iniciar com outro semestre, passe o argumento ao atalho correspondente. No Windows, abra o VBS pelo terminal; no Mac, rode o `.command` pelo Terminal com `--semester 2027.1`. O programa cria um retrato separado. Depois da primeira leitura, confira no AVA se cursos, módulos, atividades e avaliações foram identificados.

## Licença

Este projeto é distribuído sob a licença MIT. Consulte `LICENSE`.
