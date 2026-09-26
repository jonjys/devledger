#!/usr/bin/env bash
# Build a sideloadable DevLedger APK for arm64 phones (arm64-v8a).
#
# Requires ANDROID_HOME, a JDK, and the Android NDK. NDK_HOME is inferred from
# ANDROID_HOME when it is not already set.
set -euo pipefail
cd "$(dirname "$0")/.."

: "${ANDROID_HOME:?set ANDROID_HOME to the Android SDK}"

if [ -z "${NDK_HOME:-}" ]; then
  NDK_HOME=$(find "$ANDROID_HOME/ndk" -mindepth 1 -maxdepth 1 -type d | sort | tail -1)
fi
: "${NDK_HOME:?install an NDK under \$ANDROID_HOME/ndk or set NDK_HOME}"
export NDK_HOME ANDROID_NDK_HOME="$NDK_HOME"

# NDK r27 ships versioned clang wrappers (aarch64-linux-android24-clang) and
# llvm-ranlib, but OpenSSL's install step calls aarch64-linux-android-ranlib.
LLVM_BIN=$(find "$NDK_HOME/toolchains/llvm/prebuilt" -mindepth 1 -maxdepth 1 -type d | head -1)/bin
NDK_SHIMS="${DEVLEDGER_NDK_SHIMS:-$HOME/.devledger/ndk-shims}"
mkdir -p "$NDK_SHIMS"
ln -sfn "$LLVM_BIN/llvm-ar" "$NDK_SHIMS/aarch64-linux-android-ar"
ln -sfn "$LLVM_BIN/llvm-ranlib" "$NDK_SHIMS/aarch64-linux-android-ranlib"
ln -sfn "$LLVM_BIN/llvm-strip" "$NDK_SHIMS/aarch64-linux-android-strip"
ln -sfn "$LLVM_BIN/aarch64-linux-android24-clang" "$NDK_SHIMS/aarch64-linux-android-clang"
ln -sfn "$LLVM_BIN/aarch64-linux-android24-clang++" "$NDK_SHIMS/aarch64-linux-android-clang++"
ln -sfn "$LLVM_BIN/llvm-ar" "$NDK_SHIMS/armv7-linux-androideabi-ar"
ln -sfn "$LLVM_BIN/llvm-ranlib" "$NDK_SHIMS/armv7-linux-androideabi-ranlib"
ln -sfn "$LLVM_BIN/llvm-strip" "$NDK_SHIMS/armv7-linux-androideabi-strip"
ln -sfn "$LLVM_BIN/armv7a-linux-androideabi24-clang" "$NDK_SHIMS/armv7-linux-androideabi-clang"
ln -sfn "$LLVM_BIN/armv7a-linux-androideabi24-clang++" "$NDK_SHIMS/armv7-linux-androideabi-clang++"
ln -sfn "$LLVM_BIN/llvm-ar" "$NDK_SHIMS/arm-linux-androideabi-ar"
ln -sfn "$LLVM_BIN/llvm-ranlib" "$NDK_SHIMS/arm-linux-androideabi-ranlib"
ln -sfn "$LLVM_BIN/armv7a-linux-androideabi24-clang" "$NDK_SHIMS/arm-linux-androideabi-clang"
ln -sfn "$LLVM_BIN/armv7a-linux-androideabi24-clang++" "$NDK_SHIMS/arm-linux-androideabi-clang++"
export PATH="$NDK_SHIMS:$LLVM_BIN:$PATH"

# Full LTO plus one codegen unit OOMs the link step on a 16 GB machine and on
# GitHub-hosted runners. The APK is still a release build.
export CARGO_BUILD_JOBS="${CARGO_BUILD_JOBS:-1}"
export CARGO_PROFILE_RELEASE_LTO="${CARGO_PROFILE_RELEASE_LTO:-false}"
export CARGO_PROFILE_RELEASE_CODEGEN_UNITS="${CARGO_PROFILE_RELEASE_CODEGEN_UNITS:-8}"
export MAKEFLAGS="${MAKEFLAGS:--j2}"

rustup target add aarch64-linux-android

cd apps/desktop
if [ ! -f src-tauri/gen/android/app/build.gradle.kts ]; then
  npx tauri android init --ci --skip-targets-install
fi

# Release APKs must be signed or Android refuses to install them. A keystore
# passed in DEVLEDGER_ANDROID_KEYSTORE is reused so updates keep the same
# signature. Otherwise a local keystore is created outside the repository.
KEYSTORE="${DEVLEDGER_ANDROID_KEYSTORE:-$HOME/.devledger/devledger-release.keystore}"
ALIAS="${DEVLEDGER_ANDROID_KEY_ALIAS:-devledger}"
STORE_PASS="${DEVLEDGER_ANDROID_KEY_PASSWORD:-}"
if [ -z "$STORE_PASS" ]; then
  if [ -f "$HOME/.devledger/devledger-release.password" ]; then
    STORE_PASS=$(cat "$HOME/.devledger/devledger-release.password")
  else
    mkdir -p "$(dirname "$KEYSTORE")"
    STORE_PASS=$(openssl rand -base64 24 | tr -d '/+=' | head -c 24)
    umask 077
    printf '%s' "$STORE_PASS" > "$HOME/.devledger/devledger-release.password"
  fi
fi
if [ ! -f "$KEYSTORE" ]; then
  mkdir -p "$(dirname "$KEYSTORE")"
  keytool -genkeypair -v \
    -keystore "$KEYSTORE" \
    -alias "$ALIAS" \
    -keyalg RSA -keysize 2048 -validity 10000 \
    -storepass "$STORE_PASS" -keypass "$STORE_PASS" \
    -dname "CN=DevLedger, OU=DevLedger, O=DevLedger, L=Stockholm, ST=Stockholm, C=SE"
fi

python3 - "$KEYSTORE" "$ALIAS" "$STORE_PASS" <<'PY'
import pathlib, sys
keystore, alias, password = sys.argv[1:]
path = pathlib.Path("src-tauri/gen/android/app/build.gradle.kts")
text = path.read_text()
if "signingConfigs" not in text:
    if "import java.io.FileInputStream" not in text:
        if "import java.util.Properties\n" in text:
            text = text.replace(
                "import java.util.Properties\n",
                "import java.io.FileInputStream\nimport java.util.Properties\n",
                1,
            )
        else:
            text = "import java.io.FileInputStream\n" + text
    needle = "buildTypes {"
    insert = """signingConfigs {
        create("release") {
            val keystorePropertiesFile = rootProject.file("keystore.properties")
            val keystoreProperties = Properties()
            if (keystorePropertiesFile.exists()) {
                keystoreProperties.load(FileInputStream(keystorePropertiesFile))
                keyAlias = keystoreProperties["keyAlias"] as String
                keyPassword = keystoreProperties["password"] as String
                storeFile = file(keystoreProperties["storeFile"] as String)
                storePassword = keystoreProperties["password"] as String
            }
        }
    }
    buildTypes {"""
    if needle not in text:
        raise SystemExit("could not find buildTypes in app/build.gradle.kts")
    text = text.replace(needle, insert, 1)
    text = text.replace(
        'getByName("release") {',
        'getByName("release") {\n            signingConfig = signingConfigs.getByName("release")',
        1,
    )
    path.write_text(text)

props = path.parents[1] / "keystore.properties"
props.write_text(
    f"keyAlias={alias}\npassword={password}\nstoreFile={keystore}\n"
)
print(f"signing config written, keystore {keystore}")
PY

npx tauri android build --ci --apk --target aarch64

echo "APKs:"
find src-tauri/gen/android/app/build/outputs/apk -name '*.apk' -print
