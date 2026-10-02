"""AURIGE - Validateurs d'entrées (sûreté shell / git)."""
import re

_GIT_REF = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._/-]*$")
# Nom de sauvegarde attendu : data-backup-<...>.tar.gz (créé par create_backup).
_BACKUP_NAME = re.compile(r"^data-backup-[A-Za-z0-9._-]+\.tar\.gz$")


def valid_git_ref(ref) -> bool:
    if not isinstance(ref, str):
        return False
    if not (1 <= len(ref) <= 200):
        return False
    if ".." in ref or "//" in ref:
        return False
    return bool(_GIT_REF.fullmatch(ref))


def valid_backup_filename(name) -> bool:
    """Nom de fichier de sauvegarde sûr : pas de traversée de chemin, motif strict."""
    if not isinstance(name, str):
        return False
    if not (1 <= len(name) <= 200):
        return False
    if "/" in name or "\\" in name or ".." in name:
        return False
    return bool(_BACKUP_NAME.fullmatch(name))


_DBC_ID = re.compile(r"^[a-z0-9-]{1,64}$")


def valid_dbc_id(s) -> bool:
    """Identifiant de DBC bibliothèque : slug sûr, pas de traversée de chemin."""
    if not isinstance(s, str):
        return False
    if "/" in s or "\\" in s or ".." in s:
        return False
    return bool(_DBC_ID.fullmatch(s))
