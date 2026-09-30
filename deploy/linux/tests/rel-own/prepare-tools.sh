#!/usr/bin/env bash
# 夹具 B/C 的前置工具：钉版 @deepseek-ai/dsh-app-boot@0.1.5-rc.1（+8 个 peer）与钉版 pnpm@12.5.1。
# 🔴 全部装到 /tmp 下的**独立前缀**：不碰 release、不碰服务器、不依赖（也不修）全局 pnpm。
# 为什么不用 `"$(npm prefix -g)/bin/pnpm"`：本机全局那份 12.5.1 的 native 二进制是**残缺 ELF**
#   （`file` 报 missing section headers、`ldd` 直接失败、`--version` 段错误 exit 139）；
#   而 `npm i --prefix <独立前缀> pnpm@12.5.1` 装出来的那份 `--version` = 12.5.1、exit 0（实测）。
# 为什么必须钉版 + --legacy-peer-deps + 显式列 peer：不钉版会装到 0.1.0-rc.6，**函数名与行号全对不上**
#   （那份里没有 ensureProfileSymlink / removeProfileSymlink）；不列 peer 会在 import 时报
#   ERR_MODULE_NOT_FOUND: @deepseek-ai/cordis。
set -euo pipefail

TOOLS_ROOT="${REL_OWN_TOOLS:-/tmp/rel-own-tools}"
APP_BOOT_VER='0.1.5-rc.1'
PNPM_VER='12.5.1'
REGISTRY="${REL_OWN_REGISTRY:-https://registry.npmmirror.com}"

mkdir -p "$TOOLS_ROOT/app-boot" "$TOOLS_ROOT/pnpm"
[[ -f "$TOOLS_ROOT/app-boot/package.json" ]] || printf '%s\n' '{"name":"rel-own-app-boot","private":true}' > "$TOOLS_ROOT/app-boot/package.json"
[[ -f "$TOOLS_ROOT/pnpm/package.json" ]]     || printf '%s\n' '{"name":"rel-own-pnpm","private":true}'     > "$TOOLS_ROOT/pnpm/package.json"

if [[ ! -f "$TOOLS_ROOT/app-boot/node_modules/@deepseek-ai/dsh-app-boot/lib/index.js" ]]; then
  echo "[tools] 装 @deepseek-ai/dsh-app-boot@$APP_BOOT_VER（含 peer，用 --legacy-peer-deps）"
  ( cd "$TOOLS_ROOT/app-boot" && npm install --no-audit --no-fund --legacy-peer-deps --registry="$REGISTRY" \
      "@deepseek-ai/dsh-app-boot@$APP_BOOT_VER" \
      '@deepseek-ai/cordis@^4.0.2' \
      '@deepseek-ai/cordis-plugin-group@^1.0.2' \
      '@deepseek-ai/cordis-plugin-include@^1.0.7' \
      '@deepseek-ai/cordis-plugin-hmr@^1.0.17' \
      '@deepseek-ai/cordis-plugin-loader@^1.0.3' \
      '@deepseek-ai/dsh-launch-environment@^0.1.5-rc.1' \
      '@deepseek-ai/dsh-home-paths@^0.1.5-rc.1' \
      '@deepseek-ai/dsh-system-prompt@^0.1.5-rc.1' >/dev/null )
fi

if [[ ! -x "$TOOLS_ROOT/pnpm/node_modules/.bin/pnpm" ]]; then
  echo "[tools] 装 pnpm@$PNPM_VER"
  ( cd "$TOOLS_ROOT/pnpm" && npm install --no-audit --no-fund --registry="$REGISTRY" "pnpm@$PNPM_VER" >/dev/null )
fi

AB="$TOOLS_ROOT/app-boot/node_modules/@deepseek-ai/dsh-app-boot"
got="$(node -e 'process.stdout.write(require(process.argv[1]).version)' "$AB/package.json")"
[[ "$got" == "$APP_BOOT_VER" ]] || { echo "🔴 app-boot 版本不符：$got ≠ $APP_BOOT_VER" >&2; exit 1; }
pv="$("$TOOLS_ROOT/pnpm/node_modules/.bin/pnpm" --version)"
[[ "$pv" == "$PNPM_VER" ]] || { echo "🔴 pnpm 版本不符：$pv ≠ $PNPM_VER" >&2; exit 1; }

echo "[tools] APP_BOOT_LIB=$AB/lib/index.js"
echo "[tools] PNPM=$TOOLS_ROOT/pnpm/node_modules/.bin/pnpm（version=$pv）"
