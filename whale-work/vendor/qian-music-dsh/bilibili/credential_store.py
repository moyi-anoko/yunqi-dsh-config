"""Local OS-encrypted credentials. Never expose credentials over JSON-lines."""
import ctypes
import hashlib
import json
import os
from ctypes import wintypes

class Blob(ctypes.Structure):
    _fields_ = [('size', wintypes.DWORD), ('data', ctypes.POINTER(ctypes.c_ubyte))]

def _windows(data, decrypt=False):
    buffer = ctypes.create_string_buffer(data)
    source = Blob(len(data), ctypes.cast(buffer, ctypes.POINTER(ctypes.c_ubyte)))
    target = Blob()
    if decrypt:
        ok = ctypes.windll.crypt32.CryptUnprotectData(ctypes.byref(source), None, None, None, None, 0, ctypes.byref(target))
    else:
        ok = ctypes.windll.crypt32.CryptProtectData(ctypes.byref(source), 'Qian Bilibili', None, None, None, 0, ctypes.byref(target))
    if not ok: raise ctypes.WinError()
    try: return ctypes.string_at(target.data, target.size)
    finally: ctypes.windll.kernel32.LocalFree(target.data)

def _service(root):
    return 'qian-bilibili-' + hashlib.sha256(str(root.resolve()).encode()).hexdigest()[:20]

def _keyring():
    import keyring
    backend = keyring.get_keyring()
    candidates = getattr(backend, 'backends', [backend])
    secure = next((b for b in candidates if b.__class__.__module__.startswith(('keyring.backends.SecretService', 'keyring.backends.kwallet', 'keyring.backends.macOS', 'keyring.backends.Windows')) and b.priority > 0), None)
    if secure is None: raise RuntimeError('No secure OS keyring available; plaintext storage is disabled')
    return secure

def save_credentials(root, value):
    text = json.dumps(value)
    if os.name == 'nt':
        target = root / 'credential.dpapi'
        temporary = root / 'credential.dpapi.tmp'
        temporary.write_bytes(_windows(text.encode('utf-8')))
        temporary.replace(target)
    else:
        _keyring().set_password(_service(root), 'session', text)

def load_credentials(root):
    if os.name == 'nt':
        path = root / 'credential.dpapi'
        return json.loads(_windows(path.read_bytes(), True)) if path.exists() else None
    value = _keyring().get_password(_service(root), 'session')
    return json.loads(value) if value else None

def delete_credentials(root):
    if os.name == 'nt': (root / 'credential.dpapi').unlink(missing_ok=True)
    else:
        import keyring
        try: _keyring().delete_password(_service(root), 'session')
        except keyring.errors.PasswordDeleteError: pass
