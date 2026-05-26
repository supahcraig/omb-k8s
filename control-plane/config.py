from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", env_file_encoding="utf-8")

    omb_db_path: str = "/data/omb_ui.db"
    omb_namespace: str = "default"
    port: int = 8000
    worker_image: str = "ghcr.io/supahcraig/omb-worker:latest"


settings = Settings()
