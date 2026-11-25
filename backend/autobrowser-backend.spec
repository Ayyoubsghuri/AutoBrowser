# PyInstaller spec: builds dist/autobrowser-backend/ (a folder with the .exe),
# which electron-builder copies into the app's resources/backend.
from PyInstaller.utils.hooks import collect_submodules

hidden = collect_submodules("uvicorn") + collect_submodules("anthropic") + collect_submodules("openai") + ["pyotp"]

a = Analysis(["run.py"], pathex=["."], hiddenimports=hidden, excludes=["tkinter", "pytest"], noarchive=False)
pyz = PYZ(a.pure)
exe = EXE(pyz, a.scripts, [], exclude_binaries=True, name="autobrowser-backend", console=False, upx=False)
coll = COLLECT(exe, a.binaries, a.datas, name="autobrowser-backend", upx=False)
