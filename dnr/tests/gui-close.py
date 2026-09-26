#!/usr/bin/env python3
"""KDE/KWin native-close regression; only operates on this test's own PID."""
import argparse
import os
from pathlib import Path
import signal
import subprocess
import tempfile
import time

parser = argparse.ArgumentParser()
parser.add_argument("package", type=Path)
parser.add_argument("--backend", choices=["system-cef", "webview"], required=True)
args = parser.parse_args()


def kwin(*arguments):
    return subprocess.check_output(["qdbus6", "org.kde.KWin", *arguments], text=True, timeout=10).strip()


with tempfile.TemporaryDirectory(prefix="etcher-dnr-close-") as directory:
    directory = Path(directory)
    log_path = directory / "application.log"
    with log_path.open("w") as log:
        child = subprocess.Popen(["dnr", "--backend", args.backend, str(args.package.resolve()), "--smoke-hold"],
            env={**os.environ, "XDG_CONFIG_HOME": str(directory / "config"), "DNR_CACHE_DIR": str(directory / "cache")},
            stdout=log, stderr=subprocess.STDOUT, start_new_session=True)
        name = f"etcher-dnr-test-{child.pid}"
        loaded = False
        try:
            deadline = time.monotonic() + 30
            while "DNR_ETCHER_GUI_OK" not in log_path.read_text():
                if child.poll() is not None or time.monotonic() >= deadline:
                    raise RuntimeError(log_path.read_text())
                time.sleep(0.1)
            script = directory / "close.js"
            script.write_text(f"for (const w of workspace.windowList()) if (w.pid === {child.pid}) w.closeWindow();\n")
            identifier = kwin("/Scripting", "org.kde.kwin.Scripting.loadScript", str(script), name)
            assert int(identifier) >= 0
            loaded = True
            kwin(f"/Scripting/Script{identifier}", "org.kde.kwin.Script.run")
            assert child.wait(timeout=15) == 0, log_path.read_text()
            deadline = time.monotonic() + 15
            while True:
                try:
                    os.killpg(child.pid, 0)
                except ProcessLookupError:
                    break
                if time.monotonic() > deadline:
                    raise RuntimeError("GUI/worker subprocess survived native close")
                time.sleep(0.1)
            print(f"PASS {args.backend}: compositor close, worker and GUI process cleanup")
        finally:
            if loaded:
                kwin("/Scripting", "org.kde.kwin.Scripting.unloadScript", name)
            try:
                os.killpg(child.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
            child.wait()
