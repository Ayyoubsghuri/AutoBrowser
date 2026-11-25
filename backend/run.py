"""Entry point (also the PyInstaller entry). Electron spawns this with
AUTOBROWSER_PORT and AUTOBROWSER_TOKEN set."""
import uvicorn

from app import config
from app.main import app

if __name__ == "__main__":
    print(f"AUTOBROWSER_READY port={config.PORT}", flush=True)
    uvicorn.run(app, host=config.HOST, port=config.PORT, log_level="warning")
