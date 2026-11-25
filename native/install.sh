#!/bin/sh
# Registers the "Manual resolution" native messaging host (com.local.remerge)
# with Chromium-based browsers on macOS, for this extension only.
#
#   native/install.sh                 # Chrome, plus Brave/Edge/Chromium if installed
#   native/install.sh --dir <dir>     # one NativeMessagingHosts directory (tests)
#   native/install.sh --uninstall
#
# The extension ID is derived from this folder's path, which is how Chrome
# names an unpacked extension; pass LGG_EXTENSION_ID=... to override.
set -eu

NAME=com.local.remerge
HERE=$(cd "$(dirname "$0")" && pwd)
EXT_DIR=$(cd "$HERE/.." && pwd)
STATE="$HOME/.remerge"

ID=${LGG_EXTENSION_ID:-$(/usr/bin/python3 -c '
import hashlib, sys
h = hashlib.sha256(sys.argv[1].encode()).hexdigest()[:32]
print("".join(chr(ord("a") + int(c, 16)) for c in h))' "$EXT_DIR")}

DIRS=""
UNINSTALL=0
while [ $# -gt 0 ]; do
    case "$1" in
        --dir) DIRS="$2"; shift 2 ;;
        --uninstall) UNINSTALL=1; shift ;;
        *) echo "unknown option $1" >&2; exit 2 ;;
    esac
done
if [ -z "$DIRS" ]; then
    SUPPORT="$HOME/Library/Application Support"
    DIRS="$SUPPORT/Google/Chrome/NativeMessagingHosts"
    for b in "BraveSoftware/Brave-Browser" "Microsoft Edge" "Chromium"; do
        [ -d "$SUPPORT/$b" ] && DIRS="$DIRS
$SUPPORT/$b/NativeMessagingHosts"
    done
fi

if [ "$UNINSTALL" = 1 ]; then
    echo "$DIRS" | while IFS= read -r d; do rm -f "$d/$NAME.json" && echo "removed $d/$NAME.json"; done
    exit 0
fi

# Chrome starts the host with a minimal environment, so the launcher pins the
# python and git found now.
PYTHON=$(command -v python3 2>/dev/null || true)
[ -x /usr/bin/python3 ] && PYTHON=/usr/bin/python3
GIT=$(command -v git)
mkdir -p "$STATE"
cat > "$STATE/remerge-host" <<EOF
#!/bin/sh
REMERGE_GIT='$GIT' exec '$PYTHON' '$HERE/remerge_host.py' "\$@"
EOF
chmod 755 "$STATE/remerge-host"

if [ ! -f "$STATE/repos.json" ]; then
    printf '{\n  "owner/repo": "/path/to/local/clone"\n}\n' > "$STATE/repos.json"
    echo "created $STATE/repos.json: map each GitHub repo to a local clone there"
fi

echo "$DIRS" | while IFS= read -r d; do
    mkdir -p "$d"
    cat > "$d/$NAME.json" <<EOF
{
  "name": "$NAME",
  "description": "git show --remerge-diff for Le Git Graph Plus",
  "path": "$STATE/remerge-host",
  "type": "stdio",
  "allowed_origins": ["chrome-extension://$ID/"]
}
EOF
    echo "installed $d/$NAME.json (extension $ID)"
done
