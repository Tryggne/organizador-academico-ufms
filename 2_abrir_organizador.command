#!/bin/sh
set -u

cd "$(dirname "$0")" || exit 1

pause_terminal() {
  printf '\nPressione Enter para fechar esta janela... '
  read -r resposta
}

if [ ! -f "node_modules/playwright/package.json" ]; then
  echo "Dependências não instaladas. Abra primeiro 1_instalar_dependencias_e_Chromium.command."
  pause_terminal
  exit 1
fi

url="http://127.0.0.1:8765/"
if curl --silent --fail "$url/api/status" >/dev/null 2>&1; then
  open "$url"
  exit 0
fi

nohup node scripts/organizer-server.cjs "$@" >> organizador.log 2>&1 </dev/null &

tentativa=0
while [ "$tentativa" -lt 30 ]; do
  if curl --silent --fail "$url/api/status" >/dev/null 2>&1; then
    open "$url"
    exit 0
  fi
  tentativa=$((tentativa + 1))
  sleep 0.5
done

echo "O organizador não iniciou. Últimas mensagens do log:"
tail -n 30 organizador.log 2>/dev/null || true
pause_terminal
exit 1
