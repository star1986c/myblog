#!/bin/zsh
set -euo pipefail

SCRIPT_DIR="${0:A:h}"
PROJECT_ROOT="${SCRIPT_DIR:h}"
PACKAGE_DIR="${PROJECT_ROOT}/macos/AIBuildNotes"
SCRATCH_DIR="${PACKAGE_DIR}/.build"
OUTPUT_DIR="${PROJECT_ROOT}/output"
CONFIGURATION="${1:-release}"

if [[ "${CONFIGURATION}" != "release" && "${CONFIGURATION}" != "debug" ]]; then
  echo "Usage: $0 [release|debug]" >&2
  exit 2
fi

if [[ "${CONFIGURATION}" == "debug" ]]; then
  APP_PATH="${OUTPUT_DIR}/My Notes Preview.app"
else
  APP_PATH="${OUTPUT_DIR}/My Notes.app"
fi
ICON_SOURCE="${PACKAGE_DIR}/Assets/AppIcon-1024.png"
ICONSET_DIR="${SCRATCH_DIR}/AppIcon.iconset"
ICON_PATH="${SCRATCH_DIR}/AppIcon.icns"

swift build \
  --configuration "${CONFIGURATION}" \
  --package-path "${PACKAGE_DIR}" \
  --scratch-path "${SCRATCH_DIR}"

BIN_DIR="$(swift build \
  --configuration "${CONFIGURATION}" \
  --package-path "${PACKAGE_DIR}" \
  --scratch-path "${SCRATCH_DIR}" \
  --show-bin-path)"

rm -rf "${ICONSET_DIR}"
mkdir -p "${ICONSET_DIR}"
sips -z 16 16 "${ICON_SOURCE}" --out "${ICONSET_DIR}/icon_16x16.png" >/dev/null
sips -z 32 32 "${ICON_SOURCE}" --out "${ICONSET_DIR}/icon_16x16@2x.png" >/dev/null
sips -z 32 32 "${ICON_SOURCE}" --out "${ICONSET_DIR}/icon_32x32.png" >/dev/null
sips -z 64 64 "${ICON_SOURCE}" --out "${ICONSET_DIR}/icon_32x32@2x.png" >/dev/null
sips -z 128 128 "${ICON_SOURCE}" --out "${ICONSET_DIR}/icon_128x128.png" >/dev/null
sips -z 256 256 "${ICON_SOURCE}" --out "${ICONSET_DIR}/icon_128x128@2x.png" >/dev/null
sips -z 256 256 "${ICON_SOURCE}" --out "${ICONSET_DIR}/icon_256x256.png" >/dev/null
sips -z 512 512 "${ICON_SOURCE}" --out "${ICONSET_DIR}/icon_256x256@2x.png" >/dev/null
sips -z 512 512 "${ICON_SOURCE}" --out "${ICONSET_DIR}/icon_512x512.png" >/dev/null
cp "${ICON_SOURCE}" "${ICONSET_DIR}/icon_512x512@2x.png"
iconutil --convert icns "${ICONSET_DIR}" --output "${ICON_PATH}"

rm -rf "${APP_PATH}"
mkdir -p "${APP_PATH}/Contents/MacOS" "${APP_PATH}/Contents/Resources"
cp "${BIN_DIR}/AIBuildNotes" "${APP_PATH}/Contents/MacOS/AIBuildNotes"
cp "${PACKAGE_DIR}/Info.plist" "${APP_PATH}/Contents/Info.plist"
cp "${ICON_PATH}" "${APP_PATH}/Contents/Resources/AppIcon.icns"

codesign --force --deep --sign - "${APP_PATH}"
codesign --verify --deep --strict "${APP_PATH}"

echo "Built ${APP_PATH}"
