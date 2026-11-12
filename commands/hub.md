---
description: 把這台設成 Myna 主節點（其他機器用 /myna:join 加入）— 開、關遠端 listener，或看狀態；tree 模式用 /myna:hub tree
argument-hint: "[status | on [--name <名稱>] | off | tree [status | on [--name <名稱>] | off]]"
---
**第一個參數是 `tree` 時**（新的 tree 傳輸，走 Tailscale，見 README「不同機器的 session 互傳訊息」）：執行 `node "${CLAUDE_PLUGIN_ROOT}/scripts/hub.mjs" $ARGUMENTS`，下面舊的說明都不適用。
- `tree`／`tree status`（唯讀）— tree 模式開關、節點名稱和 owner、Tailscale、listener、上層、下層、IM 綁定。
- `tree on [--name <名稱>]` — 寫 `MYNA_NODE_PORT`（沒有時 7802）、開這台自己的一條 `tailscale serve`、重啟 relay。`--name` 是這台在地址裡的名稱（`nick@<名稱>`，寫進 `MYNA_MACHINE_NAME`；只有最上層用得到，接在上層下面的節點名稱由上層核發）。這台有 bot 而 owner 還沒綁定 Telegram 帳號時，指令以狀態 **2** 結束並印出綁定步驟（在 bot 聊天室傳 `!bind`、用開著 Tailscale 的手機打開連結）：照著告訴使用者，綁好後再跑一次 `tree on`，就會寫 `MYNA_TRANSPORT=tree` 並重啟。
- `tree off` — 拿掉 `MYNA_TRANSPORT`、`MYNA_NODE_PORT`，只關這台自己那一條 serve，重啟。
- 這台開著舊的多機設定（`MYNA_ROLE=edge`、`MYNA_REMOTE_PORT`）時會擋下，`.env` 不變。不要自己執行任何 `tailscale serve` 指令（尤其 `reset`）。

在**主節點**（手機上那支 bot 所在的機器）執行 `node "${CLAUDE_PLUGIN_ROOT}/scripts/hub.mjs" $ARGUMENTS`（沒有參數時是 `status`）。

- **status**（預設，唯讀，不改任何檔案）— 印出 relay `/health` 的 `role`、`remote`，以及 `~/.myna/machines.json` 裡已加入的機器數量，並提醒 tunnel 要指到實際使用的 port（預設 7801），不能指到 7800。
- **on [--name <名稱>]** — `~/.myna/.env` 還沒有 `MYNA_REMOTE_PORT` 時才寫入 `7801`；已經有值就保留原本的 port。有 `--name` 時寫入 `MYNA_MACHINE_NAME`（topic 前面的短名稱，1–16 個 a-z 0-9 -）。接著用 `ensure-relay.mjs --force` 重啟 relay（開著的題目照 journal 交接），印出 `/health` 的 `remote`（例如 `{"port":7801,"listening":true,"machines":0,"joining":0}`）。
  - 這台是 edge（`MYNA_ROLE=edge`，用 `/myna:join` 加入過別台）或沒有設定 bot 時會擋下並說明原因，`.env` 不會被改。
  - relay 重啟了但遠端 listener 沒有開或沒有在聽（port 不合法、被佔用）時會說明並以非零狀態結束。
- **off** — 從 `.env` 拿掉 `MYNA_REMOTE_PORT` 後重啟 relay。`machines.json` 保留不動，之後再 `on` 時已加入的機器照舊有效。`MYNA_REMOTE_PORT` 是環境變數設定的時候關不掉，會擋下並請使用者先移除那個環境變數。

這個指令只寫設定和重啟 relay。tunnel（`cloudflared`）和 Cloudflare Access 要照 README「多台機器共用一支 bot」手動設定，tunnel 一定要指到 `remote.port`，**不要**指到 7800。其他機器接著用 `/myna:join <這台的網址> --name <名稱>` 加入，`/myna:machines` 看已加入的機器。

用繁體中文回報結果；`remote` 是 `null` 或 `listening` 是 `false` 時，提醒看 `~/.myna/relay.log`。
