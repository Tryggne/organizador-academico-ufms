#!/bin/sh
set -u

cd "$(dirname "$0")" || exit 1

pause_terminal() {
  printf '\nPressione Enter para fechar esta janela... '
  read -r resposta
}

if ! command -v node >/dev/null 2>&1; then
  echo "Node.js 20 ou mais recente não foi encontrado. Instale em https://nodejs.org/ e rode este arquivo novamente."
  pause_terminal
  exit 1
fi

node_major=$(node -p 'Number(process.versions.node.split(".")[0])')
if [ "$node_major" -lt 20 ]; then
  echo "É necessário Node.js 20 ou mais recente. Versão encontrada: $(node --version)."
  pause_terminal
  exit 1
fi

echo "Instalando as dependências..."
if ! npm ci; then
  echo "A instalação das dependências falhou. Confira a mensagem acima e tente novamente."
  pause_terminal
  exit 1
fi

echo "Instalando o Chromium do Playwright..."
if ! npm run install-browser; then
  echo "A instalação do Chromium falhou. Confira a mensagem acima e tente novamente."
  pause_terminal
  exit 1
fi

mkdir -p "../Atividades"
echo "Instalação concluída. Abra 2_abrir_organizador.command para iniciar o painel."
pause_terminal
