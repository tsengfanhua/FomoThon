#!/usr/bin/env bash
# 啟動整合網站（fomothon），並告訴它三個 Python Agent 的 Python 在哪裡。
# 網站本身只需要 Node.js 22.13 以上；Python 只在網頁上按「爬取最新比賽」或「分析課程」時才會用到。
#
# 這裡給的都是預設值：已經在環境變數或 fomothon/.env 設定過的項目不會被蓋掉。
set -euo pipefail
umask 077   # 平台資料庫含登入階段與稽核紀錄，只給自己讀寫

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="$ROOT/fomothon/.env"

# 環境變數沒設、fomothon/.env 也沒寫的項目才套用預設值（.env 由網站自己載入，這裡不能搶先設定）
default() {
  local name="$1" value="$2"
  if [[ -n "${!name:-}" ]]; then return; fi
  if [[ -f "$ENV_FILE" ]] && grep -Eq "^[[:space:]]*${name}=" "$ENV_FILE"; then return; fi
  export "$name=$value"
}

STATE_DIR="${XDG_STATE_HOME:-$HOME/.local/state}/fomothon"
mkdir -p "$STATE_DIR"

default FOMO_HUB_ROOT "$ROOT"
default FOMO_HUB_PYTHON "${HUB_PYTHON:-$ROOT/.venv/bin/python}"
# 專案放在雲端同步資料夾時，平台自己的資料庫放到本機的個人目錄，避免同步造成鎖定
default FOMO_DB_PATH "$STATE_DIR/fomothon.db"
# 本機展示用：允許從網頁觸發爬蟲與課程分析（會對外連線並呼叫模型）。對外部署請設 FOMO_HUB_JOBS=0。
default FOMO_HUB_JOBS 1
# 助理流程預設用全部真實資料（真實課程、比賽與教師）；所需資料還沒建立時網站會自動退回合成示意資料。
# 可在畫面上切換；想固定用合成資料請設 FOMO_ASSISTANT_SOURCE=demo。
default FOMO_ASSISTANT_SOURCE campus

if [[ -n "${FOMO_HUB_PYTHON:-}" && ! -x "$FOMO_HUB_PYTHON" ]]; then
  echo "提醒：找不到 Python（$FOMO_HUB_PYTHON），網站仍可瀏覽既有資料，但無法從網頁觸發爬蟲與課程分析。" >&2
fi
if [[ -z "${OPENAI_API_KEY:-}" ]]; then
  echo "提醒：未設定 OPENAI_API_KEY，從網頁觸發的分析會失敗；瀏覽與配對不受影響。" >&2
fi

cd "$ROOT/fomothon"
exec node src/http/server.js
