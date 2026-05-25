import logging

from cryptography.fernet import Fernet

from config import settings

logger = logging.getLogger(__name__)

# Module-level cached Fernet instance (keyed on the actual key used,
# so that a restart with a new key doesn't silently use a stale instance).
_fernet_instance: Fernet | None = None
_fernet_key_used: str | None = None


def get_fernet() -> Fernet:
    """Return a Fernet instance backed by the configured encryption key.

    If no key is configured, a new key is generated for this process lifetime
    and a warning is logged — secrets encrypted with this key will not survive
    a pod restart.
    """
    global _fernet_instance, _fernet_key_used

    key = settings.encryption_key or None

    if not key:
        if _fernet_instance is None:
            generated = Fernet.generate_key().decode()
            logger.warning(
                "No ENCRYPTION_KEY configured — generating an ephemeral key. "
                "Encrypted secrets will NOT survive a pod restart. "
                "Set the encryption_key environment variable in production."
            )
            _fernet_key_used = generated
            _fernet_instance = Fernet(generated.encode())
        return _fernet_instance

    # Key is configured — rebuild if it changed (e.g. test overrides).
    if key != _fernet_key_used:
        _fernet_key_used = key
        _fernet_instance = Fernet(key.encode() if isinstance(key, str) else key)

    return _fernet_instance


def encrypt(value: str) -> str:
    """Encrypt a plaintext string and return a base64-encoded ciphertext string."""
    return get_fernet().encrypt(value.encode()).decode()


def decrypt(value: str) -> str:
    """Decrypt a base64-encoded ciphertext string and return the plaintext."""
    return get_fernet().decrypt(value.encode()).decode()
