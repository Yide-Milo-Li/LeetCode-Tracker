#!/usr/bin/env bash
set -euo pipefail

tag="${GITHUB_REF_NAME:?Missing release tag}"
version=$(node -p "require('./package.json').version")
if [[ "$tag" != "v$version" ]]; then
  echo "Tag $tag must match package version $version." >&2
  exit 1
fi

windows=$(find dist/release-input/windows -type f -name "*_${version}_x64-setup.exe")
macos=$(find dist/release-input/macos -type f -name "*_${version}_aarch64.dmg")
mac_update=$(find dist/release-input/macos -type f -name '*.app.tar.gz')
if [[ ! -f "$windows" || ! -f "$windows.sig" || ! -f "$macos" || ! -f "$mac_update" || ! -f "$mac_update.sig" ]]; then
  echo "Expected signed Windows and macOS update packages and a macOS disk image from this CI run." >&2
  exit 1
fi

signing_files=$(mktemp -d)
trap 'rm -rf "$signing_files"' EXIT
printf '%s' "${LCT_UPDATER_PUBLIC_KEY:?Missing updater public key}" | base64 --decode > "$signing_files/updater.pub"
for package in "$windows" "$mac_update"; do
  base64 --decode < "$package.sig" > "$signing_files/package.minisig"
  minisign -V -q -p "$signing_files/updater.pub" -m "$package" -x "$signing_files/package.minisig"
done

output=dist/release-upload
mkdir -p "$output"
win_name="LeetCode-Tracker_${version}_x64-setup.exe"
mac_name="LeetCode-Tracker_${version}_aarch64.dmg"
mac_update_name="LeetCode-Tracker_${version}_aarch64.app.tar.gz"
cp "$windows" "$output/$win_name"
cp "$windows.sig" "$output/$win_name.sig"
cp "$macos" "$output/$mac_name"
cp "$mac_update" "$output/$mac_update_name"
cp "$mac_update.sig" "$output/$mac_update_name.sig"
cd "$output"
download="https://github.com/${GH_REPO:?Missing release repository}/releases/download/$tag"
jq -n --arg version "$version" --arg win_url "$download/$win_name" \
  --arg mac_url "$download/$mac_update_name" --rawfile win_sig "$win_name.sig" \
  --rawfile mac_sig "$mac_update_name.sig" \
  '{version: $version, platforms: {
    "windows-x86_64": {url: $win_url, signature: $win_sig},
    "darwin-aarch64": {url: $mac_url, signature: $mac_sig}
  }}' > latest.json
assets=("$win_name" "$win_name.sig" "$mac_name" "$mac_update_name" "$mac_update_name.sig" latest.json)
sha256sum "${assets[@]}" > SHA256SUMS.txt
assets+=(SHA256SUMS.txt)

if draft=$(gh release view "$tag" --json isDraft --jq '.isDraft'); then
  if [[ "$draft" != true ]]; then
    echo "Release $tag is already public." >&2
    exit 1
  fi
  gh release upload "$tag" "${assets[@]}" --clobber
else
  options=(--verify-tag --draft --generate-notes --title "LeetCode Tracker $version")
  if [[ "${version%%+*}" == *-* ]]; then
    options+=(--prerelease)
  fi
  gh release create "$tag" "${assets[@]}" "${options[@]}"
fi
