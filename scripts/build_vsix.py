#!/usr/bin/env python3
"""Build dist/codex-notify-<version>.vsix (plus a .sha256 file).

Only files on the explicit allowlist below are packaged. Before and after
packaging, every file is scanned for:
  * generic secret patterns (Bark push URLs with a key, private keys, tokens);
  * any line listed in `.local-denylist` (git-ignored, optional) - put your own
    usernames, home paths, e-mail addresses or keys there so they can never ship.

No Node.js / vsce needed; standard library only.
"""
import hashlib
import json
import re
import sys
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
FILES = [
    "package.json", "extension.js",
    "lib/notify.js", "lib/hooks.js", "lib/panel.js", "lib/codexTrust.js",
    "hooks/hook.ps1", "hooks/hook.py",
    "README.md", "README.en.md", "CHANGELOG.md", "LICENSE",
]
GENERIC_PATTERNS = [
    re.compile(r"api\.day\.app/[A-Za-z0-9]{12,}"),           # Bark URL containing a device key
    re.compile(r"-----BEGIN [A-Z ]*PRIVATE KEY-----"),
    re.compile(r"\bgh[pousr]_[A-Za-z0-9]{30,}\b"),            # GitHub tokens
    re.compile(r"\bsk-[A-Za-z0-9_-]{20,}\b"),                 # API-key-looking strings
]


def denylist():
    path = ROOT / ".local-denylist"
    if not path.exists():
        return []
    return [line.strip() for line in path.read_text(encoding="utf-8").splitlines()
            if line.strip() and not line.lstrip().startswith("#")]


def check(name, data, needles):
    text = data.decode("utf-8", errors="replace")
    for pattern in GENERIC_PATTERNS:
        if pattern.search(text):
            sys.exit(f"REFUSED: {name} matches a secret pattern ({pattern.pattern})")
    for needle in needles:
        if needle.lower() in text.lower():
            # Never print the needle itself.
            sys.exit(f"REFUSED: {name} contains an entry from .local-denylist")


def manifest(package):
    repo = package.get("repository", {}).get("url", "")
    return f"""<?xml version="1.0" encoding="utf-8"?>
<PackageManifest Version="2.0.0" xmlns="http://schemas.microsoft.com/developer/vsx-schema/2011" xmlns:d="http://schemas.microsoft.com/developer/vsx-schema-design/2011">
  <Metadata>
    <Identity Language="en-US" Id="{package['name']}" Version="{package['version']}" Publisher="{package['publisher']}"/>
    <DisplayName>{package['displayName']}</DisplayName>
    <Description xml:space="preserve">Codex notifications for Windows and Bark (iOS)</Description>
    <Tags>{','.join(package.get('keywords', []))}</Tags>
    <Categories>Other</Categories>
    <GalleryFlags>Public</GalleryFlags>
    <Properties>
      <Property Id="Microsoft.VisualStudio.Code.Engine" Value="{package['engines']['vscode']}"/>
      <Property Id="Microsoft.VisualStudio.Code.ExtensionKind" Value="ui"/>
      <Property Id="Microsoft.VisualStudio.Services.Links.Source" Value="{repo}"/>
    </Properties>
    <License>extension/LICENSE</License>
  </Metadata>
  <Installation><InstallationTarget Id="Microsoft.VisualStudio.Code"/></Installation>
  <Dependencies/>
  <Assets>
    <Asset Type="Microsoft.VisualStudio.Code.Manifest" Path="extension/package.json" Addressable="true"/>
    <Asset Type="Microsoft.VisualStudio.Services.Content.Details" Path="extension/README.md" Addressable="true"/>
    <Asset Type="Microsoft.VisualStudio.Services.Content.Changelog" Path="extension/CHANGELOG.md" Addressable="true"/>
    <Asset Type="Microsoft.VisualStudio.Services.Content.License" Path="extension/LICENSE" Addressable="true"/>
  </Assets>
</PackageManifest>
"""


CONTENT_TYPES = """<?xml version="1.0" encoding="utf-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension=".json" ContentType="application/json"/><Default Extension=".vsixmanifest" ContentType="text/xml"/>
  <Default Extension=".js" ContentType="application/javascript"/><Default Extension=".md" ContentType="text/markdown"/>
  <Default Extension=".ps1" ContentType="text/plain"/><Default Extension=".py" ContentType="text/plain"/>
  <Default Extension="" ContentType="text/plain"/>
</Types>
"""


def main():
    package = json.loads((ROOT / "package.json").read_text(encoding="utf-8"))
    needles = denylist()
    for name in FILES:
        check(name, (ROOT / name).read_bytes(), needles)

    out = ROOT / "dist" / f"{package['name']}-{package['version']}.vsix"
    out.parent.mkdir(exist_ok=True)
    with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as archive:
        archive.writestr("[Content_Types].xml", CONTENT_TYPES)
        archive.writestr("extension.vsixmanifest", manifest(package))
        for name in FILES:
            archive.write(ROOT / name, "extension/" + name)

    # Re-scan the finished archive, not just the sources.
    with zipfile.ZipFile(out) as archive:
        for name in archive.namelist():
            check(name, archive.read(name), needles)

    digest = hashlib.sha256(out.read_bytes()).hexdigest()
    (out.parent / (out.name + ".sha256")).write_text(f"{digest}  {out.name}\n")
    print(json.dumps({"vsix": str(out.relative_to(ROOT)), "sha256": digest,
                      "files": len(FILES), "denylist_entries": len(needles)}, indent=1))


if __name__ == "__main__":
    main()
