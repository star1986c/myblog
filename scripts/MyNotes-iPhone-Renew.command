#!/bin/zsh
# Personal Mac entry point. The pinned build/config live outside the working tree.
set -u
renew_root="$HOME/Library/Application Support/MyNotesRenewal"
renew_python="/opt/homebrew/bin/python3"
renew_exit=1

print "My Notes iPhone 手动续签"
print "请先保存手机上正在编辑的内容并返回主屏幕。"
print "保持 Mac 与 iPhone 解锁、连接同一 Wi-Fi；也可以使用数据线。"
print "此操作沿用原账号和应用标识覆盖安装，不会卸载应用。"
print ""

if [[ ! -x "$renew_python" || ! -f "$renew_root/renew.py" || ! -f "$renew_root/config.json" ]]; then
  print "本机续签配置或 Python 不完整，请检查：$renew_root"
else
  # Keep the Mac awake for this command only; no persistent system setting changes.
  /usr/bin/caffeinate -i "$renew_python" "$renew_root/renew.py" --force --interactive
  renew_exit=$?
fi

if [[ -t 0 ]]; then
  print ""
  read -r "?按回车关闭此窗口…"
fi
exit "$renew_exit"
