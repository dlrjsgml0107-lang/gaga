#!/bin/zsh
cd "$(dirname "$0")" || exit 1

if ! command -v node >/dev/null 2>&1 || ! command -v npm >/dev/null 2>&1; then
  echo "Node.js가 설치되어 있지 않습니다."
  echo "https://nodejs.org 에서 LTS 버전을 설치한 뒤 다시 실행해 주세요."
  read -k 1 "?아무 키나 누르면 종료합니다..."
  exit 1
fi

if [ ! -d node_modules ]; then
  echo "처음 실행에 필요한 파일을 설치합니다..."
  npm install || exit 1
fi

( sleep 2; open "http://localhost:3000" ) &
npm start
