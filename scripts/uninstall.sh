#!/usr/bin/env bash
# Stops and removes Sotto's services (and the HTTPS name, if you set one up).
# Keeps your transcripts and settings in ~/Library/Application Support/sotto.
set -uo pipefail
for label in com.sotto.engine com.sotto.web; do
  launchctl bootout "gui/$(id -u)/$label" 2>/dev/null
  rm -f "$HOME/Library/LaunchAgents/$label.plist"
done

CADDY_DATA="/Library/Application Support/sotto-caddy"
CA="$CADDY_DATA/pki/authorities/local/root.crt"
if [ -f /Library/LaunchDaemons/com.sotto.proxy.plist ] || grep -q "# sotto" /etc/hosts; then
  echo "Removing the HTTPS proxy, hosts entry and certificate (asks for your password)"
  sudo launchctl bootout system/com.sotto.proxy 2>/dev/null
  sudo rm -f /Library/LaunchDaemons/com.sotto.proxy.plist
  # Remove exactly the CA this install trusted, so a reinstall trusts its fresh one.
  if sudo test -f "$CA"; then
    fp=$(sudo openssl x509 -in "$CA" -noout -fingerprint -sha1 | cut -d= -f2 | tr -d :)
    sudo security delete-certificate -Z "$fp" /Library/Keychains/System.keychain 2>/dev/null
  fi
  sudo rm -rf "$CADDY_DATA"
  sudo sed -i '' -e '/# sotto$/d' -e '/^# sotto (local only)$/d' /etc/hosts
fi
echo "Sotto is uninstalled. Your library is still in ~/Library/Application Support/sotto."
echo "To remove everything: rm -rf ~/Library/Application\\ Support/sotto ~/Library/Logs/sotto"
echo "                      uv tool uninstall fermion-research && rm -rf ~/.cache/fermion"
