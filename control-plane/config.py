from pydantic_settings import BaseSettings


class Settings(BaseSettings):
    omb_db_path: str = "/data/omb_ui.db"
    omb_namespace: str = "default"
    port: int = 8000
    encryption_key: str = ""  # Fernet key, base64-encoded; generated if empty

    class Config:
        env_file = ".env"
        env_file_encoding = "utf-8"


settings = Settings()
